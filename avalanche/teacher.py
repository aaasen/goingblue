"""
The teacher: Qwen3 0.6B Base fine-tuned on the avalanche corpus. Its samples (synth.py) are the
extra training text for the model that ships. Scored like rwkv.py (-log2 p over section text and
an end token per section), and bits per doc do not depend on the tokenizer, so the numbers compare
directly. The center, section kind and structured context go in as plain-text headers that are
not scored, and formatting marks as tags.

The run stops partway through its schedule (--stop), where held-out loss was lowest.

  python teacher.py train --name teacher --all
  python teacher.py eval --name teacher
"""
import argparse, json, math, os, random, shutil, time
import numpy as np
import torch
import torch.nn.functional as F
from marks import to_tags
from rwkv import DATA, load_docs, report, save_atomic, utf16_len

MODEL = "Qwen/Qwen3-0.6B-Base"
MAX_TRAIN = 2048


def header(d):
    return f"Avalanche forecast. Center: {d['center']}. " + " ".join(d["ctx"])


def section_header(s):
    extra = [str(s.get("context"))] + s["ctx"] if s["kind"] == "problem" else []
    return f"\n\n[{' '.join([s['kind']] + extra)}]\n"


def tokenize():
    """Token ids and score mask per doc, cached next to the corpus."""
    path = f"{DATA}/teacher-tok.npz"
    meta_path = path.replace(".npz", ".json")
    if not os.path.exists(path):
        from transformers import AutoTokenizer
        tk = AutoTokenizer.from_pretrained(MODEL)
        eos = tk.eos_token_id
        docs = load_docs()
        enc = lambda texts: tk(texts, add_special_tokens=False)["input_ids"]
        heads = enc([header(d) for d in docs])
        secs = [enc([section_header(s) for s in d["sections"]] + [to_tags(s["text"]) for s in d["sections"]]) for d in docs]
        toks, masks, meta = [], [], []
        for d, h, e in zip(docs, heads, secs):
            n = len(d["sections"])
            t, m = list(h), [0] * len(h)
            for i in range(n):
                t += e[i]; m += [0] * len(e[i])
                t += e[n + i] + [eos]; m += [1] * (len(e[n + i]) + 1)
            toks.append(np.array(t, dtype=np.int32)); masks.append(np.array(m, dtype=np.uint8))
            meta.append({"id": d["id"], "center": d["center"], "source": d["source"], "split": d["split"],
                         "chars": sum(utf16_len(s["text"]) for s in d["sections"])})
        np.savez(path + ".tmp.npz", lens=np.array([len(t) for t in toks]), toks=np.concatenate(toks), masks=np.concatenate(masks))
        os.replace(path + ".tmp.npz", path)
        with open(meta_path, "w") as f:
            json.dump(meta, f)
        print(f"tokenized {len(docs)} docs, {sum(int(m.sum()) for m in masks):,} scored tokens", flush=True)
    z = np.load(path)
    with open(meta_path) as f:
        meta = json.load(f)
    toks, masks, lens = z["toks"], z["masks"], z["lens"]
    offs = np.concatenate([[0], np.cumsum(lens)])
    return [(toks[offs[i]:offs[i + 1]], masks[offs[i]:offs[i + 1]], m) for i, m in enumerate(meta)]


def batches(docs, max_len, tokens_per_batch, rng):
    """Length-bucketed batches: inputs, targets, target mask, attention mask, docs."""
    docs = sorted(docs, key=lambda d: len(d[0]))
    out, cur = [], []
    for d in docs:
        T = min(len(d[0]) - 1, max_len)
        if cur and (len(cur) + 1) * T > tokens_per_batch:
            out.append(cur); cur = []
        cur.append(d)
    if cur:
        out.append(cur)
    if rng:
        rng.shuffle(out)
    for ds in out:
        T = max(min(len(d[0]) - 1, max_len) for d in ds)
        x = np.zeros((len(ds), T), dtype=np.int64); y = np.zeros_like(x)
        m = np.zeros((len(ds), T), dtype=np.float32); a = np.zeros((len(ds), T), dtype=np.int64)
        for r, (t, mk, _) in enumerate(ds):
            n = min(len(t) - 1, T)
            x[r, :n], y[r, :n], m[r, :n], a[r, :n] = t[:n], t[1:n + 1], mk[1:n + 1], 1
        yield torch.from_numpy(x), torch.from_numpy(y), torch.from_numpy(m), torch.from_numpy(a), ds


