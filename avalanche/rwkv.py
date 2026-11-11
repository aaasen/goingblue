"""
Float RWKV-4 language model over avalanche forecast prose, scored against the shared PPM on a
held-out season. Ideal code length only: sum of -log2 p over text tokens and section ends. Section
kind, problem type, center and (with --context) the structured fields are given to the model as
marker tokens and cost nothing, as the structured coder already carries them.

  python rwkv.py tokenize --vocab 8000 --tok v2c --context
  python rwkv.py train --vocab 8000 --tok v2c --dim 256 --layers 4 --epochs 5 --name d256
  python rwkv.py eval --name d256 --split val
  python rwkv.py selftest
"""
import argparse, collections, json, math, os, random, sys, time
import numpy as np
import torch
import torch.nn as nn
import torch.nn.functional as F

CODE = os.path.dirname(os.path.abspath(__file__))
# Corpus, tokenizers, checkpoints and results; NEURAL_DATA points elsewhere (the training VM's disk).
DATA = os.environ.get("NEURAL_DATA", os.path.join(CODE, "..", "data", "neural"))
CHUNK = 64
PTYPES = ["stormSlab", "windSlab", "persistentSlab", "deepPersistentSlab", "wetSlab", "wetLoose", "dryLoose", "cornice", "glide", None]


def utf16_len(s):
    return len(s.encode("utf-16-le")) // 2


def load_docs(synth=False):
    import glob
    paths = [f"{DATA}/corpus2.jsonl"] + (sorted(glob.glob(f"{DATA}/synth/k*-c*[0-9].jsonl")) if synth else [])
    docs = []
    for path in paths:
        with open(path) as f:
            docs += [json.loads(l) for l in f]
    return docs


def centers_of(docs):
    return sorted({d["center"] for d in docs})


def markers_of(docs, context):
    """Marker names in id order; marker i is token V + 1 + i."""
    markers = ["kind:" + k for k in sorted({s["kind"] for d in docs for s in d["sections"]})]
    markers += ["ptype:" + str(p) for p in PTYPES] + ["center:" + c for c in centers_of(docs)]
    if context:
        markers += sorted({c for d in docs for c in d["ctx"] + [c for s in d["sections"] for c in s["ctx"]]})
    return markers


# ---------------------------------------------------------------- tokenizer

