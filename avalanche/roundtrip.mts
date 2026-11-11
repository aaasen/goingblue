/**
 * TypeScript port of quant.py's integer RWKV plus a 24-bit rANS coder. Checks the port against
 * the Python reference (per-step frequency table hashes), then round-trips each test forecast:
 * section text -> BPE tokens -> bytes -> tokens -> text, with the markers given to both sides.
 *
 * Usage: node roundtrip.mts [data dir, default data/neural] [docs] [rANS L bits]
 *   with <MODEL>.int.bin and <MODEL>.vectors.json from quant.py export, and corpus2.jsonl.
 *   MODEL defaults to s384c; SHARD=i/n runs every nth test vector.
 */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

const DIR = process.argv[2] || new URL("../data/neural", import.meta.url).pathname;
const NDOCS = Number(process.argv[3] ?? 200);
const L_BITS = Number(process.argv[4] ?? 32);
const NAME = process.env.MODEL ?? "s384c";

// The model file layout is in quant.py write_model.
const bin = readFileSync(`${DIR}/${NAME}.int.bin`);
if (bin.toString("latin1", 0, 4) !== "GBNM" || bin.readUInt32LE(4) !== 1) throw new Error("not a version 1 GBNM model");
const headLen = bin.readUInt32LE(8);
const meta = JSON.parse(bin.toString("utf8", 12, 12 + headLen));
const ARRAYS = 12 + headLen + ((8 - ((12 + headLen) % 8)) % 8);
const { vectors } = JSON.parse(readFileSync(`${DIR}/${NAME}.vectors.json`, "utf8"));
const { FX, FH, FK, FV, FE, FP, FS, FF, FL, AB, FB, SCALE_BITS, WMUL, SIG_RANGE, PP_MIN, EXP_HI_MAX } = meta.fmt;
const C: number = meta.dim;
const LAYERS: number = meta.layers;
const V: number = meta.codable;
const END = V - 1;

function tensor(name: string): Int8Array | Int32Array {
  const e = meta.arrays[name];
  if (!e) throw new Error(`missing ${name}`);
  const [dtype, offset, n] = e;
  const start = bin.byteOffset + ARRAYS + offset;
  const ab = bin.buffer.slice(start, start + n * (dtype === "i8" ? 1 : 4));
  return dtype === "i8" ? new Int8Array(ab) : new Int32Array(ab);
}

// ---------------------------------------------------------------- exact integer helpers
// Every value stays below 2^53, so JS numbers are exact; divisions are corrected to exact floors.

function floorDiv(a: number, b: number): number {
  let q = Math.floor(a / b);
  if (q * b > a) q -= 1;
  else if ((q + 1) * b <= a) q += 1;
  return q;
}

const POW2: number[] = Array.from({ length: 64 }, (_, i) => 2 ** i);

function rshift(x: number, s: number): number {
  return s === 0 ? x : Math.floor((x + POW2[s - 1]) / POW2[s]);
}

function sat16(x: number): number {
  return x > 32767 ? 32767 : x < -32767 ? -32767 : x;
}

function isqrt(n: number): number {
  let r = Math.floor(Math.sqrt(n));
  if (r * r > n) r -= 1;
  else if ((r + 1) * (r + 1) <= n) r += 1;
  return r;
}

const EXP: Record<number, [Int32Array, Int32Array]> = {
  [FE]: [tensor(`exp${FE}.hi`) as Int32Array, tensor(`exp${FE}.lo`) as Int32Array],
  [FP]: [tensor(`exp${FP}.hi`) as Int32Array, tensor(`exp${FP}.lo`) as Int32Array],
};
const SIG = tensor("sigmoid") as Int32Array;
const SIG_N = 2 * SIG_RANGE * 256;

function expNeg(d: number, fe: number): number {
  const h = Math.floor(d / 256);
  if (h >= EXP_HI_MAX) return 0;
  const [hi, lo] = EXP[fe];
  return rshift(hi[h] * lo[d - h * 256], fe);
}

function sigmoid(x: number, fx: number): number {
  let i = rshift(x, fx - 8) + SIG_N / 2;
  if (i < 0) i = 0;
  else if (i > SIG_N - 1) i = SIG_N - 1;
  return SIG[i];
}

