//! Integer RWKV-4: int8 weights with per-row (mul, shift), fixed-point activations, rounding
//! right shifts, and lookup tables for exp and sigmoid. Every value fits in i64, so every
//! platform computes the same bits.

// The arithmetic indexes several parallel arrays at once, which reads best as plain loops.
#![allow(clippy::needless_range_loop)]

use crate::Error;
use crate::file::ModelFile;

// Fixed-point formats (fraction bits). A model file exported with any other constants is
// rejected.
const FX: u32 = 12;
const FH: u32 = 11;
const FK: u32 = 16;
const FV: u32 = 10;
const FE: u32 = 16;
const FP: u32 = 24;
const FS: u32 = 15;
const FF: u32 = 8;
const FL: u32 = 12;
const AB: u32 = 8;
const FB: u32 = 24;
pub const SCALE_BITS: u32 = 24;
const WMUL: u32 = 16;
const SIG_RANGE: i64 = 8;
const PP_MIN: i64 = -(1 << 40);
const EXP_HI_MAX: i64 = 32 << 8;

const FMT: [(&str, i64); 16] = [
    ("FX", FX as i64), ("FH", FH as i64), ("FK", FK as i64), ("FV", FV as i64), ("FE", FE as i64),
    ("FP", FP as i64), ("FS", FS as i64), ("FF", FF as i64), ("FL", FL as i64), ("AB", AB as i64),
    ("FB", FB as i64), ("SCALE_BITS", SCALE_BITS as i64), ("WMUL", WMUL as i64),
    ("SIG_RANGE", SIG_RANGE), ("PP_MIN", PP_MIN), ("EXP_HI_MAX", EXP_HI_MAX),
];

const SIG_N: i64 = 2 * SIG_RANGE * 256;
const I16: i64 = 32767;
const X_CLAMP: i64 = 1 << 20;

// Matmul inputs are summed in i32 over blocks of DOT_BLOCK, so |input| * 127 * DOT_BLOCK must stay
// below 2^31. Loading checks that every input a model can produce is within MAX_INPUT.
const DOT_BLOCK: usize = 64;
const MAX_INPUT: i64 = ((1i64 << 31) - 1) / (127 * DOT_BLOCK as i64);
// The same for inputs that fit in i16, which is nearly all of them: 2^15 * 2^7 * 256 = 2^30.
const DOT16_BLOCK: usize = 256;

#[inline]
fn rshift(x: i64, s: u32) -> i64 {
    if s == 0 { x } else { (x + (1 << (s - 1))) >> s }
}

#[inline]
fn sat16(x: i64) -> i64 {
    x.clamp(-I16, I16)
}

#[inline]
fn floor_div(a: i64, b: i64) -> i64 {
    a.div_euclid(b)
}

fn isqrt(n: i64) -> i64 {
    let mut r = (n as f64).sqrt() as i64;
    while r * r > n {
        r -= 1;
    }
    while (r + 1) * (r + 1) <= n {
        r += 1;
    }
    r
}

struct Lin {
    q: Vec<i8>,
    mul: Vec<i64>,
    shift: Vec<i64>,
    rows: usize,
    cols: usize,
}

impl Lin {
    fn load(f: &ModelFile, name: &str, cols: usize) -> Result<Lin, Error> {
        let q = f.i8s(&format!("{name}.q"))?;
        let mul = f.i32s(&format!("{name}.mul"))?;
        let shift = f.i32s(&format!("{name}.shift"))?;
        let rows = mul.len();
        if shift.len() != rows || q.len() != rows * cols {
            return Err(Error::Model(format!("{name} has the wrong shape")));
        }
        Ok(Lin { q, mul, shift, rows, cols })
    }

    // The total right shift for row o; must be at least 1 for every use.
    fn shift_of(&self, o: usize, fin: u32, fout: u32) -> i64 {
        WMUL as i64 + self.shift[o] + fin as i64 - fout as i64
    }

    fn check(&self, name: &str, fin: u32, fout: u32) -> Result<(), Error> {
        if (0..self.rows).any(|o| self.shift_of(o, fin, fout) < 1 || self.shift_of(o, fin, fout) > 62) {
            return Err(Error::Model(format!("{name} needs a shift outside 1..62")));
        }
        Ok(())
    }