def nll_bits(model, x, y, m, a, slice_rows=4096):
    """Per-row summed NLL in nats over masked positions; the head runs only on those positions."""
    h = model.model(input_ids=x, attention_mask=a).last_hidden_state
    sel = m.bool()
    hs, ys = h[sel], y[sel]
    rows = torch.arange(x.shape[0], device=x.device)[:, None].expand_as(sel)[sel]
    per_row = torch.zeros(x.shape[0], device=x.device)
    for i in range(0, hs.shape[0], slice_rows):
        logits = model.lm_head(hs[i:i + slice_rows]).float()
        per_row.index_add_(0, rows[i:i + slice_rows], F.cross_entropy(logits, ys[i:i + slice_rows], reduction="none"))
    return per_row


def doc_bits(model, docs, tokens_per_batch=16384):
    model.eval()
    out = {}
    with torch.no_grad(), torch.autocast("cuda", dtype=torch.bfloat16):
        for x, y, m, a, ds in batches(docs, 1 << 16, tokens_per_batch, None):
            nats = nll_bits(model, x.cuda(), y.cuda(), m.cuda(), a.cuda())
            for (_, _, meta), b in zip(ds, (nats / math.log(2)).tolist()):
                out[meta["id"]] = b
    model.train()
    return out


def load_model():
    from transformers import AutoModelForCausalLM
    return AutoModelForCausalLM.from_pretrained(MODEL, dtype=torch.float32, attn_implementation="sdpa").cuda()