// ---------------------------------------------------------------- model

interface Lin { q: Int8Array; mul: Int32Array; shift: Int32Array; rows: number; cols: number }

function lin(name: string): Lin {
  const q = tensor(name + ".q") as Int8Array;
  const mul = tensor(name + ".mul") as Int32Array;
  return { q, mul, shift: tensor(name + ".shift") as Int32Array, rows: mul.length, cols: q.length / mul.length };
}

function linear(w: Lin, x: Float64Array, fin: number, fout: number, out: Float64Array): Float64Array {
  const { q, mul, shift, cols } = w;
  for (let o = 0, base = 0; o < w.rows; o++, base += cols) {
    let acc = 0;
    for (let i = 0; i < cols; i++) acc += x[i] * q[base + i];
    out[o] = rshift(acc * mul[o], WMUL + shift[o] + fin - fout);
  }
  return out;
}

const vec = (name: string) => tensor(name) as Int32Array;

const blocks = Array.from({ length: LAYERS }, (_, i) => {
  const b = `blocks.${i}.`;
  return {
    ln1: [vec(b + "ln1.g"), vec(b + "ln1.b")], ln2: [vec(b + "ln2.g"), vec(b + "ln2.b")],
    tm_k: vec(b + "tm_k"), tm_v: vec(b + "tm_v"), tm_r: vec(b + "tm_r"), cm_k: vec(b + "cm_k"), cm_r: vec(b + "cm_r"),
    w: vec(b + "w"), u: vec(b + "u"),
    key: lin(b + "key"), value: lin(b + "value"), recept: lin(b + "recept"), out: lin(b + "out"),
    ck: lin(b + "ck"), cv: lin(b + "cv"), cr: lin(b + "cr"),
  };
});
const EMB = lin("emb");
const HEAD = lin("head");
const LN_OUT = [vec("ln_out.g"), vec("ln_out.b")];
const FFN = blocks[0].ck.rows;

function layerNorm(x: Float64Array, [g, b]: Int32Array[], out: Float64Array): Float64Array {
  let sum = 0;
  for (let c = 0; c < C; c++) sum += x[c];
  const mean = floorDiv(sum, C);
  let ss = 0;
  for (let c = 0; c < C; c++) { const d = x[c] - mean; ss += d * d; }
  const sd = Math.max(1, isqrt(floorDiv(ss, C)));
  for (let c = 0; c < C; c++) {
    const nrm = floorDiv((x[c] - mean) * POW2[FH], sd);
    out[c] = sat16(rshift(nrm * g[c], FS) + b[c]);
  }
  return out;
}

const ONE_S = POW2[FS];
function mix(h: Float64Array, p: Float64Array, m: Int32Array, out: Float64Array): Float64Array {
  for (let c = 0; c < C; c++) out[c] = rshift(h[c] * m[c] + p[c] * (ONE_S - m[c]), FS);
  return out;
}

class State {
  x = new Float64Array(C);
  p1 = Array.from({ length: LAYERS }, () => new Float64Array(C));
  p2 = Array.from({ length: LAYERS }, () => new Float64Array(C));
  aa = Array.from({ length: LAYERS }, () => new Float64Array(C));
  bb = Array.from({ length: LAYERS }, () => new Float64Array(C));
  pp = Array.from({ length: LAYERS }, () => new Float64Array(C).fill(PP_MIN));
}

const t = {
  h: new Float64Array(C), m: new Float64Array(C), k: new Float64Array(C), v: new Float64Array(C), r: new Float64Array(C),
  y: new Float64Array(C), o: new Float64Array(C), kk: new Float64Array(FFN), logits: new Float64Array(V),
};