    // For each input x (xs holds `cols` values per input, out `rows` per input):
    // out[o] = rshift(sum_i x[i] q[o][i] * mul[o], WMUL + shift[o] + fin - fout).
    // `narrow` is scratch of at least xs's length.
    fn apply(&self, xs: &[i32], fin: u32, fout: u32, narrow: &mut [i16], out: &mut [i64]) {
        // 16-bit inputs multiply twice as many weights per vector instruction, with the same sums.
        let narrow = &mut narrow[..xs.len()];
        let mut fits = true;
        for (n, &v) in narrow.iter_mut().zip(xs) {
            *n = v as i16;
            fits &= *n as i32 == v;
        }
        if fits {
            return self.apply_many(narrow, fin, fout, out);
        }
        // Rare: an input beyond 16 bits goes through the wide sums on its own.
        let inputs = xs.chunks_exact(self.cols).zip(narrow.chunks_exact(self.cols));
        for ((x, n), out) in inputs.zip(out.chunks_exact_mut(self.rows)) {
            if n.iter().zip(x).all(|(&n, &v)| n as i32 == v) {
                self.apply_many(n, fin, fout, out);
            } else {
                for o in 0..self.rows {
                    let row = &self.q[o * self.cols..(o + 1) * self.cols];
                    out[o] = rshift(dot(x, row) * self.mul[o], self.shift_of(o, fin, fout) as u32);
                }
            }
        }
    }

    // `apply` for inputs that fit in 16 bits. Each weight row is read once for all the inputs.
    fn apply_many(&self, xs: &[i16], fin: u32, fout: u32, out: &mut [i64]) {
        #[cfg(target_arch = "x86_64")]
        if std::arch::is_x86_feature_detected!("avx2") {
            // SAFETY: the CPU has AVX2.
            return unsafe { self.apply_many_avx2(xs, fin, fout, out) };
        }
        self.apply_many_rows(xs, fin, fout, out, dot16)
    }

    // The same sums with AVX2, which baseline x86-64 lacks. Four inputs share each load of the
    // weights.
    #[cfg(target_arch = "x86_64")]
    #[target_feature(enable = "avx2")]
    unsafe fn apply_many_avx2(&self, xs: &[i16], fin: u32, fout: u32, out: &mut [i64]) {
        let (cols, rows) = (self.cols, self.rows);
        let n = xs.len() / cols;
        for o in 0..rows {
            let row = &self.q[o * cols..(o + 1) * cols];
            let (mul, shift) = (self.mul[o], self.shift_of(o, fin, fout) as u32);
            let mut i = 0;
            while i + 4 <= n {
                let x = |j: usize| &xs[(i + j) * cols..(i + j + 1) * cols];
                // SAFETY: this function is compiled for AVX2.
                let d = unsafe { dot16x4_avx2([x(0), x(1), x(2), x(3)], row) };
                for j in 0..4 {
                    out[(i + j) * rows + o] = rshift(d[j] * mul, shift);
                }
                i += 4;
            }
            while i < n {
                // SAFETY: this function is compiled for AVX2.
                let d = unsafe { dot16_avx2(&xs[i * cols..(i + 1) * cols], row) };
                out[i * rows + o] = rshift(d * mul, shift);
                i += 1;
            }
        }
    }

    #[inline(always)]
    fn apply_many_rows(&self, xs: &[i16], fin: u32, fout: u32, out: &mut [i64], dot: impl Fn(&[i16], &[i8]) -> i64) {
        for o in 0..self.rows {
            let row = &self.q[o * self.cols..(o + 1) * self.cols];
            let (mul, shift) = (self.mul[o], self.shift_of(o, fin, fout) as u32);
            for (x, out) in xs.chunks_exact(self.cols).zip(out.chunks_exact_mut(self.rows)) {
                out[o] = rshift(dot(x, row) * mul, shift);
            }
        }
    }
}

#[inline(always)]
fn dot(x: &[i32], q: &[i8]) -> i64 {
    let mut acc = 0i64;
    for (xs, qs) in x.chunks(DOT_BLOCK).zip(q.chunks(DOT_BLOCK)) {
        let mut s = 0i32;
        for (&a, &b) in xs.iter().zip(qs) {
            s += a * b as i32;
        }
        acc += s as i64;
    }
    acc
}

#[inline(always)]
fn dot16(x: &[i16], q: &[i8]) -> i64 {
    let mut acc = 0i64;
    for (xs, qs) in x.chunks(DOT16_BLOCK).zip(q.chunks(DOT16_BLOCK)) {
        let mut s = 0i32;
        for (&a, &b) in xs.iter().zip(qs) {
            s += a as i32 * b as i32;
        }
        acc += s as i64;
    }
    acc
}

