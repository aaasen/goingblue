"""
Pretrained teacher: a Qwen3 base model fine-tuned on the avalanche corpus, scored like rwkv.py
(-log2 p over section text and a scored end token per section). The center, section kind and
structured context go in as plain-text headers that are not scored. Bits per doc are independent
of the tokenizer, so the numbers compare directly with the RWKV runs.

With --lora R the base model stays frozen in bf16 and only rank-R updates to its linear layers
train, which is how models too large to fine-tune whole on the training GPU are compared.

  python teacher.py train --name q06 --model Qwen/Qwen3-0.6B-Base --epochs 2
  python teacher.py train --name q4l --model Qwen/Qwen3-4B-Base --lora 64 --lr 2e-4
  python teacher.py eval --name q06 --split val
  python teacher.py smoke --model Qwen/Qwen3-4B-Base --lora 64     (two steps, peak GPU memory)
"""
import argparse, collections, json, math, os, random, shutil, time
import numpy as np
import torch
import torch.nn.functional as F
from marks import to_tags
from rwkv import DATA, load_docs, report, save_atomic, utf16_len

MAX_TRAIN = 2048


def header(d):
    return f"Avalanche forecast. Center: {d['center']}. " + " ".join(d["ctx"])


def section_header(s):
    extra = [str(s.get("context"))] + s["ctx"] if s["kind"] == "problem" else []
    return f"\n\n[{' '.join([s['kind']] + extra)}]\n"


def tokenize(model_name):
    """Token ids and score mask per doc, cached next to the corpus."""
    path = f"{DATA}/teacher3-{model_name.replace('/', '_')}.npz"
    meta_path = path.replace(".npz", ".json")
    if not os.path.exists(path):
        from transformers import AutoTokenizer
        tk = AutoTokenizer.from_pretrained(model_name)
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


class LoRA(torch.nn.Module):
    """A frozen linear layer plus a trainable low-rank update B(Ax); B starts at zero."""
    def __init__(self, base, r):
        super().__init__()
        self.base = base
        self.A = torch.nn.Parameter(torch.randn(r, base.in_features) / math.sqrt(base.in_features))
        self.B = torch.nn.Parameter(torch.zeros(base.out_features, r))

    def forward(self, x):
        return self.base(x) + F.linear(F.linear(x, self.A.to(x.dtype)), self.B.to(x.dtype))


def add_lora(model, r):
    """Freezes the model and wraps every linear layer of the transformer body (not the head)."""
    for p in model.parameters():
        p.requires_grad_(False)
    for parent in list(model.model.modules()):
        for n, child in list(parent.named_children()):
            if isinstance(child, torch.nn.Linear):
                setattr(parent, n, LoRA(child, r))
    # Gradient checkpointing needs a layer input that requires grad to reach the first layer's update.
    model.get_input_embeddings().register_forward_hook(lambda _m, _i, out: out.requires_grad_(True))


def load_model(name, lora=0):
    from transformers import AutoModelForCausalLM
    dtype = torch.bfloat16 if lora else torch.float32
    model = AutoModelForCausalLM.from_pretrained(name, torch_dtype=dtype, attn_implementation="sdpa")
    if lora:
        add_lora(model, lora)
    return model.cuda()


def trained_state(model, lora):
    """What a run has to save: everything, or with LoRA only the updates."""
    if not lora:
        return model.state_dict()
    return {n: p.detach() for n, p in model.named_parameters() if p.requires_grad}


def run_args(args):
    """Model and LoRA rank of a named run, from the file its training wrote; else the command line."""
    path = f"{DATA}/{args.name}.args.json"
    if os.path.exists(path):
        with open(path) as f:
            a = json.load(f)
        return a["model"], a.get("lora", 0)
    return args.model, args.lora