// Feeds one token; returns the frequency table (sums to 2^SCALE_BITS) for the next symbol.
function step(s: State, tok: number, freqs: Int32Array): Int32Array {
  const x = s.x;
  const e0 = tok * C;
  for (let c = 0; c < C; c++) x[c] = rshift(EMB.q[e0 + c] * EMB.mul[tok], WMUL + EMB.shift[tok] - FX);
  for (let i = 0; i < LAYERS; i++) {
    const B = blocks[i];
    const h = layerNorm(x, B.ln1, new Float64Array(C));
    const k = linear(B.key, mix(h, s.p1[i], B.tm_k, t.m), FH, FK, t.k);
    const v = linear(B.value, mix(h, s.p1[i], B.tm_v, t.m), FH, FV, t.v);
    const r = linear(B.recept, mix(h, s.p1[i], B.tm_r, t.m), FH, FH, t.r);
    s.p1[i] = h;
    const aa = s.aa[i], bb = s.bb[i], pp = s.pp[i];
    for (let c = 0; c < C; c++) {
      const kt = k[c], vt = sat16(v[c]) * POW2[AB];
      let ww = B.u[c] + kt;
      let q = Math.max(pp[c], ww);
      let e1 = expNeg(q - pp[c], FE), e2 = expNeg(q - ww, FE);
      const num = e1 * aa[c] + e2 * vt;
      const den = rshift(e1 * bb[c] + e2 * POW2[FB], FE + AB) * POW2[FE + 2 * AB - FB];
      const wkv = floorDiv(2 * num + den, 2 * den);
      t.y[c] = sat16(rshift(sigmoid(r[c], FH) * wkv, FS));
      ww = pp[c] - B.w[c];
      q = Math.max(ww, kt);
      e1 = expNeg(q - ww, FE); e2 = expNeg(q - kt, FE);
      aa[c] = rshift(e1 * aa[c] + e2 * vt, FE);
      bb[c] = rshift(e1 * bb[c] + e2 * POW2[FB], FE);
      pp[c] = q;
    }
    linear(B.out, t.y, FV, FX, t.o);
    for (let c = 0; c < C; c++) x[c] += t.o[c];
    const h2 = layerNorm(x, B.ln2, new Float64Array(C));
    linear(B.ck, mix(h2, s.p2[i], B.cm_k, t.m), FH, FH, t.kk);
    for (let j = 0; j < FFN; j++) { const a = Math.max(0, t.kk[j]); t.kk[j] = sat16(rshift(a * a, 2 * FH - FF)); }
    linear(B.cr, mix(h2, s.p2[i], B.cm_r, t.m), FH, FH, t.r);
    linear(B.cv, t.kk, FF, FX, t.o);
    for (let c = 0; c < C; c++) {
      x[c] += rshift(sigmoid(t.r[c], FH) * t.o[c], FS);
      if (x[c] > 1 << 20) x[c] = 1 << 20;
      else if (x[c] < -(1 << 20)) x[c] = -(1 << 20);
    }
    s.p2[i] = h2;
  }
  const h = layerNorm(x, LN_OUT, t.h);
  const lg = linear(HEAD, h, FH, FL, t.logits);
  let mx = -Infinity, am = 0;
  for (let i = 0; i < V; i++) if (lg[i] > mx) { mx = lg[i]; am = i; }
  let sum = 0;
  const e = new Float64Array(V);
  for (let i = 0; i < V; i++) { e[i] = expNeg((mx - lg[i]) * POW2[FK - FL], FP); sum += e[i]; }
  const avail = POW2[SCALE_BITS] - V;
  let tot = 0;
  for (let i = 0; i < V; i++) { freqs[i] = 1 + floorDiv(e[i] * avail, sum); tot += freqs[i]; }
  freqs[am] += POW2[SCALE_BITS] - tot;
  return freqs;
}

// ---------------------------------------------------------------- rANS, 2^24 frequency total

const SCALE = POW2[SCALE_BITS];
const RL = POW2[L_BITS];
const FLUSH = Math.ceil((L_BITS + 8) / 8);

function ransEncode(steps: [number, number][]): Uint8Array {
  let x = RL;
  const out: number[] = [];
  for (let k = steps.length - 1; k >= 0; k--) {
    const [start, freq] = steps[k];
    const xMax = (RL / SCALE) * 256 * freq;
    while (x >= xMax) { out.push(x % 256); x = Math.floor(x / 256); }
    const q = floorDiv(x, freq);
    x = q * SCALE + (x - q * freq) + start;
  }
  for (let k = 0; k < FLUSH; k++) { out.push(x % 256); x = Math.floor(x / 256); }
  if (x !== 0) throw new Error("state did not flush");
  return Uint8Array.from(out.reverse());
}

