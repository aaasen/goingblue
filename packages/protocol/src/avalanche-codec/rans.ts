/**
 * Static-table rANS entropy coder for text symbols.
 *
 * The weather coder (../rans.ts) uses 12-bit frequency precision
 * and a linear symbol scan, sized for alphabets of a few dozen symbols. Word vocabularies run to
 * tens of thousands, so this coder uses 16-bit precision and binary search over the cumulative
 * table. Everything stays in plain JS numbers below 2^31 with no bitwise operators on the
 * state, so it is exact in float64 and portable to the mobile client.
 *
 * Invariants:
 *   1. Every table's frequencies are integers summing to exactly SCALE, none zero.
 *   2. The state stays in [RANS_L, RANS_L * 256), renormalized one byte at a time.
 *   3. rANS is LIFO: the encoder walks its symbols backwards and reverses the output so the
 *      decoder reads forward in the original order.
 */

export const SCALE_BITS = 16;
export const SCALE = 65536;
const RANS_L = 8388608; // 2^23
const BYTE = 256;
const STATE_MAX = RANS_L * BYTE; // 2^31
const SYM_LIMIT_MUL = STATE_MAX / SCALE; // 2^15

export interface Table {
  symbols: number[];
  freqs: number[];
  starts: number[];
  index: Map<number, number>;
}

// Scales counts to integers summing to SCALE with every entry >= 1. Flooring loses slots and the
// floor of 1 can overshoot; the difference is settled against the largest entries.
export function normalize(counts: number[], scale: number = SCALE): number[] {
  const n = counts.length;
  if (n === 0) throw new Error("rans: empty frequency table");
  if (n > scale) throw new Error(`rans: ${n} symbols will not fit in ${scale} slots`);
  let total = 0;
  for (const c of counts) total += c;
  const freqs = counts.map((c) => Math.max(1, Math.floor((c * scale) / total)));
  let sum = 0;
  for (const f of freqs) sum += f;
  let diff = scale - sum;
  if (diff > 0) {
    let big = 0;
    for (let i = 1; i < n; i++) if (freqs[i] > freqs[big]) big = i;
    freqs[big] += diff;
  } else if (diff < 0) {
    let need = -diff;
    const order = [...freqs.keys()].sort((a, b) => freqs[b] - freqs[a] || a - b);
    for (const i of order) {
      const take = Math.min(need, freqs[i] - 1);
      freqs[i] -= take;
      need -= take;
      if (need === 0) break;
    }
    if (need !== 0) throw new Error("rans: could not reclaim slots");
  }
  return freqs;
}

// items: (symbol, count) pairs in a deterministic order. Encoder and decoder each build the
// table from the same stored counts in the same order, which is what keeps them in sync.
export function buildTable(items: [number, number][]): Table {
  const symbols = items.map(([s]) => s);
  const freqs = normalize(items.map(([, c]) => c));
  const starts: number[] = new Array(freqs.length);
  let total = 0;
  for (let i = 0; i < freqs.length; i++) {
    starts[i] = total;
    total += freqs[i];
  }
  const index = new Map<number, number>();
  symbols.forEach((s, i) => index.set(s, i));
  return { symbols, freqs, starts, index };
}

export function costBits(table: Table, symbol: number): number {
  const i = table.index.get(symbol);
  if (i === undefined) throw new Error(`rans: symbol ${symbol} not in table`);
  return SCALE_BITS - Math.log2(table.freqs[i]);
}

export type Decision = [Table, number];

// Encodes decisions given in decode order and returns the byte stream.
export function encode(plan: Decision[]): Uint8Array {
  let x = RANS_L;
  const out: number[] = [];
  for (let k = plan.length - 1; k >= 0; k--) {
    const [table, symbol] = plan[k];
    const i = table.index.get(symbol);
    if (i === undefined) throw new Error(`rans: symbol ${symbol} not in table`);
    const freq = table.freqs[i];
    const xMax = SYM_LIMIT_MUL * freq;
    while (x >= xMax) {
      out.push(x % BYTE);
      x = Math.floor(x / BYTE);
    }
    x = Math.floor(x / freq) * SCALE + (x % freq) + table.starts[i];
  }
  for (let k = 0; k < 4; k++) {
    out.push(x % BYTE);
    x = Math.floor(x / BYTE);
  }
  if (x !== 0) throw new Error("rans: state did not flush");
  out.reverse();
  return Uint8Array.from(out);
}

export class Decoder {
  private x: number;
  private pos: number;

  constructor(private readonly buf: Uint8Array, pos = 0) {
    this.pos = pos;
    let x = 0;
    for (let k = 0; k < 4; k++) x = x * BYTE + this.next();
    this.x = x;
  }

  private next(): number {
    if (this.pos >= this.buf.length) throw new Error("rans: read past end of buffer");
    return this.buf[this.pos++];
  }

  get(table: Table): number {
    const slot = this.x % SCALE;
    let lo = 0;
    let hi = table.starts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (table.starts[mid] <= slot) lo = mid;
      else hi = mid - 1;
    }
    let x = table.freqs[lo] * Math.floor(this.x / SCALE) + slot - table.starts[lo];
    while (x < RANS_L) x = x * BYTE + this.next();
    this.x = x;
    return table.symbols[lo];
  }
}