def train(args):
    docs = tokenize(args.model)
    # With --all nothing is held out: no scoring, and the weights at the last step are the result.
    tr = docs if args.all else [d for d in docs if d[2]["split"] == "train"]
    va = [] if args.all else [d for d in docs if d[2]["split"] == "val"]
    val_chars = sum(d[2]["chars"] for d in va)
    with open(f"{DATA}/{args.name}.args.json", "w") as f:
        json.dump(vars(args), f)
    model = load_model(args.model, args.lora)
    model.gradient_checkpointing_enable()
    model.config.use_cache = False
    params = [p for p in model.parameters() if p.requires_grad]
    n = sum(p.numel() for p in model.parameters())
    print(f"{args.name}: {args.model}, {n / 1e6:.0f}M params ({sum(p.numel() for p in params) / 1e6:.0f}M trained), "
          f"{sum(int(d[1].sum()) for d in tr):,} train tokens", flush=True)
    opt = torch.optim.AdamW(params, lr=args.lr, betas=(0.9, 0.95), weight_decay=0.01)
    order = lambda epoch: random.Random(args.seed * 1000 + epoch)
    steps_per_epoch = sum(1 for _ in batches(tr, MAX_TRAIN, args.batch_tokens, order(0)))
    total_steps = steps_per_epoch * args.epochs
    # --stop ends the run partway through the schedule.
    last_step = round(args.stop * total_steps) if args.stop else total_steps
    ckpt_path = f"{DATA}/{args.name}.ckpt.pt"
    st = {"step": 0, "best": float("inf"), "seen": 0, "elapsed": 0.0}
    if os.path.exists(ckpt_path):
        ck = torch.load(ckpt_path, map_location="cuda")
        model.load_state_dict(ck["model"], strict=not args.lora); opt.load_state_dict(ck["opt"]); st = ck["st"]
        del ck
        print(f"  resumed at step {st['step']}, best val {st['best']:.4f}", flush=True)
    elif va:
        bpc = sum(doc_bits(model, va).values()) / val_chars
        print(f"  zero-shot val {bpc:.4f} b/c", flush=True)
    t0 = time.time() - st["elapsed"]
    last_ckpt = time.time()

    def checkpoint():
        st["elapsed"] = time.time() - t0
        # A full fine-tune's checkpoint is several GB; the old one goes first when two don't fit.
        if os.path.exists(ckpt_path) and shutil.disk_usage(DATA).free < 1.2 * os.path.getsize(ckpt_path):
            os.remove(ckpt_path)
        save_atomic({"model": trained_state(model, args.lora), "opt": opt.state_dict(), "st": st}, ckpt_path)

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
                    save_atomic({k: v.to(torch.bfloat16) for k, v in trained_state(model, args.lora).items()}, f"{DATA}/{args.name}.pt")
                if time.time() - last_ckpt > args.ckpt_minutes * 60:
                    checkpoint(); last_ckpt = time.time()
            elif step % args.eval_every == 0 or step == last_step:
                bpc = sum(doc_bits(model, va).values()) / val_chars
                mark = ""
                if bpc < st["best"]:
                    st["best"] = bpc
                    best = trained_state(model, args.lora)
                    save_atomic(best if args.lora else {k: v.to(torch.bfloat16) for k, v in best.items()}, f"{DATA}/{args.name}.pt")
                    mark = " (saved)"
                print(f"  val {bpc:.4f} b/c at step {step}, {(time.time() - t0) / 60:.1f} min{mark}", flush=True)
                checkpoint(); last_ckpt = time.time()
            elif time.time() - last_ckpt > args.ckpt_minutes * 60:
                checkpoint(); last_ckpt = time.time()
            if step == args.max_steps:
                checkpoint()
                print(f"stopped at --max-steps {step}", flush=True)
                return
            if step == last_step:
                break
        if step == last_step:
            break
    if os.path.exists(ckpt_path):
        os.remove(ckpt_path)
    print(f"done: best val {st['best']:.4f} b/c, {(time.time() - t0) / 60:.1f} min", flush=True)


def evaluate(args):
    name, lora = run_args(args)
    docs = tokenize(name)
    model = load_model(name, lora)
    model.load_state_dict(torch.load(f"{DATA}/{args.name}.pt", map_location="cuda"), strict=not lora)
    print(f"{args.name}: {name} fine-tuned" + (f" (LoRA rank {lora})" if lora else ""))
    report(args.name, docs, doc_bits(model, [d for d in docs if d[2]["split"] == args.split]), args.split)


def smoke(args):
    """Two training steps on the longest forecasts and a scoring pass on a few, with peak GPU memory."""
    docs = tokenize(args.model)
    tr = sorted((d for d in docs if d[2]["split"] == "train"), key=lambda d: -len(d[0]))[:8]
    model = load_model(args.model, args.lora)
    model.gradient_checkpointing_enable()
    model.config.use_cache = False
    params = [p for p in model.parameters() if p.requires_grad]
    opt = torch.optim.AdamW(params, lr=args.lr)
    t0 = time.time()
    for x, y, m, a, _ in batches(tr, MAX_TRAIN, 2 * args.micro_tokens, None):
        rows = max(1, args.micro_tokens // x.shape[1])
        opt.zero_grad(set_to_none=True)
        for i in range(0, x.shape[0], rows):
            with torch.autocast("cuda", dtype=torch.bfloat16):
                part = nll_bits(model, x[i:i + rows].cuda(), y[i:i + rows].cuda(), m[i:i + rows].cuda(), a[i:i + rows].cuda()).sum() / m.sum().cuda()
            part.backward()
        grads = sum(p.grad is not None and bool(p.grad.abs().sum() > 0) for p in params)
        opt.step()
        print(f"  step: {x.numel()} tokens, loss {part.item() / math.log(2):.3f} bits/token, {grads}/{len(params)} tensors with gradient", flush=True)
    seen = sum(len(d[0]) for d in tr)
    print(f"  train {seen / (time.time() - t0):.0f} tok/s")
    va = [d for d in docs if d[2]["split"] == "val"][:64]
    t0 = time.time()
    bits = doc_bits(model, va)
    print(f"  val {sum(bits.values()) / sum(d[2]['chars'] for d in va):.4f} b/c on {len(va)} docs, {sum(len(d[0]) for d in va) / (time.time() - t0):.0f} tok/s")
    print(f"  peak GPU memory {torch.cuda.max_memory_allocated() / 2**30:.1f} GB")


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("cmd")
    ap.add_argument("--name", default="teacher")
    ap.add_argument("--model", default="Qwen/Qwen3-0.6B-Base")
    ap.add_argument("--epochs", type=int, default=2)
    ap.add_argument("--lr", type=float, default=5e-5)
    ap.add_argument("--batch-tokens", type=int, default=32768)
    ap.add_argument("--micro-tokens", type=int, default=4096)
    ap.add_argument("--eval-every", type=int, default=250)
    ap.add_argument("--ckpt-minutes", type=float, default=20)
    ap.add_argument("--max-steps", type=int, default=0)
    ap.add_argument("--seed", type=int, default=0)
    ap.add_argument("--split", default="val")
    ap.add_argument("--all", action="store_true", help="learn from every season, with nothing held out")
    ap.add_argument("--stop", type=float, default=0, help="end the run at this fraction of the schedule")
    ap.add_argument("--lora", type=int, default=0, help="rank of the low-rank updates; 0 trains every weight")
    args = ap.parse_args()
    {"train": train, "eval": evaluate, "smoke": smoke}[args.cmd](args)