class RansDecoder {
  x = 0;
  pos = 0;
  buf: Uint8Array;
  constructor(buf: Uint8Array) {
    this.buf = buf;
    for (let k = 0; k < FLUSH; k++) this.x = this.x * 256 + this.next();
  }
  next(): number { return this.pos < this.buf.length ? this.buf[this.pos++] : (this.pos++, 0); }
  get(freqs: Int32Array): number {
    const slot = this.x % SCALE;
    let i = 0, start = 0;
    while (start + freqs[i] <= slot) start += freqs[i++];
    this.x = freqs[i] * Math.floor(this.x / SCALE) + slot - start;
    while (this.x < RL) this.x = this.x * 256 + this.next();
    return i;
  }
  finish(): boolean { return this.x === RL && this.pos === this.buf.length; }
}

// ---------------------------------------------------------------- SentencePiece BPE

const pieces: { p: string; s: number; t: number }[] = meta.pieces.map(([p, s, t]: [string, number, number]) => ({ p, s, t }));
const pieceId = new Map<string, number>();
pieces.forEach((p, i) => { if (p.t === 1) pieceId.set(p.p, i); });

function bpeEncode(text: string): number[] {
  const sym = Array.from(text.replace(/ /g, "▁"));
  for (;;) {
    let best = -1, bestScore = -Infinity;
    for (let i = 0; i + 1 < sym.length; i++) {
      const id = pieceId.get(sym[i] + sym[i + 1]);
      if (id !== undefined && pieces[id].s > bestScore) { bestScore = pieces[id].s; best = i; }
    }
    if (best < 0) break;
    sym.splice(best, 2, sym[best] + sym[best + 1]);
  }
  const out: number[] = [];
  for (const s of sym) {
    const id = pieceId.get(s);
    if (id !== undefined) out.push(id);
    else for (const b of new TextEncoder().encode(s)) out.push(1 + b);
  }
  return out;
}

function bpeDecode(ids: number[]): string {
  const bytes: number[] = [];
  const enc = new TextEncoder();
  for (const id of ids) {
    const p = pieces[id];
    if (p.t === 6) bytes.push(id - 1);
    else for (const b of enc.encode(p.p.replace(/▁/g, " "))) bytes.push(b);
  }
  return new TextDecoder("utf-8", { fatal: true }).decode(Uint8Array.from(bytes));
}

// ---------------------------------------------------------------- checks

const docs = new Map<string, any>();
const wanted = new Set(vectors.map((v: any) => v.id));
for (const line of readFileSync(`${DIR}/corpus2.jsonl`, "utf8").split("\n")) {
  if (!line) continue;
  const id = line.slice(7, line.indexOf('"', 8));
  if (wanted.has(id)) docs.set(id, JSON.parse(line));
}

// Splits a test vector into marker runs and section token runs (scored, ending in END).
function segments(tokens: number[], mask: number[]): { markers: number[]; text: number[] }[] {
  const segs: { markers: number[]; text: number[] }[] = [];
  let i = 0;
  while (i < tokens.length) {
    const markers: number[] = [];
    while (i < tokens.length && !mask[i]) markers.push(tokens[i++]);
    const text: number[] = [];
    while (i < tokens.length && mask[i]) text.push(tokens[i++]);
    segs.push({ markers, text });
  }
  return segs;
}

const hash = (f: Int32Array) => createHash("sha256").update(new Uint8Array(f.buffer, f.byteOffset, f.byteLength)).digest("hex").slice(0, 16);