// dot16 with 16 products per multiply-add. Each i32 lane takes two products per step, at most
// 2^23, so a block of AVX2_BLOCK elements stays below 2^31 per lane.
#[cfg(target_arch = "x86_64")]
const AVX2_BLOCK: usize = 2048;

#[cfg(target_arch = "x86_64")]
#[target_feature(enable = "avx2")]
unsafe fn dot16_avx2(x: &[i16], q: &[i8]) -> i64 {
    use std::arch::x86_64::*;
    let mut acc = 0i64;
    for (xs, qs) in x.chunks(AVX2_BLOCK).zip(q.chunks(AVX2_BLOCK)) {
        let (xv, xt) = xs.as_chunks::<16>();
        let (qv, qt) = qs.as_chunks::<16>();
        let mut sum = _mm256_setzero_si256();
        for (a, b) in xv.iter().zip(qv) {
            // SAFETY: both pointers cover 16 elements.
            let (a, b) = unsafe { (_mm256_loadu_si256(a.as_ptr().cast()), _mm_loadu_si128(b.as_ptr().cast())) };
            sum = _mm256_add_epi32(sum, _mm256_madd_epi16(a, _mm256_cvtepi8_epi16(b)));
        }
        let mut lanes = [0i32; 8];
        // SAFETY: lanes holds 256 bits.
        unsafe { _mm256_storeu_si256(lanes.as_mut_ptr().cast(), sum) };
        acc += lanes.iter().map(|&l| l as i64).sum::<i64>();
        acc += xt.iter().zip(qt).map(|(&a, &b)| a as i64 * b as i64).sum::<i64>();
    }
    acc
}

// dot16_avx2 of four inputs with the same weights.
#[cfg(target_arch = "x86_64")]
#[target_feature(enable = "avx2")]
unsafe fn dot16x4_avx2(x: [&[i16]; 4], q: &[i8]) -> [i64; 4] {
    use std::arch::x86_64::*;
    let len = q.len();
    assert!(x.iter().all(|x| x.len() == len));
    let mut acc = [_mm256_setzero_si256(); 4];
    let mut at = 0;
    while at < len {
        let end = (at + AVX2_BLOCK).min(len);
        let mut sum = [_mm256_setzero_si256(); 4];
        while at + 16 <= end {
            // SAFETY: at + 16 <= len, the length of q and of every input.
            unsafe {
                let w = _mm256_cvtepi8_epi16(_mm_loadu_si128(q.as_ptr().add(at).cast()));
                for j in 0..4 {
                    sum[j] = _mm256_add_epi32(sum[j], _mm256_madd_epi16(_mm256_loadu_si256(x[j].as_ptr().add(at).cast()), w));
                }
            }
            at += 16;
        }
        // The block's i32 lanes, widened to i64.
        for j in 0..4 {
            acc[j] = _mm256_add_epi64(acc[j], _mm256_cvtepi32_epi64(_mm256_castsi256_si128(sum[j])));
            acc[j] = _mm256_add_epi64(acc[j], _mm256_cvtepi32_epi64(_mm256_extracti128_si256::<1>(sum[j])));
        }
        if end - at < 16 {
            at = end;
        }
    }
    let tail = len - len % 16;
    let mut out = [0i64; 4];
    for j in 0..4 {
        let mut lanes = [0i64; 4];
        // SAFETY: lanes holds 256 bits.
        unsafe { _mm256_storeu_si256(lanes.as_mut_ptr().cast(), acc[j]) };
        out[j] = lanes.iter().sum::<i64>() + x[j][tail..].iter().zip(&q[tail..]).map(|(&a, &b)| a as i64 * b as i64).sum::<i64>();
    }
    out
}

struct Block {
    ln1: (Vec<i64>, Vec<i64>),
    ln2: (Vec<i64>, Vec<i64>),
    tm_k: Vec<i64>,
    tm_v: Vec<i64>,
    tm_r: Vec<i64>,
    cm_k: Vec<i64>,
    cm_r: Vec<i64>,
    w: Vec<i64>,
    u: Vec<i64>,
    key: Lin,
    value: Lin,
    recept: Lin,
    out: Lin,
    ck: Lin,
    cv: Lin,
    cr: Lin,
}

pub(crate) struct Rwkv {
    c: usize,
    ffn: usize,
    /// Symbols the head predicts: the pieces and END.
    pub codable: usize,
    pub vocab: usize,
    emb: Lin,
    head: Lin,
    ln_out: (Vec<i64>, Vec<i64>),
    blocks: Vec<Block>,
    exp_e: (Vec<i64>, Vec<i64>),
    exp_p: (Vec<i64>, Vec<i64>),
    sig: Vec<i64>,
}

