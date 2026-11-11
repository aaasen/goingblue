"""
Float RWKV-7 for the same trainer and scoring as rwkv.py (`rwkv.py train --arch v7 ...`), to compare
against the RWKV-4 student at equal size. Follows the reference x070 model (BlinkDL/RWKV-LM):
matrix-valued state per 64-wide head, low-rank networks for decay, in-context learning rate, value
residual and gate.

Training needs the CUDA kernel in wkv7_cuda.cu (compiled at first use; needs nvcc and ninja), which
stores the state every 16 steps and steps backward between them. Without CUDA a plain loop runs.

  python rwkv7.py selftest      kernel against the loop, values and gradients (CUDA only)
"""
import math, os
import torch
import torch.nn as nn
import torch.nn.functional as F

CODE = os.path.dirname(os.path.abspath(__file__))
HEAD = 64
KERNEL_CHUNK = 16
_kernel = None


def wkv7_loop(r, w, k, v, a, b):
    """Reference recurrence. All (B, T, H, N); w is the log of the decay rate's negative log."""
    B, T, H, N = r.shape
    decay = torch.exp(-torch.exp(w.float()))
    r, k, v, a, b = (t.float() for t in (r, k, v, a, b))
    state = torch.zeros(B, H, N, N, device=r.device)
    out = []
    for t in range(T):
        sa = state @ a[:, t, :, :, None]
        state = state * decay[:, t, :, None, :] + sa @ b[:, t, :, None, :] + v[:, t, :, :, None] @ k[:, t, :, None, :]
        out.append((state @ r[:, t, :, :, None])[..., 0])
    return torch.stack(out, 1)