let hashSteps = 0, hashBad = 0, tokSame = 0, tokSecs = 0, okDocs = 0, bytesTot = 0, idealTot = 0, pyBitsTot = 0, charsTot = 0;
let encMs = 0, decMs = 0, steps = 0;
const freqs = new Int32Array(V);
const [SHARD, NSHARDS] = (process.env.SHARD ?? "0/1").split("/").map(Number);
const picked = vectors.slice(0, NDOCS).filter((_: unknown, i: number) => i % NSHARDS === SHARD);
for (const [n, vtr] of picked.entries()) {
  const doc = docs.get(vtr.id);
  const segs = segments(vtr.tokens, vtr.mask);
  // 1. Port check: the Python token sequence, every step's table hashed.
  if (n < 5) {
    const s = new State();
    for (let i = 0; i + 1 < vtr.tokens.length; i++) {
      step(s, vtr.tokens[i], freqs);
      hashSteps++;
      if (hash(freqs) !== vtr.hashes[i]) hashBad++;
    }
  }
  // 2. Encode the forecast text with TS tokenization.
  const texts: string[] = doc.sections.map((x: any) => x.text);
  const toks = texts.map((x) => bpeEncode(x));
  const pyText = segs.filter((g) => g.text.length).map((g) => g.text.slice(0, -1));
  toks.forEach((tk, j) => { tokSecs++; if (JSON.stringify(tk) === JSON.stringify(pyText[j])) tokSame++; });
  let t0 = performance.now();
  const s = new State();
  const plan: [number, number][] = [];
  let ideal = 0, prev = -1, j = 0;
  const feed = (tok: number) => { if (prev >= 0) { step(s, prev, freqs); steps++; } prev = tok; };
  for (const g of segs) {
    for (const m of g.markers) feed(m);
    if (!g.text.length) continue;
    for (const tok of [...toks[j++], END]) {
      feed(tok);
      // freqs now predicts tok
      let start = 0;
      for (let i = 0; i < tok; i++) start += freqs[i];
      plan.push([start, freqs[tok]]);
      ideal += SCALE_BITS - Math.log2(freqs[tok]);
    }
  }
  const bytes = ransEncode(plan);
  encMs += performance.now() - t0;
  // 3. Decode: markers known, text symbols from the stream.
  t0 = performance.now();
  const d = new RansDecoder(bytes);
  const ds = new State();
  const out: string[] = [];
  let first = true;
  const advance = (tok: number) => { step(ds, tok, freqs); };
  let last = -1;
  for (const g of segs) {
    for (const m of g.markers) { if (!first) advance(last); first = false; last = m; }
    if (!g.text.length) continue;
    const ids: number[] = [];
    for (;;) {
      advance(last);
      const sym = d.get(freqs);
      last = sym;
      if (sym === END) break;
      ids.push(sym);
    }
    out.push(bpeDecode(ids));
  }
  decMs += performance.now() - t0;
  const ok = d.finish() && out.length === texts.length && out.every((x, i) => x === texts[i]);
  if (ok) okDocs++;
  else console.log(`ROUND TRIP FAILED ${vtr.id}`);
  const chars = texts.reduce((a, x) => a + x.length, 0);
  bytesTot += bytes.length; idealTot += ideal; pyBitsTot += vtr.bits; charsTot += chars;
  if (n < 5 || n % 25 === 0)
    console.log(`${vtr.id} ${doc.center}: ${chars} chars, ${bytes.length} B (ideal ${(ideal / 8).toFixed(1)} B, Python tokens ${(vtr.bits / 8).toFixed(1)} B) ${ok ? "ok" : "FAIL"}`);
}
console.log(`\nport check: ${hashSteps - hashBad}/${hashSteps} step tables match Python (first ${Math.min(5, picked.length)} docs of this shard)`);
console.log(`tokenizer: ${tokSame}/${tokSecs} sections tokenize exactly as SentencePiece`);
console.log(`round trip: ${okDocs}/${picked.length} forecasts decoded exactly`);
console.log(`size: ${(bytesTot / picked.length).toFixed(1)} B/doc actual, ${(idealTot / 8 / picked.length).toFixed(1)} ideal (TS tokens), ${(pyBitsTot / 8 / picked.length).toFixed(1)} ideal (Python tokens); rANS overhead ${(bytesTot - idealTot / 8).toFixed(0)} B total = ${((bytesTot - idealTot / 8) / picked.length).toFixed(2)} B/doc; ${(8 * bytesTot / charsTot).toFixed(4)} b/c`);
console.log(`speed: ${(steps / (encMs / 1000)).toFixed(0)} tokens/s encode, ${(encMs / picked.length).toFixed(0)} ms/doc encode, ${(decMs / picked.length).toFixed(0)} ms/doc decode`);