/// The recurrent state after the tokens fed so far.
pub(crate) struct State {
    x: Vec<i64>,
    h: Vec<i64>,
    p1: Vec<Vec<i64>>,
    p2: Vec<Vec<i64>>,
    aa: Vec<Vec<i64>>,
    bb: Vec<Vec<i64>>,
    pp: Vec<Vec<i64>>,
    w: Work,
    logits: Vec<i64>,
    e: Vec<i64>,
}

// Scratch for a run of up to `n` consecutive tokens passing through a block.
struct Work {
    m: Vec<i32>,
    k: Vec<i64>,
    v: Vec<i64>,
    r: Vec<i64>,
    y: Vec<i32>,
    o: Vec<i64>,
    kk: Vec<i64>,
    kk16: Vec<i32>,
    narrow: Vec<i16>,
}

impl Work {
    fn new(c: usize, ffn: usize, n: usize) -> Work {
        Work {
            m: vec![0; n * c],
            k: vec![0; n * c],
            v: vec![0; n * c],
            r: vec![0; n * c],
            y: vec![0; n * c],
            o: vec![0; n * c],
            kk: vec![0; n * ffn],
            kk16: vec![0; n * ffn],
            narrow: vec![0; n * c.max(ffn)],
        }
    }
}

// Tokens that go through each matmul together in `Rwkv::code`, so a weight row is read once for
// all of them.
const RUN: usize = 8;

// Splits rows 0..n into one contiguous range per thread and runs `f` on each range with its part
// of `a` (aw values per row) and of `b` (bw per row). The first range runs on the calling thread.
fn par_rows<A: Send, B: Send>(
    threads: usize,
    n: usize,
    (a, aw): (&mut [A], usize),
    (b, bw): (&mut [B], usize),
    f: impl Fn(std::ops::Range<usize>, &mut [A], &mut [B]) + Sync,
) {
    let per = n.div_ceil(threads.max(1)).max(1);
    std::thread::scope(|s| {
        let mut parts = a.chunks_mut(per * aw).zip(b.chunks_mut(per * bw)).enumerate();
        let first = parts.next();
        for (i, (a, b)) in parts {
            let f = &f;
            s.spawn(move || f(i * per..i * per + a.len() / aw, a, b));
        }
        if let Some((_, (a, b))) = first {
            f(0..a.len() / aw, a, b);
        }
    });
}

