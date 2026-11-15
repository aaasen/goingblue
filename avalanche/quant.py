"""
Integer inference for a trained rwkv.py model, specified so every platform computes the same bits.

All values are integers. Matmul inputs are int16 at a fixed power-of-two scale per tensor, weights
are int8 with a per-row fixed-point multiplier, and every rescale is a rounding right shift
(floor((x + 2^(s-1)) / 2^s)). exp and sigmoid are lookup tables. Every intermediate stays below
2^53 in magnitude, so JS numbers, int64 and the fp64 matmuls used here all agree exactly.

  python quant.py eval --name a256 [--limit N]    float and integer bits on the validation season
  python quant.py export --name a256              model file + test vectors for native/avalanche
"""
import argparse, hashlib, json, math, time
import numpy as np
import torch
import torch.nn.functional as F
from rwkv import DATA, build, load_tokens, report, device_of, variant

# Fixed-point formats (fraction bits).
FX = 12          # residual stream x (|x| < 40 observed, clamp at 2^20)
FH = 11          # LayerNorm outputs and token-mix inputs to matmuls (int16 headroom: |h| < 16)
FK = 16          # WKV log domain: k, u, w, pp
FV = 10          # v and the WKV output
FE = 16          # WKV exp table output (1.0 = 2^16)
FP = 24          # softmax exp table output
FS = 15          # sigmoid output and mix coefficients
FF = 8           # squared-relu FFN activation
FL = 12          # logits
AB = 8           # extra fraction bits on the WKV numerator state aa
FB = 24          # WKV denominator state bb
SCALE_BITS = 24  # coder frequency total
WMUL = 16        # weight row multiplier bits: w_real = q * mul / 2^(WMUL + shift)
SIG_RANGE = 8    # sigmoid table covers [-8, 8) at 2^-8 steps
PP_MIN = -(1 << 40)
EXP_HI_MAX = 32 << 8   # exp table: exp(-d) for d < 32, two levels (d >> 8 at Q8, d & 255)
I16 = 32767


def rshift(x, s):
    """Rounding arithmetic right shift (ties toward +inf), s >= 0. x: int64 tensor."""
    if s == 0:
        return x
    return (x + (1 << (s - 1))) >> s


def sat16(x):
    return x.clamp(-I16, I16)


def floordiv(a, b):
    return torch.div(a, b, rounding_mode="floor")


# ---------------------------------------------------------------- tables

def exp_tables(fe):
    hi = np.array([round(math.exp(-i / 256) * (1 << fe)) for i in range(EXP_HI_MAX)], dtype=np.int64)
    lo = np.array([round(math.exp(-i / 65536) * (1 << fe)) for i in range(256)], dtype=np.int64)
    return hi, lo