def tokenize(args):
    """Writes tok<vocab><tok>.npz/.json. With --context, each doc starts with its structured
    context markers and each problem section with its own; all markers are free."""
    import sentencepiece as spm
    docs = load_docs(args.synth)
    prefix = f"{DATA}/sp{args.vocab}{args.sp}"
    if not os.path.exists(prefix + ".model"):
        texts = [s["text"] for d in docs if d["split"] == "train" for s in d["sections"]]
        random.Random(0).shuffle(texts)
        spm.SentencePieceTrainer.train(
            sentence_iterator=iter(texts), model_prefix=prefix, model_type="bpe", vocab_size=args.vocab,
            character_coverage=0.9995, byte_fallback=True, normalization_rule_name="identity",
            add_dummy_prefix=False, remove_extra_whitespaces=False, allow_whitespace_only_pieces=True,
            max_sentence_length=200000, input_sentence_size=2000000, shuffle_input_sentence=True,
            num_threads=8, unk_id=0, bos_id=-1, eos_id=-1, pad_id=-1, minloglevel=2,
        )
    sp = spm.SentencePieceProcessor(model_file=prefix + ".model")
    V = sp.get_piece_size()
    END = V
    markers = markers_of(docs, args.context)
    mid = {k: V + 1 + i for i, k in enumerate(markers)}
    total = V + 1 + len(markers)

    bad = unk = 0
    toks, masks, meta = [], [], []
    for d in docs:
        texts = [s["text"] for s in d["sections"]]
        enc = sp.encode(texts)
        bad += sum(sp.decode(e) != t for e, t in zip(enc, texts))
        unk += sum(e.count(0) for e in enc)
        i = 0
        t = [mid["center:" + d["center"]]] + ([mid[c] for c in d["ctx"]] if args.context else [])
        m = [0] * len(t)
        for s in d["sections"]:
            t.append(mid["kind:" + s["kind"]]); m.append(0)
            if s["kind"] == "problem":
                t.append(mid["ptype:" + str(s.get("context"))]); m.append(0)
                if args.context:
                    t += [mid[c] for c in s["ctx"]]; m += [0] * len(s["ctx"])
            t += enc[i]; m += [1] * len(enc[i])
            t.append(END); m.append(1)
            i += 1
        toks.append(np.array(t, dtype=np.int32))
        masks.append(np.array(m, dtype=np.uint8))
        meta.append({"id": d["id"], "center": d["center"], "source": d.get("source", "nac"), "split": d["split"],
                     "chars": sum(utf16_len(s["text"]) for s in d["sections"]),
                     "ppm": sum(d["ppmBits"]) if d["ppmBits"] else None,
                     "own": sum(d["ownBits"]) if d.get("ownBits") else None})
    np.savez(f"{DATA}/tok{args.vocab}{args.tok}.npz", lens=np.array([len(t) for t in toks]), toks=np.concatenate(toks), masks=np.concatenate(masks))
    with open(f"{DATA}/tok{args.vocab}{args.tok}.json", "w") as f:
        json.dump({"vocab": total, "markers": markers, "meta": meta}, f)
    chars = sum(m["chars"] for m in meta)
    text_tokens = sum(int(m.sum()) for m in masks)
    print(f"vocab {V} + {total - V} markers; {len(docs)} docs, {text_tokens:,} scored tokens, {chars / text_tokens:.2f} chars per token; "
          f"round-trip failures {bad}, unk tokens {unk}")


def load_tokens(vocab, tok):
    z = np.load(f"{DATA}/tok{vocab}{tok}.npz")
    with open(f"{DATA}/tok{vocab}{tok}.json") as f:
        j = json.load(f)
    toks, masks, lens = z["toks"], z["masks"], z["lens"]
    offs = np.concatenate([[0], np.cumsum(lens)])
    docs = [(toks[offs[i]:offs[i + 1]], masks[offs[i]:offs[i + 1]], m) for i, m in enumerate(j["meta"])]
    return j["vocab"], docs


# ---------------------------------------------------------------- model

def wkv_chunked(w, u, k, v):
    """RWKV-4 WKV in parallel over chunks. w > 0 is the per-step decay rate, u the bonus for the
    current token. k, v: (B, T, C) with T a multiple of CHUNK."""
    with torch.autocast(k.device.type, enabled=False):
        return _wkv_chunked(w.float(), u.float(), k.float(), v.float())


def _wkv_chunked(w, u, k, v):
    B, T, C = k.shape
    L, n = CHUNK, T // CHUNK
    k = k.clamp(-30, 30)
    ek = torch.exp(k).view(B, n, L, C)
    ekv = ek * v.view(B, n, L, C)
    idx = torch.arange(L, device=k.device, dtype=k.dtype)
    dist = (idx[:, None] - 1 - idx[None, :])
    mask = (dist >= 0).to(k.dtype)
    M = torch.exp(-dist.clamp(min=0)[..., None] * w) * mask[..., None]           # (L, L, C)
    num = torch.einsum("tsc,bnsc->bntc", M, ekv)
    den = torch.einsum("tsc,bnsc->bntc", M, ek)
    dec_end = torch.exp(-(L - 1 - idx)[:, None] * w)                              # (L, C)
    s_num = torch.einsum("sc,bnsc->bnc", dec_end, ekv)
    s_den = torch.einsum("sc,bnsc->bnc", dec_end, ek)
    step = torch.exp(-L * w)
    a_num, a_den = torch.zeros(B, C, device=k.device), torch.zeros(B, C, device=k.device)
    carry_num, carry_den = [], []
    for j in range(n):
        carry_num.append(a_num); carry_den.append(a_den)
        a_num = step * a_num + s_num[:, j]
        a_den = step * a_den + s_den[:, j]
    carry_num = torch.stack(carry_num, 1)[:, :, None, :]
    carry_den = torch.stack(carry_den, 1)[:, :, None, :]
    dec_t = torch.exp(-idx[:, None] * w)                                          # (L, C)
    cur = torch.exp(u + k).view(B, n, L, C)
    num = num + dec_t * carry_num + cur * v.view(B, n, L, C)
    den = den + dec_t * carry_den + cur
    return (num / den).view(B, T, C)