impl Rwkv {
    pub fn load(f: &ModelFile) -> Result<Rwkv, Error> {
        for (k, v) in FMT {
            if f.header.fmt.get(k) != Some(&v) {
                return Err(Error::Model(format!("{k} is {:?}, this engine computes with {v}", f.header.fmt.get(k))));
            }
        }
        let (c, ffn) = (f.header.dim, f.header.ffn);
        let vec = |name: &str, n: usize| -> Result<Vec<i64>, Error> {
            let v = f.i32s(name)?;
            if v.len() != n {
                return Err(Error::Model(format!("{name} has the wrong shape")));
            }
            Ok(v)
        };
        let ln = |name: &str| -> Result<(Vec<i64>, Vec<i64>), Error> { Ok((vec(&format!("{name}.g"), c)?, vec(&format!("{name}.b"), c)?)) };
        let mut blocks = Vec::new();
        for i in 0..f.header.layers {
            let b = |n: &str| format!("blocks.{i}.{n}");
            let block = Block {
                ln1: ln(&b("ln1"))?,
                ln2: ln(&b("ln2"))?,
                tm_k: vec(&b("tm_k"), c)?,
                tm_v: vec(&b("tm_v"), c)?,
                tm_r: vec(&b("tm_r"), c)?,
                cm_k: vec(&b("cm_k"), c)?,
                cm_r: vec(&b("cm_r"), c)?,
                w: vec(&b("w"), c)?,
                u: vec(&b("u"), c)?,
                key: Lin::load(f, &b("key"), c)?,
                value: Lin::load(f, &b("value"), c)?,
                recept: Lin::load(f, &b("recept"), c)?,
                out: Lin::load(f, &b("out"), c)?,
                ck: Lin::load(f, &b("ck"), c)?,
                cv: Lin::load(f, &b("cv"), ffn)?,
                cr: Lin::load(f, &b("cr"), c)?,
            };
            let rows = [(&block.key, c), (&block.value, c), (&block.recept, c), (&block.out, c), (&block.ck, ffn), (&block.cv, c), (&block.cr, c)];
            if rows.iter().any(|(l, n)| l.rows != *n) {
                return Err(Error::Model(format!("block {i} has the wrong shape")));
            }
            block.key.check(&b("key"), FH, FK)?;
            block.value.check(&b("value"), FH, FV)?;
            block.recept.check(&b("recept"), FH, FH)?;
            block.out.check(&b("out"), FV, FX)?;
            block.ck.check(&b("ck"), FH, FH)?;
            block.cv.check(&b("cv"), FF, FX)?;
            block.cr.check(&b("cr"), FH, FH)?;
            // Mix outputs are the largest matmul inputs; LayerNorm outputs, y and kk are int16.
            for m in [&block.tm_k, &block.tm_v, &block.tm_r, &block.cm_k, &block.cm_r] {
                for &mc in m.iter() {
                    if (I16 * (mc.abs() + ((1 << FS) - mc).abs())) >> FS >= MAX_INPUT {
                        return Err(Error::Model(format!("block {i} mix coefficient {mc} is out of range")));
                    }
                }
            }
            blocks.push(block);
        }
        let emb = Lin::load(f, "emb", c)?;
        let head = Lin::load(f, "head", c)?;
        if emb.rows != f.header.vocab || head.rows != f.header.codable {
            return Err(Error::Model("emb or head has the wrong shape".into()));
        }
        if (0..emb.rows).any(|t| WMUL as i64 + emb.shift[t] - (FX as i64) < 0) {
            return Err(Error::Model("emb needs a negative shift".into()));
        }
        head.check("head", FH, FL)?;
        let table = |name: &str, n: usize| vec(name, n);
        Ok(Rwkv {
            c,
            ffn,
            codable: f.header.codable,
            vocab: f.header.vocab,
            emb,
            head,
            ln_out: ln("ln_out")?,
            blocks,
            exp_e: (table(&format!("exp{FE}.hi"), EXP_HI_MAX as usize)?, table(&format!("exp{FE}.lo"), 256)?),
            exp_p: (table(&format!("exp{FP}.hi"), EXP_HI_MAX as usize)?, table(&format!("exp{FP}.lo"), 256)?),
            sig: table("sigmoid", SIG_N as usize)?,
        })
    }

    pub fn state(&self) -> State {
        let (c, l) = (self.c, self.blocks.len());
        State {
            x: vec![0; c],
            h: vec![0; c],
            p1: vec![vec![0; c]; l],
            p2: vec![vec![0; c]; l],
            aa: vec![vec![0; c]; l],
            bb: vec![vec![0; c]; l],
            pp: vec![vec![PP_MIN; c]; l],
            w: Work::new(c, self.ffn, 1),
            logits: vec![0; self.codable],
            e: vec![0; self.codable],
        }
    }

    // exp(-d / 2^FK) at Q(fe) for d >= 0; 0 beyond the table.
    #[inline]
    fn exp_neg(table: &(Vec<i64>, Vec<i64>), fe: u32, d: i64) -> i64 {
        let h = d >> 8;
        if h >= EXP_HI_MAX {
            return 0;
        }
        rshift(table.0[h as usize] * table.1[(d - (h << 8)) as usize], fe)
    }

    #[inline]
    fn sigmoid(&self, x: i64, fx: u32) -> i64 {
        let i = (rshift(x, fx - 8) + SIG_N / 2).clamp(0, SIG_N - 1);
        self.sig[i as usize]
    }

    fn layer_norm(&self, x: &[i64], (g, b): &(Vec<i64>, Vec<i64>), out: &mut [i64]) {
        let c = self.c as i64;
        let mean = floor_div(x.iter().sum(), c);
        let ss: i64 = x.iter().map(|&v| (v - mean) * (v - mean)).sum();
        let sd = isqrt(floor_div(ss, c)).max(1);
        for i in 0..self.c {
            let nrm = floor_div((x[i] - mean) << FH, sd);
            out[i] = sat16(rshift(nrm * g[i], FS) + b[i]);
        }
    }

    // Mixes each token's row of h with the row of the token before it; `p` is that row for the
    // first token.
    fn mix(h: &[i64], p: &[i64], m: &[i64], out: &mut [i32]) {
        let c = m.len();
        for (t, out) in out[..h.len()].chunks_exact_mut(c).enumerate() {
            let (h, p) = (&h[t * c..(t + 1) * c], if t == 0 { p } else { &h[(t - 1) * c..t * c] });
            for i in 0..c {
                out[i] = rshift(h[i] * m[i] + p[i] * ((1 << FS) - m[i]), FS) as i32;
            }
        }
    }