def sigmoid_table():
    n = 2 * SIG_RANGE * 256
    return np.array([round((1 << FS) / (1 + math.exp(-(i - n // 2) / 256))) for i in range(n)], dtype=np.int64)


class Tables:
    def __init__(self, dev):
        self.exp = {fe: [torch.tensor(t, device=dev) for t in exp_tables(fe)] for fe in (FE, FP)}
        self.sig = torch.tensor(sigmoid_table(), device=dev)

    def exp_neg(self, d, fe=FE):
        """exp(-d / 2^FK) at Q(fe) for d >= 0 (Q16); 0 beyond the table."""
        hi, lo = self.exp[fe]
        h = d >> 8
        inr = h < EXP_HI_MAX
        h = torch.where(inr, h, torch.zeros_like(h))
        # d = (h << 8) + l in Q16: exp(-d) = exp(-h/256) * exp(-l/65536)
        r = rshift(hi[h] * lo[d & 255], fe)
        return torch.where(inr, r, torch.zeros_like(r))

    def sigmoid(self, x, fx):
        """sigmoid of x (fx fraction bits) at Q15."""
        i = rshift(x, fx - 8) if fx > 8 else x << (8 - fx)
        n = 2 * SIG_RANGE * 256
        i = (i + n // 2).clamp(0, n - 1)
        return self.sig[i]


# ---------------------------------------------------------------- quantized model

def qrows(w):
    """Signed 8-bit rows with per-row (mul, shift): w ~= q * mul / 2^(WMUL + shift), mul in [2^15, 2^16]."""
    w = w.double()
    lim = 127
    amax = w.abs().amax(1).clamp(min=1e-12)
    s = amax / lim
    q = torch.round(w / s[:, None]).clamp(-lim, lim).long()
    e = torch.floor(torch.log2(s)).long()          # s = m * 2^e, m in [1, 2)
    m = s / torch.pow(2.0, e.double())
    mul = torch.round(m * (1 << (WMUL - 1))).long()  # in [2^15, 2^16]
    shift = -(e + 1)                                  # s = mul / 2^(WMUL - 1) * 2^e = mul / 2^(WMUL + shift)
    return q, mul, shift


def qfix(x, f):
    return torch.round(x.double() * (1 << f)).long()


class IntModel:
    def __init__(self, model, dev, codable):
        sd = {k: v.detach().cpu() for k, v in model.state_dict().items()}
        self.dev = dev
        self.T = Tables(dev)
        self.L = len(model.blocks)
        self.C = sd["emb.weight"].shape[1]
        self.codable = codable
        # ln0 depends only on the token, so the table stores ln0(emb) directly, at FH as int8 rows.
        with torch.no_grad():
            e = F.layer_norm(sd["emb.weight"].float(), (self.C,), sd["ln0.weight"], sd["ln0.bias"]).double()
        self.p = {}
        self.add_rows("emb", e)
        for n in ("ln_out",):
            self.p[n + ".g"] = qfix(sd[n + ".weight"], FS)
            self.p[n + ".b"] = qfix(sd[n + ".bias"], FH)
        self.add_rows("head", sd["head.weight"][:codable])
        for i in range(self.L):
            b = f"blocks.{i}."
            for n in ("ln1", "ln2"):
                self.p[b + n + ".g"] = qfix(sd[b + n + ".weight"], FS)
                self.p[b + n + ".b"] = qfix(sd[b + n + ".bias"], FH)
            for n in ("tm_k", "tm_v", "tm_r", "cm_k", "cm_r"):
                self.p[b + n] = qfix(sd[b + n], FS)
            self.p[b + "w"] = qfix(torch.exp(sd[b + "time_decay"].double()), FK)
            self.p[b + "u"] = qfix(sd[b + "time_first"], FK)
            for n in ("key", "value", "recept", "out", "ck", "cv", "cr"):
                self.add_rows(b + n, sd[b + n + ".weight"])
        self.p = {k: v.to(dev) for k, v in self.p.items()}

    def add_rows(self, n, w):
        q, mul, shift = qrows(w)
        self.p[n + ".q"], self.p[n + ".mul"], self.p[n + ".shift"] = q, mul, shift

    def linear(self, n, x, fin, fout):
        """x: (..., in) int16 at fin -> (..., out) at fout. acc * mul / 2^(WMUL + shift + fin - fout)."""
        q = self.p[n + ".q"]
        acc = torch.matmul(x.double(), q.t().double()).long()
        s = WMUL + self.p[n + ".shift"] + fin - fout
        assert int(s.min()) >= 1, (n, int(s.min()))
        # acc < 2^15 * 2^7 * 2^11 = 2^33, so acc * mul < 2^49.
        return rshift_var(acc * self.p[n + ".mul"], s)

    def layer_norm(self, x, n):
        """x at FX -> int16 at FH."""
        C = x.shape[-1]
        mean = floordiv(x.sum(-1, keepdim=True), torch.tensor(C, device=x.device))
        d = x - mean
        var = floordiv((d * d).sum(-1, keepdim=True), torch.tensor(C, device=x.device))  # Q(2*FX)
        sd = isqrt(var).clamp(min=1)                                                      # Q(FX)
        nrm = floordiv(d << FH, sd)                                                       # Q(FH)
        y = rshift(nrm * self.p[n + ".g"], FS) + self.p[n + ".b"]
        return sat16(y)

    @staticmethod
    def mix(h, p, m):
        return rshift(h * m + p * ((1 << FS) - m), FS)

    def forward(self, idx, wkv_log=None):
        """idx: (B, T) token ids -> logits over the codable symbols at FL, (B, T, codable)."""
        p, T_ = self.p, self.T
        e = p["emb.q"][idx]
        x = rshift_var(e * p["emb.mul"][idx][..., None], (WMUL + p["emb.shift"][idx] - FX)[..., None])
        for i in range(self.L):
            b = f"blocks.{i}."
            h = self.layer_norm(x, b + "ln1")
            pv = F.pad(h, (0, 0, 1, -1))
            k = self.linear(b + "key", self.mix(h, pv, p[b + "tm_k"]), FH, FK)
            v = sat16(self.linear(b + "value", self.mix(h, pv, p[b + "tm_v"]), FH, FV))
            r = T_.sigmoid(self.linear(b + "recept", self.mix(h, pv, p[b + "tm_r"]), FH, FH), FH)
            wkv = self.wkv(p[b + "w"], p[b + "u"], k, v)
            y = sat16(rshift(r * wkv, FS))                                     # FV
            x = x + self.linear(b + "out", y, FV, FX)
            h = self.layer_norm(x, b + "ln2")
            pv = F.pad(h, (0, 0, 1, -1))
            kk = self.linear(b + "ck", self.mix(h, pv, p[b + "cm_k"]), FH, FH).clamp(min=0)
            kk = sat16(rshift(kk * kk, 2 * FH - FF))                            # FF
            rr = T_.sigmoid(self.linear(b + "cr", self.mix(h, pv, p[b + "cm_r"]), FH, FH), FH)
            x = x + rshift(rr * self.linear(b + "cv", kk, FF, FX), FS)
            x = x.clamp(-(1 << 20), 1 << 20)
        h = self.layer_norm(x, "ln_out")
        return self.linear("head", h, FH, FL)

    def wkv(self, w, u, k, v):
        """Log-domain RWKV-4 recurrence. k, w, u at FK; v at FV; output at FV."""
        B, T, C = k.shape
        out = torch.empty_like(v)
        aa = torch.zeros(B, C, dtype=torch.long, device=k.device)
        bb = torch.zeros_like(aa)
        pp = torch.full_like(aa, PP_MIN)
        exp_neg = self.T.exp_neg
        for t in range(T):
            kt, vt = k[:, t], v[:, t]
            ww = u + kt
            q = torch.maximum(pp, ww)
            e1, e2 = exp_neg(q - pp), exp_neg(q - ww)
            num = e1 * aa + e2 * (vt << AB)                     # Q(FV + AB + FE)
            den = rshift(e1 * bb + (e2 << FB), FE + AB)         # Q(FB - AB) >= 2^16
            out[:, t] = rdiv_q(num, den)
            ww = pp - w
            q = torch.maximum(ww, kt)
            e1, e2 = exp_neg(q - ww), exp_neg(q - kt)
            aa = rshift(e1 * aa + e2 * (vt << AB), FE)
            bb = rshift(e1 * bb + (e2 << FB), FE)
            pp = q
        return out


def rdiv_q(num, den):
    """num at Q(FV + AB + FE), den at Q(FB - AB): num / den in units of v (Q(FV))."""
    # num / (den * 2^(FE + 2AB - FB)) at FV: with FE = 16, AB = 8, FB = 24: exponent 8.
    return rdiv(num, den << (FE + 2 * AB - FB))


def rdiv(a, b):
    """Round-half-up division, b > 0: floor((2a + b) / 2b)."""
    return floordiv(2 * a + b, 2 * b)


def rshift_var(x, s):
    """Per-element rounding right shift by s >= 1 (tensor)."""
    return floordiv(x + (1 << (s - 1)), 1 << s) if not torch.is_tensor(s) else floordiv(x + torch.pow(2, s - 1), torch.pow(2, s))


def isqrt(n):
    """floor(sqrt(n)) for int64 n >= 0, exact."""
    r = torch.sqrt(n.double()).long()
    r = torch.where(r * r > n, r - 1, r)
    r = torch.where((r + 1) * (r + 1) <= n, r + 1, r)
    return r


# ---------------------------------------------------------------- coder probabilities

def freqs_from_logits(T_, logits):
    """Integer softmax: f_i = 1 + floor(e_i * (2^24 - V) / sum e), remainder to the argmax.
    e_i = exp((l_i - max) / 2^FL) at Q(FP), from the table. sum e < 2^37, e * 2^24 < 2^48."""
    V = logits.shape[-1]
    m = logits.amax(-1, keepdim=True)
    d = (m - logits) << (FK - FL)
    e = T_.exp_neg(d, FP)
    s = e.sum(-1, keepdim=True)
    f = 1 + floordiv(e * ((1 << SCALE_BITS) - V), s)
    rem = (1 << SCALE_BITS) - f.sum(-1, keepdim=True)
    am = logits.argmax(-1, keepdim=True)          # first index of the max
    f.scatter_add_(-1, am, rem)
    return f


# ---------------------------------------------------------------- runs

def load(name, dev):
    ck = torch.load(f"{DATA}/{name}.pt", map_location="cpu")
    a = argparse.Namespace(**ck["args"])
    vocab, docs = load_tokens(a)
    model = build(a, vocab)
    model.load_state_dict(ck["state"])
    return model.to(dev).eval(), a, vocab, docs


def batches_by_len(docs, tokens):
    docs = sorted(docs, key=lambda d: len(d[0]))
    cur = []
    for d in docs:
        if cur and (len(cur) + 1) * len(d[0]) > tokens:
            yield cur; cur = []
        cur.append(d)
    if cur:
        yield cur


def pad(ds, dev):
    T = max(len(t) for t, _, _ in ds) - 1
    x = np.zeros((len(ds), T), dtype=np.int64); y = np.zeros_like(x); m = np.zeros((len(ds), T), dtype=bool)
    for r, (t, mk, _) in enumerate(ds):
        n = len(t) - 1
        x[r, :n], y[r, :n], m[r, :n] = t[:n], t[1:], mk[1:].astype(bool)
    return torch.from_numpy(x).to(dev), torch.from_numpy(y).to(dev), torch.from_numpy(m).to(dev)


def codable_of(a, docs):
    V = max(int(t[mk.astype(bool)].max()) for t, mk, _ in docs[:2000])
    return V + 1   # pieces + END, all below the markers


def evaluate(args):
    """Code length of the integer model at the coder's precision against the float model."""
    dev = device_of()
    model, a, vocab, docs = load(args.name, dev)
    codable = codable_of(a, docs)
    va = [d for d in docs if d[2]["split"] == "val"]
    if args.limit:
        va = va[:: max(1, len(va) // args.limit)][: args.limit]
    print(f"{args.name}: codable symbols {codable} of {vocab}; {len(va)} val docs", flush=True)
    im = IntModel(model, dev, codable)
    out = {"float": {}, "int": {}}
    t0 = time.time()
    with torch.no_grad():
        for bi, ds in enumerate(batches_by_len(va, args.batch_tokens)):
            x, y, m = pad(ds, dev)
            T = -(-x.shape[1] // 64) * 64
            lg = model(F.pad(x, (0, T - x.shape[1])))[:, : x.shape[1]].double()
            nll = F.cross_entropy(lg.transpose(1, 2), y, reduction="none") / math.log(2)
            f = freqs_from_logits(im.T, im.forward(x))
            bits = SCALE_BITS - torch.log2(f.gather(-1, y.clamp(max=codable - 1)[..., None])[..., 0].double())
            for r, (_, _, meta) in enumerate(ds):
                out["float"][meta["id"]] = float(nll[r][m[r]].sum())
                out["int"][meta["id"]] = float(bits[r][m[r]].sum())
            print(f"  batch {bi} ({len(ds)} docs, T={x.shape[1]}) {time.time() - t0:.0f}s", flush=True)
    chars = sum(d[2]["chars"] for d in va)
    base = sum(out["float"].values())
    for key, b in out.items():
        tot = sum(b.values())
        print(f"{key:6} {tot / chars:.4f} b/c  {tot / 8 / len(va):7.1f} B/doc  {100 * (tot - base) / base:+.2f}% vs float")
    if not args.limit:
        report(f"{args.name}-int", docs, out["int"], "val")


MAGIC = b"GBNM"
FORMAT_VERSION = 1
FMT_KEYS = ("FX", "FH", "FK", "FV", "FE", "FP", "FS", "FF", "FL", "AB", "FB", "SCALE_BITS", "WMUL", "SIG_RANGE", "PP_MIN", "EXP_HI_MAX")


def write_model(path, header, arrays):
    """The integer model as one file, everything a platform needs to tokenize, run and code:

      "GBNM"         magic
      u32 LE         format version
      u32 LE         header length in bytes
      header         UTF-8 JSON (below)
      zero padding   to a multiple of 8
      arrays         each little-endian, 8-byte aligned, offsets relative to here

    Header: name; dim, layers, ffn; vocab (embedding rows) and codable (pieces + END, the head's
    rows); fmt, the fixed-point constants above, which a reader checks against its own; pieces as
    [piece, score, type] (SentencePiece types: 1 normal, 2 unknown, 6 byte); markers, where
    markers[i] is token codable + i; arrays as name -> [dtype, offset, length], dtype i8 or i32.

    A forecast is one token sequence: center marker, document context markers, then per section
    its kind marker (for a problem, then its ptype marker and problem context markers), its text
    pieces and END. Markers are given to both sides; pieces and END are coded."""
    index, blobs, off = {}, [], 0
    for name, (dtype, v) in arrays.items():
        b = v.astype(np.int8 if dtype == "i8" else "<i4").tobytes()
        index[name] = [dtype, off, int(v.size)]
        pad_ = (-len(b)) % 8
        blobs += [b, b"\0" * pad_]
        off += len(b) + pad_
    head = json.dumps({**header, "arrays": index}, ensure_ascii=False, separators=(",", ":")).encode()
    head_pad = (-(12 + len(head))) % 8
    with open(path, "wb") as f:
        f.write(MAGIC + FORMAT_VERSION.to_bytes(4, "little") + len(head).to_bytes(4, "little") + head + b"\0" * head_pad)
        for b in blobs:
            f.write(b)
    return 12 + len(head) + head_pad + off


def export(args):
    """Writes <name>.int.bin (write_model) and <name>.vectors.json, the test vectors: --vectors val
    docs with their tokens, mask (1 = coded) and per-step frequency table hashes."""
    import sentencepiece as spm
    dev = device_of()
    model, a, vocab, docs = load(args.name, dev)
    codable = codable_of(a, docs)
    im = IntModel(model, dev, codable)
    with open(f"{DATA}/tok{variant(a)}.json") as f:
        markers = json.load(f)["markers"]
    assert codable + len(markers) == vocab, (codable, len(markers), vocab)
    sp = spm.SentencePieceProcessor(model_file=f"{DATA}/sp{variant(a)}.model")
    assert sp.get_piece_size() + 1 == codable
    kind = lambda i: 6 if sp.is_byte(i) else 2 if sp.is_unknown(i) else 3 if sp.is_control(i) else 1
    pieces = [[sp.id_to_piece(i), sp.get_score(i), kind(i)] for i in range(sp.get_piece_size())]

    arrays = {}
    for k, v in im.p.items():
        v = v.cpu().numpy()
        if k.endswith(".q"):
            assert v.min() >= -127 and v.max() <= 127, k
            arrays[k] = ("i8", v)
        else:
            assert np.abs(v).max() < 2 ** 31, k
            arrays[k] = ("i32", v)
    for fe in (FE, FP):
        for nm, t in zip(("hi", "lo"), exp_tables(fe)):
            arrays[f"exp{fe}.{nm}"] = ("i32", t)
    arrays["sigmoid"] = ("i32", sigmoid_table())
    header = {"name": args.name, "dim": im.C, "layers": im.L, "ffn": int(im.p["blocks.0.ck.mul"].numel()),
              "vocab": vocab, "codable": codable, "fmt": {k: globals()[k] for k in FMT_KEYS},
              "pieces": pieces, "markers": markers}
    size = write_model(f"{DATA}/{args.name}.int.bin", header, arrays)

    va = [d for d in docs if d[2]["split"] == "val"]
    picks = va[:: len(va) // args.vectors][: args.vectors]
    vec = []
    for ds in batches_by_len(picks, 8192):
        x, _, _ = pad(ds, dev)
        fs = freqs_from_logits(im.T, im.forward(x)).cpu().numpy().astype("<i4")
        for (t, mk, m), f in zip(ds, fs):
            f = f[: len(t) - 1]
            hs = [hashlib.sha256(f[i].tobytes()).hexdigest()[:16] for i in range(len(f))]
            bits = float(sum(SCALE_BITS - math.log2(f[i][t[i + 1]]) for i in range(len(f)) if mk[i + 1]))
            vec.append({"id": m["id"], "tokens": t.tolist(), "mask": mk.tolist(), "hashes": hs, "bits": bits})
    with open(f"{DATA}/{args.name}.vectors.json", "w") as f:
        json.dump({"model": args.name, "vectors": vec}, f)
    print(f"wrote {args.name}.int.bin ({size / 1e6:.1f} MB) and {len(vec)} test vectors")


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("cmd")
    ap.add_argument("--name", default="a256")
    ap.add_argument("--limit", type=int, default=0, help="eval: score about this many forecasts")
    ap.add_argument("--batch-tokens", type=int, default=32768)
    ap.add_argument("--vectors", type=int, default=8, help="export: number of test forecasts")
    args = ap.parse_args()
    {"eval": evaluate, "export": export}[args.cmd](args)