def wkv_naive(w, u, k, v):
    B, T, C = k.shape
    out = torch.zeros_like(k)
    a, b = torch.zeros(B, C), torch.zeros(B, C)
    for t in range(T):
        e = torch.exp(u + k[:, t])
        out[:, t] = (a + e * v[:, t]) / (b + e)
        a = torch.exp(-w) * a + torch.exp(k[:, t]) * v[:, t]
        b = torch.exp(-w) * b + torch.exp(k[:, t])
    return out


def shift(x):
    return F.pad(x, (0, 0, 1, -1))


class Block(nn.Module):
    def __init__(self, C, F_, i, n, dropout=0.0):
        super().__init__()
        self.drop = nn.Dropout(dropout)
        self.ln1, self.ln2 = nn.LayerNorm(C), nn.LayerNorm(C)
        r0 = 1 - i / n
        ramp = torch.arange(C) / C
        self.tm_k = nn.Parameter(ramp ** r0)
        self.tm_v = nn.Parameter(ramp ** r0 + 0.3 * (i / max(n - 1, 1)))
        self.tm_r = nn.Parameter(ramp ** (0.5 * r0))
        h = torch.arange(C) / max(C - 1, 1)
        self.time_decay = nn.Parameter(-5 + 8 * h ** (0.7 + 1.3 * (i / max(n - 1, 1))))
        self.time_first = nn.Parameter(torch.full((C,), math.log(0.3)) + 0.5 * ((torch.arange(C) + 1) % 3 - 1))
        self.key, self.value, self.recept, self.out = (nn.Linear(C, C, bias=False) for _ in range(4))
        nn.init.zeros_(self.out.weight)
        self.cm_k, self.cm_r = nn.Parameter(ramp ** r0), nn.Parameter(ramp ** r0)
        self.ck, self.cv, self.cr = nn.Linear(C, F_, bias=False), nn.Linear(F_, C, bias=False), nn.Linear(C, C, bias=False)
        nn.init.zeros_(self.cv.weight)

    def forward(self, x, wkv):
        h = self.ln1(x)
        p = shift(h)
        k = self.key(h * self.tm_k + p * (1 - self.tm_k))
        v = self.value(h * self.tm_v + p * (1 - self.tm_v))
        r = torch.sigmoid(self.recept(h * self.tm_r + p * (1 - self.tm_r)))
        x = x + self.drop(self.out(r * wkv(torch.exp(self.time_decay), self.time_first, k, v)))
        h = self.ln2(x)
        p = shift(h)
        k = torch.square(torch.relu(self.ck(h * self.cm_k + p * (1 - self.cm_k))))
        r = torch.sigmoid(self.cr(h * self.cm_r + p * (1 - self.cm_r)))
        return x + self.drop(r * self.cv(k))


class RWKV(nn.Module):
    def __init__(self, vocab, C, layers, ffn, dropout=0.0):
        super().__init__()
        self.emb = nn.Embedding(vocab, C)
        nn.init.uniform_(self.emb.weight, -1e-4, 1e-4)
        self.ln0, self.ln_out = nn.LayerNorm(C), nn.LayerNorm(C)
        self.blocks = nn.ModuleList(Block(C, ffn, i, layers, dropout) for i in range(layers))
        self.head = nn.Linear(C, vocab, bias=False)
        nn.init.normal_(self.head.weight, std=0.5 / math.sqrt(C))

    def forward(self, idx, wkv=wkv_chunked):
        x = self.ln0(self.emb(idx))
        for b in self.blocks:
            x = b(x, wkv)
        return self.head(self.ln_out(x))