def train(args):
    docs = tokenize()
    # With --all nothing is held out: no scoring, and the weights at the last step are the result.
    tr = docs if args.all else [d for d in docs if d[2]["split"] == "train"]
    va = [] if args.all else [d for d in docs if d[2]["split"] == "val"]
    val_chars = sum(d[2]["chars"] for d in va)
    model = load_model()
    model.gradient_checkpointing_enable()
    model.config.use_cache = False
    params = list(model.parameters())
    print(f"{args.name}: {MODEL}, {sum(p.numel() for p in params) / 1e6:.0f}M params, "
          f"{sum(int(d[1].sum()) for d in tr):,} train tokens", flush=True)
    opt = torch.optim.AdamW(params, lr=args.lr, betas=(0.9, 0.95), weight_decay=0.01)
    order = lambda epoch: random.Random(args.seed * 1000 + epoch)
    steps_per_epoch = sum(1 for _ in batches(tr, MAX_TRAIN, args.batch_tokens, order(0)))
    total_steps = steps_per_epoch * args.epochs
    # The learning rate follows the whole schedule; the run ends at --stop of it.
    last_step = round(args.stop * total_steps)
    ckpt_path = f"{DATA}/{args.name}.ckpt.pt"
    st = {"step": 0, "best": float("inf"), "seen": 0, "elapsed": 0.0}
    if os.path.exists(ckpt_path):
        ck = torch.load(ckpt_path, map_location="cuda")
        model.load_state_dict(ck["model"]); opt.load_state_dict(ck["opt"]); st = ck["st"]
        del ck
        print(f"  resumed at step {st['step']}, best val {st['best']:.4f}", flush=True)
    elif va:
        bpc = sum(doc_bits(model, va).values()) / val_chars
        print(f"  zero-shot val {bpc:.4f} b/c", flush=True)
    t0 = time.time() - st["elapsed"]
    last_ckpt = time.time()

    def save():
        save_atomic({k: v.to(torch.bfloat16) for k, v in model.state_dict().items()}, f"{DATA}/{args.name}.pt")

    def checkpoint():
        st["elapsed"] = time.time() - t0
        # A checkpoint is several GB; the old one goes first when two don't fit.
        if os.path.exists(ckpt_path) and shutil.disk_usage(DATA).free < 1.2 * os.path.getsize(ckpt_path):
            os.remove(ckpt_path)
        save_atomic({"model": model.state_dict(), "opt": opt.state_dict(), "st": st}, ckpt_path)

    step = st["step"]
    micro = args.micro_tokens
    for epoch in range(step // steps_per_epoch, args.epochs):
        skip = step - epoch * steps_per_epoch
        for b, (x, y, m, a, ds) in enumerate(batches(tr, MAX_TRAIN, args.batch_tokens, order(epoch))):
            if b < skip:
                continue
            lr = args.lr * min(1, (step + 1) / 100) * (0.1 + 0.9 * 0.5 * (1 + math.cos(math.pi * step / total_steps)))
            for g in opt.param_groups:
                g["lr"] = lr
            opt.zero_grad(set_to_none=True)
            denom = m.sum().cuda()
            rows = max(1, micro // x.shape[1])
            loss = 0.0
            for i in range(0, x.shape[0], rows):
                with torch.autocast("cuda", dtype=torch.bfloat16):
                    part = nll_bits(model, x[i:i + rows].cuda(), y[i:i + rows].cuda(), m[i:i + rows].cuda(), a[i:i + rows].cuda()).sum() / denom
                part.backward()
                loss += part.item()
            torch.nn.utils.clip_grad_norm_(params, 1.0)
            opt.step()
            step += 1
            st["step"] = step
            st["seen"] += int(m.sum().item())
            if step % 20 == 0:
                print(f"  step {step}/{total_steps} epoch {epoch} loss {loss / math.log(2):.3f} bits/token lr {lr:.2e} "
                      f"{st['seen'] / (time.time() - t0):.0f} tok/s", flush=True)
            if not va:
                if step == last_step:
                    save()
                if time.time() - last_ckpt > args.ckpt_minutes * 60:
                    checkpoint(); last_ckpt = time.time()
            elif step % args.eval_every == 0 or step == last_step:
                bpc = sum(doc_bits(model, va).values()) / val_chars
                mark = ""
                if bpc < st["best"]:
                    st["best"] = bpc
                    save()
                    mark = " (saved)"
                print(f"  val {bpc:.4f} b/c at step {step}, {(time.time() - t0) / 60:.1f} min{mark}", flush=True)
                checkpoint(); last_ckpt = time.time()
            elif time.time() - last_ckpt > args.ckpt_minutes * 60:
                checkpoint(); last_ckpt = time.time()
            if step == last_step:
                break
        if step == last_step:
            break
    if os.path.exists(ckpt_path):
        os.remove(ckpt_path)
    print(f"done: best val {st['best']:.4f} b/c, {(time.time() - t0) / 60:.1f} min", flush=True)


def evaluate(args):
    docs = tokenize()
    model = load_model()
    model.load_state_dict(torch.load(f"{DATA}/{args.name}.pt", map_location="cuda"))
    print(f"{args.name}: {MODEL} fine-tuned")
    report(args.name, docs, doc_bits(model, [d for d in docs if d[2]["split"] == args.split]), args.split)


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("cmd")
    ap.add_argument("--name", default="teacher")
    ap.add_argument("--all", action="store_true", help="learn from every season, with nothing held out")
    ap.add_argument("--epochs", type=int, default=2)
    ap.add_argument("--stop", type=float, default=0.385, help="end the run at this fraction of the schedule")
    ap.add_argument("--lr", type=float, default=5e-5)
    ap.add_argument("--batch-tokens", type=int, default=32768)
    ap.add_argument("--micro-tokens", type=int, default=2048)
    ap.add_argument("--eval-every", type=int, default=250)
    ap.add_argument("--ckpt-minutes", type=float, default=20)
    ap.add_argument("--seed", type=int, default=0)
    ap.add_argument("--split", default="val", help="eval: the season to score")
    args = ap.parse_args()
    {"train": train, "eval": evaluate}[args.cmd](args)