    fn embed(&self, tok: usize, x: &mut [i64]) {
        let shift = (WMUL as i64 + self.emb.shift[tok] - FX as i64) as u32;
        for i in 0..self.c {
            x[i] = rshift(self.emb.q[tok * self.c + i] as i64 * self.emb.mul[tok], shift);
        }
    }

    // A block's key, value and receptance (in w) for a run of tokens, from their LayerNorm
    // outputs h and the row p of the token before the run.
    fn time_mix(b: &Block, h: &[i64], p: &[i64], w: &mut Work) {
        let n = h.len();
        Self::mix(h, p, &b.tm_k, &mut w.m);
        b.key.apply(&w.m[..n], FH, FK, &mut w.narrow, &mut w.k[..n]);
        Self::mix(h, p, &b.tm_v, &mut w.m);
        b.value.apply(&w.m[..n], FH, FV, &mut w.narrow, &mut w.v[..n]);
        Self::mix(h, p, &b.tm_r, &mut w.m);
        b.recept.apply(&w.m[..n], FH, FH, &mut w.narrow, &mut w.r[..n]);
    }

    // The recurrence over time for one token: y from k, v, r and the state, which it advances.
    fn wkv(&self, b: &Block, (k, v, r): (&[i64], &[i64], &[i64]), (aa, bb, pp): (&mut [i64], &mut [i64], &mut [i64]), y: &mut [i32]) {
        for i in 0..self.c {
            let kt = k[i];
            let vt = sat16(v[i]) << AB;
            let ww = b.u[i] + kt;
            let q = pp[i].max(ww);
            let e1 = Self::exp_neg(&self.exp_e, FE, q - pp[i]);
            let e2 = Self::exp_neg(&self.exp_e, FE, q - ww);
            let num = e1 * aa[i] + e2 * vt;
            let den = rshift(e1 * bb[i] + (e2 << FB), FE + AB) << (FE + 2 * AB - FB);
            let wkv = floor_div(2 * num + den, 2 * den);
            y[i] = sat16(rshift(self.sigmoid(r[i], FH) * wkv, FS)) as i32;
            let ww = pp[i] - b.w[i];
            let q = ww.max(kt);
            let e1 = Self::exp_neg(&self.exp_e, FE, q - ww);
            let e2 = Self::exp_neg(&self.exp_e, FE, q - kt);
            aa[i] = rshift(e1 * aa[i] + e2 * vt, FE);
            bb[i] = rshift(e1 * bb[i] + (e2 << FB), FE);
            pp[i] = q;
        }
    }

    // Adds a block's time-mix output for a run's y to its x.
    fn time_out(b: &Block, y: &[i32], x: &mut [i64], w: &mut Work) {
        let n = x.len();
        b.out.apply(y, FV, FX, &mut w.narrow, &mut w.o[..n]);
        for i in 0..n {
            x[i] += w.o[i];
        }
    }

    // Adds a block's channel mix to a run's x, from the second LayerNorm outputs h and the row p
    // of the token before the run.
    fn channel_mix(&self, b: &Block, h: &[i64], p: &[i64], x: &mut [i64], w: &mut Work) {
        let n = x.len();
        let nf = n / self.c * self.ffn;
        Self::mix(h, p, &b.cm_k, &mut w.m);
        b.ck.apply(&w.m[..n], FH, FH, &mut w.narrow, &mut w.kk[..nf]);
        for j in 0..nf {
            let a = w.kk[j].max(0);
            w.kk16[j] = sat16(rshift(a * a, 2 * FH - FF)) as i32;
        }
        Self::mix(h, p, &b.cm_r, &mut w.m);
        b.cr.apply(&w.m[..n], FH, FH, &mut w.narrow, &mut w.r[..n]);
        b.cv.apply(&w.kk16[..nf], FF, FX, &mut w.narrow, &mut w.o[..n]);
        for i in 0..n {
            x[i] = (x[i] + rshift(self.sigmoid(w.r[i], FH) * w.o[i], FS)).clamp(-X_CLAMP, X_CLAMP);
        }
    }