def selftest(_args):
    torch.manual_seed(0)
    B, T, C = 2, 3 * CHUNK, 8
    w = torch.rand(C) * 2
    u = torch.randn(C)
    k, v = torch.randn(B, T, C) * 3, torch.randn(B, T, C)
    a, b = wkv_chunked(w, u, k, v), wkv_naive(w, u, k, v)
    print("max abs diff chunked vs naive:", (a - b).abs().max().item())
    m = RWKV(100, 16, 2, 64)
    for p in m.parameters():
        p.data += torch.randn_like(p) * 0.1
    x = torch.randint(0, 100, (2, 2 * CHUNK))
    print("model chunked vs naive:", (m(x) - m(x, wkv_naive)).abs().max().item())


# ---------------------------------------------------------------- data

def batches(docs, max_len, tokens_per_batch, shuffle, rng):
    """Docs grouped by padded length; inputs, targets, target mask, all (B, T)."""
    by = collections.defaultdict(list)
    for d in docs:
        n = min(len(d[0]) - 1, max_len)
        by[-(-n // CHUNK) * CHUNK].append(d)
    out = []
    for T, ds in by.items():
        if shuffle:
            rng.shuffle(ds)
        bs = max(1, tokens_per_batch // T)
        for i in range(0, len(ds), bs):
            out.append((T, ds[i:i + bs]))
    if shuffle:
        rng.shuffle(out)
    for T, ds in out:
        x = np.zeros((len(ds), T), dtype=np.int64)
        y = np.zeros((len(ds), T), dtype=np.int64)
        m = np.zeros((len(ds), T), dtype=np.float32)
        for r, (t, mk, _) in enumerate(ds):
            n = min(len(t) - 1, T)
            x[r, :n], y[r, :n], m[r, :n] = t[:n], t[1:n + 1], mk[1:n + 1]
        yield torch.from_numpy(x), torch.from_numpy(y), torch.from_numpy(m), ds


def device_of():
    if torch.cuda.is_available():
        return "cuda"
    return "mps" if torch.backends.mps.is_available() else "cpu"


def autocast(device):
    return torch.autocast("cuda", dtype=torch.bfloat16, enabled=device == "cuda")


def doc_bits(model, docs, device, max_len=1 << 16, tokens_per_batch=32768):
    """Bits per doc over scored tokens, keyed by id."""
    model.eval()
    out = {}
    with torch.no_grad():
        for x, y, m, ds in batches(docs, max_len, tokens_per_batch, False, None):
            with autocast(device):
                logits = model(x.to(device))
            logits = logits.float()
            nll = F.cross_entropy(logits.transpose(1, 2), y.to(device), reduction="none") * m.to(device)
            bits = (nll.sum(1) / math.log(2)).cpu().numpy()
            for (t, mk, meta), b in zip(ds, bits):
                out[meta["id"]] = float(b)
    model.train()
    return out


# ---------------------------------------------------------------- train / eval

def build(args, vocab):
    return RWKV(vocab, args.dim, args.layers, args.ffn or 4 * args.dim, getattr(args, "dropout", 0.0))


def count(model):
    total = sum(p.numel() for p in model.parameters())
    emb = model.emb.weight.numel() + model.head.weight.numel()
    return total, emb


def save_atomic(obj, path):
    torch.save(obj, path + ".tmp")
    os.replace(path + ".tmp", path)


def train(args):
    """Resumable: state goes to <name>.ckpt.pt every --ckpt-minutes, and a rerun with the same name
    continues from it. Each epoch's batch order comes from (seed, epoch), so resuming skips the
    batches already done."""
    device = device_of()
    vocab, docs = load_tokens(args.vocab, args.tok)
    tr = [d for d in docs if d[2]["split"] in ("train", "synth")]
    va = [d for d in docs if d[2]["split"] == "val"]
    torch.manual_seed(args.seed)
    model = build(args, vocab).to(device)
    total, emb = count(model)
    print(f"{args.name} on {device}: {total / 1e6:.2f}M params ({emb / 1e6:.2f}M embedding + head), {total * 2 / 1e6:.1f} MB at fp16", flush=True)
    decay = [p for n, p in model.named_parameters() if p.dim() == 2]
    other = [p for n, p in model.named_parameters() if p.dim() != 2]
    opt = torch.optim.AdamW([{"params": decay, "weight_decay": 0.01}, {"params": other, "weight_decay": 0}], lr=args.lr, betas=(0.9, 0.99))
    order = lambda epoch: random.Random(args.seed * 1000 + epoch)
    steps_per_epoch = sum(1 for _ in batches(tr, args.max_len, args.batch_tokens, True, order(0)))
    total_steps = steps_per_epoch * args.epochs
    val_chars = sum(d[2]["chars"] for d in va)

    ckpt_path = f"{DATA}/{args.name}.ckpt.pt"
    st = {"step": 0, "best": float("inf"), "seen": 0, "elapsed": 0.0}
    if os.path.exists(ckpt_path):
        ck = torch.load(ckpt_path, map_location=device)
        model.load_state_dict(ck["model"])
        opt.load_state_dict(ck["opt"])
        st = ck["st"]
        print(f"  resumed at step {st['step']}, best val {st['best']:.4f}", flush=True)
    t0 = time.time() - st["elapsed"]
    last_ckpt = time.time()

    def checkpoint():
        st["elapsed"] = time.time() - t0
        save_atomic({"model": model.state_dict(), "opt": opt.state_dict(), "st": st}, ckpt_path)

    step = st["step"]
    for epoch in range(step // steps_per_epoch, args.epochs):
        skip = step - epoch * steps_per_epoch
        for b, (x, y, m, ds) in enumerate(batches(tr, args.max_len, args.batch_tokens, True, order(epoch))):
            if b < skip:
                continue
            lr = args.lr * min(1, (step + 1) / 300) * (0.1 + 0.9 * 0.5 * (1 + math.cos(math.pi * step / total_steps)))
            for g in opt.param_groups:
                g["lr"] = lr
            x, y, m = x.to(device), y.to(device), m.to(device)
            opt.zero_grad(set_to_none=True)
            denom = m.sum()
            loss = 0.0
            # --accum splits the batch's rows into micro-batches with the same summed gradient.
            for xs, ys, ms in zip(x.chunk(args.accum), y.chunk(args.accum), m.chunk(args.accum)):
                with autocast(device):
                    logits = model(xs)
                nll = F.cross_entropy(logits.float().transpose(1, 2), ys, reduction="none")
                part = (nll * ms).sum() / denom
                part.backward()
                loss += part.detach()
                del logits, nll, part
            torch.nn.utils.clip_grad_norm_(model.parameters(), 1.0)
            opt.step()
            step += 1
            st["step"] = step
            st["seen"] += int(m.sum().item())
            if step % 100 == 0:
                print(f"  step {step}/{total_steps} epoch {epoch} loss {loss.item() / math.log(2):.3f} bits/token lr {lr:.2e} "
                      f"{st['seen'] / (time.time() - t0):.0f} tok/s", flush=True)
            if step % args.eval_every == 0 or step == total_steps:
                bpc = sum(doc_bits(model, va, device).values()) / val_chars
                mark = ""
                if bpc < st["best"]:
                    st["best"] = bpc
                    save_atomic({"args": vars(args), "vocab": vocab, "state": model.state_dict()}, f"{DATA}/{args.name}.pt")
                    mark = " (saved)"
                print(f"  val {bpc:.4f} b/c at step {step}, {(time.time() - t0) / 60:.1f} min{mark}", flush=True)
                checkpoint()
                last_ckpt = time.time()
            elif time.time() - last_ckpt > args.ckpt_minutes * 60:
                checkpoint()
                last_ckpt = time.time()
            if step == args.max_steps:
                checkpoint()
                print(f"stopped at --max-steps {step}", flush=True)
                return
    print(f"done: best val {st['best']:.4f} b/c, {(time.time() - t0) / 60:.1f} min", flush=True)


def evaluate(args):
    device = device_of()
    ck = torch.load(f"{DATA}/{args.name}.pt", map_location=device)
    a = argparse.Namespace(**ck["args"])
    vocab, docs = load_tokens(a.vocab, a.tok)
    model = build(a, vocab).to(device)
    model.load_state_dict(ck["state"])
    total, emb = count(model)
    print(f"{args.name}: {total / 1e6:.2f}M params ({emb / 1e6:.2f}M embedding + head), {total / 1e6:.1f} MB int8, vocab {a.vocab}, tokens {a.tok}")
    report(f"{args.name}", docs, doc_bits(model, [d for d in docs if d[2]["split"] == args.split], device), args.split)


def report(name, docs, bits, split):
    """Per-center table of model bits against the shared PPM, and for Avalanche Canada its own PPM."""
    rows = collections.defaultdict(lambda: [0, 0, 0.0, 0.0, 0.0, 0])
    for t, mk, meta in docs:
        if meta["split"] != split:
            continue
        for key in (meta["center"], meta["source"].upper(), "ALL"):
            r = rows[key]
            r[0] += 1; r[1] += meta["chars"]; r[2] += bits[meta["id"]]; r[3] += meta["ppm"]
            if meta["own"] is not None:
                r[4] += meta["own"]; r[5] += 1
    print(f"{split}: {'center':24} {'docs':>5} {'chars':>6} | {'PPM B':>6} {'b/c':>6} | {'own B':>6} | {'model B':>7} {'b/c':>6} | vs PPM | vs own")
    order = lambda c: (c in ("NAC", "AVCAN", "ALL"), c == "ALL", c)
    for key in sorted(rows, key=order):
        n, ch, nb, pb, ob, on = rows[key]
        own = f"{ob / 8 / n:6.1f}" if on == n else " " * 6
        vs_own = f"{100 * (nb - ob) / ob:+6.1f}%" if on == n else ""
        print(f"{split}: {key:24} {n:5} {ch / n:6.0f} | {pb / 8 / n:6.1f} {pb / ch:6.3f} | {own} | {nb / 8 / n:7.1f} {nb / ch:6.3f} | {100 * (nb - pb) / pb:+6.1f}% | {vs_own}")
    with open(f"{DATA}/{name}.{split}.json", "w") as f:
        json.dump(bits, f)


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("cmd")
    ap.add_argument("--vocab", type=int, default=16000)
    ap.add_argument("--dim", type=int, default=256)
    ap.add_argument("--layers", type=int, default=4)
    ap.add_argument("--ffn", type=int, default=0)
    ap.add_argument("--epochs", type=int, default=2)
    ap.add_argument("--lr", type=float, default=1e-3)
    ap.add_argument("--max-len", type=int, default=2048)
    ap.add_argument("--batch-tokens", type=int, default=32768)
    ap.add_argument("--eval-every", type=int, default=1000)
    ap.add_argument("--seed", type=int, default=0)
    ap.add_argument("--ckpt-minutes", type=float, default=10)
    ap.add_argument("--max-steps", type=int, default=0)
    ap.add_argument("--dropout", type=float, default=0.0)
    ap.add_argument("--accum", type=int, default=1)
    ap.add_argument("--name", default="run")
    ap.add_argument("--sp", default="v2", help="sentencepiece model suffix")
    ap.add_argument("--tok", default="v2", help="tokenized dataset suffix")
    ap.add_argument("--context", action="store_true")
    ap.add_argument("--synth", action="store_true", help="tokenize: add the synth/ shards as split synth")
    ap.add_argument("--split", default="val")
    args = ap.parse_args()
    {"tokenize": tokenize, "train": train, "eval": evaluate, "selftest": selftest}[args.cmd](args)
