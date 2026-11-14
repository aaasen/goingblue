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

    // out[o] = rshift(sum_i x[i] q[o][i] * mul[o], WMUL + shift[o] + fin - fout)
    fn apply(&self, x: &[i32], fin: u32, fout: u32, out: &mut [i64]) {
        #[cfg(target_arch = "x86_64")]
        if std::arch::is_x86_feature_detected!("avx2") {
            // SAFETY: the CPU has AVX2.
            return unsafe { self.apply_avx2(x, fin, fout, out) };
        }
        self.apply_rows(x, fin, fout, out)
    }

    // The same arithmetic compiled for AVX2, which baseline x86-64 lacks: its 32-bit multiplies
    // are several times slower.
    #[cfg(target_arch = "x86_64")]
    #[target_feature(enable = "avx2")]
    unsafe fn apply_avx2(&self, x: &[i32], fin: u32, fout: u32, out: &mut [i64]) {
        self.apply_rows(x, fin, fout, out)
    }

    #[inline(always)]
    fn apply_rows(&self, x: &[i32], fin: u32, fout: u32, out: &mut [i64]) {
        for o in 0..self.rows {
            let row = &self.q[o * self.cols..(o + 1) * self.cols];
            out[o] = rshift(dot(x, row) * self.mul[o], self.shift_of(o, fin, fout) as u32);
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
    p1: Vec<Vec<i64>>,
    p2: Vec<Vec<i64>>,
    aa: Vec<Vec<i64>>,
    bb: Vec<Vec<i64>>,
    pp: Vec<Vec<i64>>,
    // Scratch.
    h: Vec<i64>,
    m: Vec<i32>,
    k: Vec<i64>,
    v: Vec<i64>,
    r: Vec<i64>,
    y: Vec<i32>,
    o: Vec<i64>,
    kk: Vec<i64>,
    kk16: Vec<i32>,
    logits: Vec<i64>,
    e: Vec<i64>,
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
            p1: vec![vec![0; c]; l],
            p2: vec![vec![0; c]; l],
            aa: vec![vec![0; c]; l],
            bb: vec![vec![0; c]; l],
            pp: vec![vec![PP_MIN; c]; l],
            h: vec![0; c],
            m: vec![0; c],
            k: vec![0; c],
            v: vec![0; c],
            r: vec![0; c],
            y: vec![0; c],
            o: vec![0; c],
            kk: vec![0; self.ffn],
            kk16: vec![0; self.ffn],
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

    fn mix(h: &[i64], p: &[i64], m: &[i64], out: &mut [i32]) {
        for i in 0..h.len() {
            out[i] = rshift(h[i] * m[i] + p[i] * ((1 << FS) - m[i]), FS) as i32;
        }
    }

    /// Feeds one token. With `freqs`, also writes the frequency table for the next symbol (one
    /// entry per codable symbol, summing to 2^SCALE_BITS).
    pub fn step(&self, s: &mut State, tok: usize, freqs: Option<&mut [u32]>) {
        let c = self.c;
        let shift = (WMUL as i64 + self.emb.shift[tok] - FX as i64) as u32;
        for i in 0..c {
            s.x[i] = rshift(self.emb.q[tok * c + i] as i64 * self.emb.mul[tok], shift);
        }
        for (l, b) in self.blocks.iter().enumerate() {
            self.layer_norm(&s.x, &b.ln1, &mut s.h);
            Self::mix(&s.h, &s.p1[l], &b.tm_k, &mut s.m);
            b.key.apply(&s.m, FH, FK, &mut s.k);
            Self::mix(&s.h, &s.p1[l], &b.tm_v, &mut s.m);
            b.value.apply(&s.m, FH, FV, &mut s.v);
            Self::mix(&s.h, &s.p1[l], &b.tm_r, &mut s.m);
            b.recept.apply(&s.m, FH, FH, &mut s.r);
            s.p1[l].copy_from_slice(&s.h);
            let (aa, bb, pp) = (&mut s.aa[l], &mut s.bb[l], &mut s.pp[l]);
            for i in 0..c {
                let kt = s.k[i];
                let vt = sat16(s.v[i]) << AB;
                let ww = b.u[i] + kt;
                let q = pp[i].max(ww);
                let e1 = Self::exp_neg(&self.exp_e, FE, q - pp[i]);
                let e2 = Self::exp_neg(&self.exp_e, FE, q - ww);
                let num = e1 * aa[i] + e2 * vt;
                let den = rshift(e1 * bb[i] + (e2 << FB), FE + AB) << (FE + 2 * AB - FB);
                let wkv = floor_div(2 * num + den, 2 * den);
                s.y[i] = sat16(rshift(self.sigmoid(s.r[i], FH) * wkv, FS)) as i32;
                let ww = pp[i] - b.w[i];
                let q = ww.max(kt);
                let e1 = Self::exp_neg(&self.exp_e, FE, q - ww);
                let e2 = Self::exp_neg(&self.exp_e, FE, q - kt);
                aa[i] = rshift(e1 * aa[i] + e2 * vt, FE);
                bb[i] = rshift(e1 * bb[i] + (e2 << FB), FE);
                pp[i] = q;
            }
            b.out.apply(&s.y, FV, FX, &mut s.o);
            for i in 0..c {
                s.x[i] += s.o[i];
            }
            self.layer_norm(&s.x, &b.ln2, &mut s.h);
            Self::mix(&s.h, &s.p2[l], &b.cm_k, &mut s.m);
            b.ck.apply(&s.m, FH, FH, &mut s.kk);
            for j in 0..self.ffn {
                let a = s.kk[j].max(0);
                s.kk16[j] = sat16(rshift(a * a, 2 * FH - FF)) as i32;
            }
            Self::mix(&s.h, &s.p2[l], &b.cm_r, &mut s.m);
            b.cr.apply(&s.m, FH, FH, &mut s.r);
            b.cv.apply(&s.kk16, FF, FX, &mut s.o);
            for i in 0..c {
                s.x[i] = (s.x[i] + rshift(self.sigmoid(s.r[i], FH) * s.o[i], FS)).clamp(-X_CLAMP, X_CLAMP);
            }
            s.p2[l].copy_from_slice(&s.h);
        }
        let Some(freqs) = freqs else { return };
        self.layer_norm(&s.x, &self.ln_out, &mut s.h);
        for i in 0..c {
            s.m[i] = s.h[i] as i32;
        }
        self.head.apply(&s.m, FH, FL, &mut s.logits);
        self.softmax(s, freqs);
    }

    // f_i = 1 + floor(e_i (2^24 - V) / sum e), the remainder to the first argmax.
    fn softmax(&self, s: &mut State, freqs: &mut [u32]) {
        let v = self.codable;
        let (mut mx, mut am) = (i64::MIN, 0);
        for (i, &l) in s.logits.iter().enumerate() {
            if l > mx {
                mx = l;
                am = i;
            }
        }
        let mut sum = 0i64;
        for i in 0..v {
            s.e[i] = Self::exp_neg(&self.exp_p, FP, (mx - s.logits[i]) << (FK - FL));
            sum += s.e[i];
        }
        let avail = (1i64 << SCALE_BITS) - v as i64;
        let mut tot = 0i64;
        for i in 0..v {
            let f = 1 + floor_div(s.e[i] * avail, sum);
            freqs[i] = f as u32;
            tot += f;
        }
        freqs[am] += ((1i64 << SCALE_BITS) - tot) as u32;
    }
}