    /// Feeds one token. With `freqs`, also writes the frequency table for the next symbol (one
    /// entry per codable symbol, summing to 2^SCALE_BITS).
    pub fn step(&self, s: &mut State, tok: usize, freqs: Option<&mut [u32]>) {
        self.embed(tok, &mut s.x);
        for (l, b) in self.blocks.iter().enumerate() {
            self.layer_norm(&s.x, &b.ln1, &mut s.h);
            Self::time_mix(b, &s.h, &s.p1[l], &mut s.w);
            s.p1[l].copy_from_slice(&s.h);
            let Work { k, v, r, y, .. } = &mut s.w;
            self.wkv(b, (k, v, r), (&mut s.aa[l], &mut s.bb[l], &mut s.pp[l]), y);
            let y = std::mem::take(&mut s.w.y);
            Self::time_out(b, &y, &mut s.x, &mut s.w);
            s.w.y = y;
            self.layer_norm(&s.x, &b.ln2, &mut s.h);
            self.channel_mix(b, &s.h, &s.p2[l], &mut s.x, &mut s.w);
            s.p2[l].copy_from_slice(&s.h);
        }
        let Some(freqs) = freqs else { return };
        self.layer_norm(&s.x, &self.ln_out, &mut s.h);
        for i in 0..self.c {
            s.w.m[i] = s.h[i] as i32;
        }
        self.head.apply(&s.w.m, FH, FL, &mut s.w.narrow, &mut s.logits);
        self.softmax(&s.logits, &mut s.e, freqs);
    }

    /// The coder's (start, freq) for each `targets[p]` that is a symbol, under the table after
    /// `tokens[..=p]`: what feeding the tokens to `step` one at a time gives, computed a block at
    /// a time over the whole sequence on `threads` threads.
    pub fn code(&self, tokens: &[usize], targets: &[Option<usize>], threads: usize) -> Vec<(u32, u32)> {
        let (c, n) = (self.c, tokens.len());
        let mut unit = vec![(); n];
        let mut x = vec![0i64; n * c];
        for (t, &tok) in tokens.iter().enumerate() {
            self.embed(tok, &mut x[t * c..(t + 1) * c]);
        }
        let mut h = vec![0i64; n * c];
        let mut kvr = vec![0i64; n * 3 * c];
        let mut y = vec![0i32; n * c];
        let zero = vec![0i64; c];
        fn row(a: &[i64], c: usize, t: usize) -> &[i64] {
            &a[t * c..(t + 1) * c]
        }
        // The previous token's row of h, which for the first token is the initial state.
        fn prev<'a>(h: &'a [i64], zero: &'a [i64], t: usize) -> &'a [i64] {
            if t == 0 { zero } else { row(h, zero.len(), t - 1) }
        }
        for b in &self.blocks {
            par_rows(threads, n, (&mut h, c), (&mut unit, 1), |rows, h, _| {
                for (t, h) in rows.zip(h.chunks_exact_mut(c)) {
                    self.layer_norm(row(&x, c, t), &b.ln1, h);
                }
            });
            par_rows(threads, n, (&mut kvr, 3 * c), (&mut unit, 1), |rows, kvr, _| {
                let mut w = Work::new(c, self.ffn, RUN);
                for (i, kvr) in kvr.chunks_mut(RUN * 3 * c).enumerate() {
                    let (t, len) = (rows.start + i * RUN, kvr.len() / 3);
                    Self::time_mix(b, &h[t * c..t * c + len], prev(&h, &zero, t), &mut w);
                    for (j, kvr) in kvr.chunks_exact_mut(3 * c).enumerate() {
                        kvr[..c].copy_from_slice(&w.k[j * c..(j + 1) * c]);
                        kvr[c..2 * c].copy_from_slice(&w.v[j * c..(j + 1) * c]);
                        kvr[2 * c..].copy_from_slice(&w.r[j * c..(j + 1) * c]);
                    }
                }
            });
            // Each token's state comes from the one before, so this part runs in order.
            let (mut aa, mut bb, mut pp) = (vec![0i64; c], vec![0i64; c], vec![PP_MIN; c]);
            for (kvr, y) in kvr.chunks_exact(3 * c).zip(y.chunks_exact_mut(c)) {
                self.wkv(b, (&kvr[..c], &kvr[c..2 * c], &kvr[2 * c..]), (&mut aa, &mut bb, &mut pp), y);
            }
            par_rows(threads, n, (&mut x, c), (&mut h, c), |rows, x, h| {
                let mut w = Work::new(c, self.ffn, RUN);
                for (i, x) in x.chunks_mut(RUN * c).enumerate() {
                    let t = rows.start + i * RUN;
                    Self::time_out(b, &y[t * c..t * c + x.len()], x, &mut w);
                }
                for (x, h) in x.chunks_exact(c).zip(h.chunks_exact_mut(c)) {
                    self.layer_norm(x, &b.ln2, h);
                }
            });
            par_rows(threads, n, (&mut x, c), (&mut unit, 1), |rows, x, _| {
                let mut w = Work::new(c, self.ffn, RUN);
                for (i, x) in x.chunks_mut(RUN * c).enumerate() {
                    let t = rows.start + i * RUN;
                    self.channel_mix(b, &h[t * c..t * c + x.len()], prev(&h, &zero, t), x, &mut w);
                }
            });
        }
        let points: Vec<(usize, usize)> = targets.iter().enumerate().filter_map(|(p, t)| t.map(|sym| (p, sym))).collect();
        let mut out = vec![(0u32, 0u32); points.len()];
        let mut unit = vec![(); points.len()];
        par_rows(threads, points.len(), (&mut out, 1), (&mut unit, 1), |rows, out, _| {
            let v = self.codable;
            let mut hs = vec![0i64; c];
            let mut xs = vec![0i16; RUN * c];
            let mut logits = vec![0i64; RUN * v];
            let (mut e, mut freqs) = (vec![0i64; v], vec![0u32; v]);
            for (points, out) in points[rows].chunks(RUN).zip(out.chunks_mut(RUN)) {
                for (&(p, _), xs) in points.iter().zip(xs.chunks_exact_mut(c)) {
                    // LayerNorm outputs fit in i16.
                    self.layer_norm(row(&x, c, p), &self.ln_out, &mut hs);
                    for i in 0..c {
                        xs[i] = hs[i] as i16;
                    }
                }
                let k = points.len();
                self.head.apply_many(&xs[..k * c], FH, FL, &mut logits[..k * v]);
                for ((&(_, sym), logits), out) in points.iter().zip(logits.chunks_exact(v)).zip(out) {
                    self.softmax(logits, &mut e, &mut freqs);
                    *out = (freqs[..sym].iter().sum(), freqs[sym]);
                }
            }
        });
        out
    }

