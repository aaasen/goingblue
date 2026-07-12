import { putInt, takeInt } from "./bits.js";

// ── rANS entropy coder ──────────────────────────────────────────────────────────
//
// Static-model range Asymmetric Numeral System coder for the message body. Unlike the Huffman
// coder it replaces, a symbol costs its exact information content -log2(f/M) — fractional bits —
// so peaked distributions (P(delta=0) ≈ 0.8 everywhere in this protocol) drop below the 1-bit
// floor a prefix code can never cross.
//
// Geometry (wire format — changing any of these changes what encoded messages mean, so they are
// pinned by the codebook digest test alongside the frequency tables):
//   M = 2^12  frequency precision: every table's frequencies sum to M, each >= 1
//   I = [2^16, 2^32)  state interval, renormalized in 16-bit words (b = 2^16, L = 2^16 = b·1)
//
// The state never exceeds 2^32 and no intermediate product exceeds 2^44, so everything is exact
// in float64: plain JS numbers, Math.floor division, no BigInt (this runs on the mobile client).
// The 32-bit state must never touch JS bitwise operators — they truncate to 32-bit signed.
//
// rANS is LIFO: the decoder recovers symbols in the reverse of encode order. ransEncode therefore
// walks the op list backwards and reverses the emitted words, so the decoder consumes the ops
// forward — same order the message structure is walked in v1.ts.
//
// Serialized layout (bit array for encodeBodyLE): final state as two 16-bit fields (hi, lo), then
// the renorm words in decode order. The state sits in the low-order bits, so encodeBodyLE's
// trailing-zero drop only ever truncates zero-valued *words*, which takeInt's read-past-end
// (?? 0) reproduces exactly. The encoder seeds the state with L, so after the last symbol the
// decoder's state must return to exactly L — a built-in integrity check (assertDone) that
// replaces (and strengthens) the old trailing-bits desync check.

export const RANS_PROB_BITS = 12;
export const RANS_M = 1 << RANS_PROB_BITS; // 4096
export const RANS_L = 0x10000; // state lower bound (2^16)
export const RANS_WORD_BITS = 16;
const WORD_BASE = 0x10000;
const STATE_MAX = 4294967296; // 2^32
// Renorm threshold multiplier for symbols: emit words while x >= freq * 2^(32 - PROB_BITS).
const SYM_LIMIT_MUL = STATE_MAX / RANS_M; // 2^20
const MAX_RAW_BITS = 16;

// A quantized frequency table over symbols 0..n-1. freq sums to RANS_M with every entry >= 1
// (so every symbol stays representable, matching the all-weights-positive Huffman guarantee);
// cum[s] is the exclusive prefix sum, cum[n] = RANS_M.
export interface RansTable {
  freq: number[];
  cum: number[];
}

// One encoder operation, in decode order. `sym` entries are entropy-coded under `table`; `raw`
// entries bypass the model and cost exactly `width` bits (used for anchors, mode selectors,
// FOR/sparse payloads — everywhere the old code called putInt).
export type RansOp =
  | { table: RansTable; sym: number }
  | { raw: number; width: number };

// Quantizes positive integer weights to frequencies summing to `M` with every entry >= 1.
// Deterministic (largest-remainder with index tiebreaks) — both sides derive identical tables
// from codebooks.gen.ts, and the result is wire format, digest-pinned by test/codebooks.test.ts.
export function quantizeFreqs(weights: number[], M: number = RANS_M): number[] {
  const n = weights.length;
  if (n < 1 || n > M) throw new Error(`rans: ${n} symbols cannot fit precision ${M}`);
  let total = 0;
  for (const w of weights) {
    if (!(w > 0)) throw new Error("rans: weights must be positive");
    total += w;
  }
  const ideal = weights.map((w) => (w * M) / total);
  const freq = ideal.map((v) => Math.max(1, Math.floor(v)));
  let excess = freq.reduce((a, b) => a + b, 0) - M;
  if (excess < 0) {
    // Hand out the remainder by largest fractional part (ties → lower index).
    const order = [...freq.keys()].sort(
      (a, b) => (ideal[b] - Math.floor(ideal[b])) - (ideal[a] - Math.floor(ideal[a])) || a - b,
    );
    for (let k = 0; excess < 0; k = (k + 1) % n) {
      freq[order[k]]++;
      excess++;
    }
  }
  while (excess > 0) {
    // The max(1, ·) clamps overshot; take back from the most over-represented entry that can
    // spare it (ties → lower index). Some entry with freq > 1 always exists while sum > M >= n.
    let pick = -1;
    for (let i = 0; i < n; i++) {
      if (freq[i] > 1 && (pick < 0 || freq[i] - ideal[i] > freq[pick] - ideal[pick])) pick = i;
    }
    freq[pick]--;
    excess--;
  }
  return freq;
}