def kernel():
    global _kernel
    if _kernel is None:
        from torch.utils.cpp_extension import load
        load(name="wind_backstepping", sources=[f"{CODE}/wkv7_cuda.cu", f"{CODE}/wkv7_op.cpp"], is_python_module=False,
             extra_cuda_cflags=["-res-usage", f"-D_C_={HEAD}", f"-D_CHUNK_LEN_={KERNEL_CHUNK}", "--use_fast_math", "-O3", "-Xptxas -O3", "--extra-device-vectorization"])

        class Wkv7(torch.autograd.Function):
            @staticmethod
            def forward(ctx, w, q, k, v, a, b):
                B, T, H, N = w.shape
                assert T % KERNEL_CHUNK == 0
                y = torch.empty_like(v)
                s = torch.empty(B, H, T // KERNEL_CHUNK, N, N, dtype=torch.float32, device=w.device)
                sa = torch.empty(B, T, H, N, dtype=torch.float32, device=w.device)
                torch.ops.wind_backstepping.forward(w, q, k, v, a, b, y, s, sa)
                ctx.save_for_backward(w, q, k, v, a, b, s, sa)
                return y

            @staticmethod
            def backward(ctx, dy):
                w, q, k, v, a, b, s, sa = ctx.saved_tensors
                dw, dq, dk, dv, da, db = (torch.empty_like(x) for x in (w, q, k, v, a, b))
                torch.ops.wind_backstepping.backward(w, q, k, v, a, b, dy.to(torch.bfloat16).contiguous(), s, sa, dw, dq, dk, dv, da, db)
                return dw, dq, dk, dv, da, db

        _kernel = Wkv7
    return _kernel


def wkv7(r, w, k, v, a, b):
    """(B, T, C) each -> (B, T, C) float."""
    B, T, C = r.shape
    r, w, k, v, a, b = (t.view(B, T, C // HEAD, HEAD) for t in (r, w, k, v, a, b))
    if r.is_cuda:
        r, w, k, v, a, b = (t.to(torch.bfloat16).contiguous() for t in (r, w, k, v, a, b))
        return kernel().apply(w, r, k, v, a, b).float().view(B, T, C)
    return wkv7_loop(r, w, k, v, a, b).view(B, T, C)


def shift(x):
    return F.pad(x, (0, 0, 1, -1))


def ortho(rows, cols, scale):
    w = torch.zeros(rows, cols)
    nn.init.orthogonal_(w, gain=scale * (math.sqrt(rows / cols) if rows > cols else 1))
    return w


def lora_dim(C, f):
    return max(32, int(round(f * C ** 0.5 / 32) * 32))


class Tmix(nn.Module):
    def __init__(self, C, i, n):
        super().__init__()
        assert C % HEAD == 0
        self.first = i == 0
        H, N = C // HEAD, HEAD
        r01, r10 = i / max(n - 1, 1), 1 - i / n
        ddd = (torch.arange(C) / C).view(1, 1, C)
        for name, p in (("r", 0.2), ("w", 0.9), ("k", 0.7), ("v", 0.7), ("a", 0.9), ("g", 0.2)):
            setattr(self, "x_" + name, nn.Parameter(1 - ddd ** (p * r10)))
        idx = torch.arange(C)
        linear = idx / (C - 1) - 0.5
        zigzag = ((idx % N) - (N - 1) / 2) / ((N - 1) / 2)
        zigzag = zigzag * zigzag.abs()
        www = -6 + 6 * (idx / (C - 1)) ** (1 + r01 ** 0.3)
        vec = lambda t: nn.Parameter(t.reshape(1, 1, C).clone())
        Dw, Da, Dv, Dg = lora_dim(C, 2.5), lora_dim(C, 2.5), lora_dim(C, 1.7), lora_dim(C, 5)
        self.w0, self.w1, self.w2 = vec(www + 0.5 + zigzag * 2.5), nn.Parameter(torch.zeros(C, Dw)), nn.Parameter(ortho(Dw, C, 0.1))
        self.a0, self.a1, self.a2 = vec(-0.19 + zigzag * 0.3 + linear * 0.4), nn.Parameter(torch.zeros(C, Da)), nn.Parameter(ortho(Da, C, 0.1))
        self.v0, self.v1, self.v2 = vec(0.73 - linear * 0.4), nn.Parameter(torch.zeros(C, Dv)), nn.Parameter(ortho(Dv, C, 0.1))
        self.g1, self.g2 = nn.Parameter(torch.zeros(C, Dg)), nn.Parameter(ortho(Dg, C, 0.1))
        self.k_k, self.k_a = vec(0.71 - linear * 0.1), vec(torch.full((C,), 1.02))
        self.r_k = nn.Parameter(torch.full((H, N), -0.04))
        self.receptance, self.key, self.value, self.output = (nn.Linear(C, C, bias=False) for _ in range(4))
        self.receptance.weight.data = ortho(C, C, 1)
        self.key.weight.data = ortho(C, C, 0.1)
        self.value.weight.data = ortho(C, C, 1)
        nn.init.zeros_(self.output.weight)
        self.ln_x = nn.GroupNorm(H, C, eps=64e-5)
        nn.init.constant_(self.ln_x.weight, ((1 + i) / n) ** 0.7)

    def forward(self, x, v_first):
        B, T, C = x.shape
        H = C // HEAD
        xx = shift(x) - x
        xr, xw, xk, xv, xa, xg = (x + xx * getattr(self, "x_" + n) for n in "rwkvag")
        r = self.receptance(xr)
        w = -F.softplus(-(self.w0 + torch.tanh(xw @ self.w1) @ self.w2).float()) - 0.5
        k = self.key(xk)
        v = self.value(xv)
        if self.first:
            v_first = v
        else:
            v = v + (v_first - v) * torch.sigmoid(self.v0 + (xv @ self.v1) @ self.v2)
        a = torch.sigmoid(self.a0 + (xa @ self.a1) @ self.a2)
        g = torch.sigmoid(xg @ self.g1) @ self.g2
        kk = F.normalize((k * self.k_k).float().view(B, T, H, -1), dim=-1, p=2.0).view(B, T, C)
        k = k * (1 + (a - 1) * self.k_a)
        y = wkv7(r, w, k, v, -kk, kk * a)
        y = self.ln_x(y.view(B * T, C)).view(B, T, C)
        y = y + ((r.view(B, T, H, -1) * k.view(B, T, H, -1) * self.r_k).sum(-1, keepdim=True) * v.view(B, T, H, -1)).view(B, T, C)
        return self.output(y * g), v_first


class Cmix(nn.Module):
    def __init__(self, C, F_, i, n):
        super().__init__()
        ddd = (torch.arange(C) / C).view(1, 1, C)
        self.x_k = nn.Parameter(1 - ddd ** ((1 - i / n) ** 4))
        self.key, self.value = nn.Linear(C, F_, bias=False), nn.Linear(F_, C, bias=False)
        self.key.weight.data = ortho(F_, C, 1)
        nn.init.zeros_(self.value.weight)

    def forward(self, x):
        k = x + (shift(x) - x) * self.x_k
        return self.value(torch.relu(self.key(k)) ** 2)


class Block(nn.Module):
    def __init__(self, C, F_, i, n, dropout):
        super().__init__()
        self.drop = nn.Dropout(dropout)
        self.ln1, self.ln2 = nn.LayerNorm(C), nn.LayerNorm(C)
        self.att, self.ffn = Tmix(C, i, n), Cmix(C, F_, i, n)

    def forward(self, x, v_first):
        y, v_first = self.att(self.ln1(x), v_first)
        x = x + self.drop(y)
        return x + self.drop(self.ffn(self.ln2(x))), v_first


class RWKV7(nn.Module):
    def __init__(self, vocab, C, layers, ffn, dropout=0.0):
        super().__init__()
        self.emb = nn.Embedding(vocab, C)
        nn.init.uniform_(self.emb.weight, -1e-4, 1e-4)
        self.ln0, self.ln_out = nn.LayerNorm(C), nn.LayerNorm(C)
        self.blocks = nn.ModuleList(Block(C, ffn, i, layers, dropout) for i in range(layers))
        self.head = nn.Linear(C, vocab, bias=False)
        nn.init.orthogonal_(self.head.weight, gain=0.5 * math.sqrt(vocab / C) if vocab > C else 0.5)

    def forward(self, idx):
        x = self.ln0(self.emb(idx))
        v_first = None
        for b in self.blocks:
            x, v_first = b(x, v_first)
        return self.head(self.ln_out(x))


def selftest():
    """The kernel takes and returns bf16, so agreement with the float loop is to about 1%."""
    torch.manual_seed(0)
    B, T, H = 2, 4 * KERNEL_CHUNK, 3
    C = H * HEAD
    mk = lambda s=1.0: (torch.randn(B, T, C, device="cuda") * s).requires_grad_()
    r, k, v = mk(), mk(0.3), mk()
    w = (-torch.rand(B, T, C, device="cuda") * 3 - 0.5).requires_grad_()
    kk = F.normalize(torch.randn(B, T, H, HEAD, device="cuda"), dim=-1).view(B, T, C)
    a = (-kk).requires_grad_()
    b = (kk * torch.rand(B, T, C, device="cuda")).requires_grad_()
    ins = (r, w, k, v, a, b)
    probe = torch.randn(B, T, C, device="cuda")
    outs, grads = [], []
    for fn in (wkv7, lambda *t: wkv7_loop(*(x.view(B, T, H, HEAD) for x in t)).view(B, T, C)):
        y = fn(*ins)
        outs.append(y.detach())
        grads.append(torch.autograd.grad((y * probe).sum(), ins))
    rel = lambda x, y: ((x - y).norm() / y.norm()).item()
    print(f"output: relative difference {rel(outs[0], outs[1]):.4f}")
    for n, g0, g1 in zip("rwkvab", *grads):
        print(f"grad {n}: relative difference {rel(g0.float(), g1):.4f}")
    m = RWKV7(100, 2 * HEAD, 2, 4 * 2 * HEAD).cuda()
    x = torch.randint(0, 100, (2, 64), device="cuda")
    with torch.autocast("cuda", dtype=torch.bfloat16):
        loss = F.cross_entropy(m(x).float().transpose(1, 2), x)
    loss.backward()
    missing = [n for n, p in m.named_parameters() if p.grad is None]
    print(f"model: loss {loss.item():.3f} (ln 100 = {math.log(100):.3f}), parameters without gradient: {missing}")


if __name__ == "__main__":
    selftest()