    // f_i = 1 + floor(e_i (2^24 - V) / sum e), the remainder to the first argmax.
    fn softmax(&self, logits: &[i64], e: &mut [i64], freqs: &mut [u32]) {
        let v = self.codable;
        let (mut mx, mut am) = (i64::MIN, 0);
        for (i, &l) in logits.iter().enumerate() {
            if l > mx {
                mx = l;
                am = i;
            }
        }
        let mut sum = 0i64;
        for i in 0..v {
            e[i] = Self::exp_neg(&self.exp_p, FP, (mx - logits[i]) << (FK - FL));
            sum += e[i];
        }
        let avail = (1i64 << SCALE_BITS) - v as i64;
        let mut tot = 0i64;
        for i in 0..v {
            let f = 1 + floor_div(e[i] * avail, sum);
            freqs[i] = f as u32;
            tot += f;
        }
        freqs[am] += ((1i64 << SCALE_BITS) - tot) as u32;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    // The narrow kernels compute the same sums as the wide one, at the extremes too.
    #[test]
    fn dot_kernels_agree() {
        let mut seed = 1u64;
        let mut next = move || {
            seed = seed.wrapping_mul(6364136223846793005).wrapping_add(1442695040888963407);
            (seed >> 33) as i64
        };
        for len in [1, 7, 16, 384, 1536, 5000] {
            for case in 0..4 {
                let x: Vec<i16> = (0..len)
                    .map(|_| match case {
                        0 => i16::MAX,
                        1 => i16::MIN,
                        _ => next() as i16,
                    })
                    .collect();
                let q: Vec<i8> = (0..len).map(|_| if case < 2 { 127 } else { (next() % 128) as i8 }).collect();
                let wide: Vec<i32> = x.iter().map(|&v| v as i32).collect();
                let want = dot(&wide, &q);
                assert_eq!(dot16(&x, &q), want);
                #[cfg(target_arch = "x86_64")]
                if std::arch::is_x86_feature_detected!("avx2") {
                    // SAFETY: the CPU has AVX2.
                    assert_eq!(unsafe { dot16_avx2(&x, &q) }, want);
                    // SAFETY: the CPU has AVX2.
                    assert_eq!(unsafe { dot16x4_avx2([&x, &x, &x, &x], &q) }, [want; 4]);
                }
            }
        }
    }
}