export function buildRansTable(weights: number[]): RansTable {
  const freq = quantizeFreqs(weights);
  const cum: number[] = new Array(freq.length + 1);
  cum[0] = 0;
  for (let i = 0; i < freq.length; i++) cum[i + 1] = cum[i] + freq[i];
  return { freq, cum };
}

// The exact model cost of coding `sym` under `table`, in (fractional) bits. For encoder-side
// candidate selection and the instrumented breakdown; never on the wire.
export function symCostBits(table: RansTable, sym: number): number {
  return RANS_PROB_BITS - Math.log2(table.freq[sym]);
}

// Encodes `ops` (given in decode order) into a bit array for encodeBodyLE.
export function ransEncode(ops: RansOp[]): number[] {
  let x = RANS_L;
  const words: number[] = [];
  for (let i = ops.length - 1; i >= 0; i--) {
    const op = ops[i];
    if ("table" in op) {
      const f = op.table.freq[op.sym];
      if (!(f > 0)) throw new Error(`rans: symbol ${op.sym} outside table`);
      const limit = f * SYM_LIMIT_MUL;
      while (x >= limit) {
        words.push(x % WORD_BASE);
        x = Math.floor(x / WORD_BASE);
      }
      x = Math.floor(x / f) * RANS_M + (x % f) + op.table.cum[op.sym];
    } else {
      const w = op.width;
      if (w === 0) continue;
      if (w > MAX_RAW_BITS) throw new Error(`rans: raw width ${w} exceeds ${MAX_RAW_BITS}`);
      const base = 2 ** w;
      if (!(Number.isInteger(op.raw) && op.raw >= 0 && op.raw < base))
        throw new Error(`rans: raw value ${op.raw} outside ${w} bits`);
      const limit = STATE_MAX / base; // 2^(32-w)
      while (x >= limit) {
        words.push(x % WORD_BASE);
        x = Math.floor(x / WORD_BASE);
      }
      x = x * base + op.raw;
    }
  }
  const bits: number[] = [];
  putInt(bits, Math.floor(x / WORD_BASE), 16);
  putInt(bits, x % WORD_BASE, 16);
  for (let i = words.length - 1; i >= 0; i--) putInt(bits, words[i], 16);
  return bits;
}

export interface RansReader {
  sym(table: RansTable): number;
  raw(width: number): number;
  // Throws unless the state has returned exactly to its seed — the decode consumed precisely
  // the symbols the encoder wrote (codebook drift or corruption otherwise).
  assertDone(): void;
}

// Sequential decoder over a bit array produced by ransEncode (possibly with trailing zero words
// dropped by the body serialization). Ops must be consumed in the exact order they were given
// to ransEncode.
export function ransReader(bits: number[]): RansReader {
  let pos = 0;
  const next16 = (): number => {
    const [w, p] = takeInt(bits, pos, 16);
    pos = p;
    return w;
  };
  let x = next16() * WORD_BASE + next16();
  return {
    sym(table: RansTable): number {
      const slot = x % RANS_M;
      const cum = table.cum;
      let s = 0;
      while (cum[s + 1] <= slot) s++; // alphabets are <= 31 symbols; linear scan
      x = table.freq[s] * Math.floor(x / RANS_M) + slot - cum[s];
      while (x < RANS_L) x = x * WORD_BASE + next16();
      return s;
    },
    raw(width: number): number {
      if (width === 0) return 0;
      const base = 2 ** width;
      const v = x % base;
      x = Math.floor(x / base);
      while (x < RANS_L) x = x * WORD_BASE + next16();
      return v;
    },
    assertDone(): void {
      if (x !== RANS_L)
        throw new Error("rans: decode desynced — codebook mismatch or corrupted message");
    },
  };
}
