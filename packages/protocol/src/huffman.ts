import { WMO_CODES } from "./constants.js";
import { putInt, takeInt } from "./bits.js";

// Static, regime-tuned Huffman codebooks for the weathercode column. Weathercodes are strongly
// skewed toward a few common conditions, and which conditions are common depends on the climate,
// so we keep several codebooks and let the encoder pick the cheapest per message (its index is
// stored in the header's `wc_table` field). Symbols are WMO indices (0..NSYM-1), mapping to
// WMO_CODES; every table assigns a code to every symbol so any outlier is representable.

const NSYM = WMO_CODES.length; // 28

// Frequency weights per regime (length NSYM, all > 0). Derived by k-means clustering the corpus's
// per-forecast weathercode distributions — see server/scripts/derive-weathercode-codebooks.ts —
// plus a uniform table (index 0) so a column is never worse than raw 5 bits.
// WMO index legend: 0 clear · 1-3 cloud · 4-5 fog · 6-8 drizzle · 9-10 freezing drizzle ·
// 11-13 rain · 14-15 freezing rain · 16-19 snow · 20-22 rain showers · 23-24 snow showers ·
// 25-27 thunderstorm.
const WEIGHTS: number[][] = [
  // 0 general — near-uniform fallback (~5-bit codes; never much worse than raw).
  Array(NSYM).fill(1),
  [95, 39, 43, 367, 248, 1, 55, 11, 5, 4, 2, 5, 4, 1, 1, 1, 33, 48, 17, 1, 2, 4, 1, 14, 2, 1, 1, 1],
  [65, 34, 43, 663, 42, 1, 51, 6, 1, 1, 1, 1, 1, 1, 1, 1, 45, 27, 5, 1, 1, 1, 1, 14, 1, 1, 1, 1],
  [873, 34, 22, 51, 14, 1, 3, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1],
  [52, 24, 27, 218, 171, 1, 25, 6, 3, 8, 5, 5, 7, 3, 3, 6, 42, 171, 193, 1, 1, 1, 1, 20, 8, 1, 1, 1],
  [304, 74, 70, 248, 181, 1, 20, 5, 3, 4, 1, 3, 2, 1, 1, 1, 13, 37, 21, 1, 1, 3, 1, 5, 1, 1, 1, 1],
  [682, 70, 51, 148, 26, 1, 11, 2, 1, 1, 1, 1, 1, 1, 1, 1, 4, 3, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1],
  [376, 67, 67, 374, 32, 1, 28, 5, 2, 1, 1, 2, 1, 1, 1, 1, 14, 16, 3, 1, 2, 2, 1, 6, 1, 1, 1, 1],
  [518, 79, 64, 244, 35, 1, 22, 5, 2, 1, 1, 2, 1, 1, 1, 1, 7, 10, 3, 1, 1, 1, 1, 5, 1, 1, 1, 1],
  [95, 41, 48, 407, 40, 1, 216, 56, 15, 1, 1, 10, 8, 1, 1, 1, 7, 6, 2, 1, 13, 8, 1, 23, 1, 1, 1, 1],
  [83, 23, 27, 198, 427, 1, 94, 18, 7, 3, 1, 8, 6, 2, 1, 1, 24, 29, 15, 1, 4, 5, 2, 20, 2, 1, 1, 1],
  [210, 61, 69, 475, 52, 1, 42, 9, 3, 1, 1, 5, 4, 1, 1, 1, 21, 23, 7, 1, 2, 3, 1, 9, 1, 1, 1, 1],
  [58, 25, 28, 223, 60, 1, 332, 102, 31, 1, 1, 13, 10, 1, 1, 1, 12, 10, 4, 1, 36, 17, 3, 33, 1, 2, 1, 1],
  [27, 7, 13, 156, 52, 1, 54, 4, 1, 1, 1, 1, 1, 1, 1, 1, 208, 275, 68, 1, 1, 1, 1, 110, 22, 1, 1, 1],
  [60, 22, 31, 405, 59, 1, 56, 5, 1, 2, 1, 2, 2, 1, 1, 1, 141, 122, 25, 1, 1, 1, 1, 56, 8, 1, 1, 1],
  [307, 54, 51, 237, 37, 1, 164, 42, 13, 1, 1, 7, 9, 1, 1, 1, 14, 11, 4, 1, 14, 12, 3, 16, 1, 2, 1, 1],
];

export const WC_TABLE_COUNT = WEIGHTS.length; // 16 (fills the 4-bit wc_table field)

interface TrieNode { sym?: number; child: (TrieNode | undefined)[]; }
interface Table { codes: number[][]; root: TrieNode; }

// Huffman code lengths per symbol via repeated merge of the two lowest-weight nodes. NSYM is
// small, so an O(n²) selection is fine.
function huffmanLengths(weights: number[]): number[] {
  const n = weights.length;
  if (n === 1) return [1];
  interface Node { w: number; sym: number; left: number; right: number; }
  const nodes: Node[] = weights.map((w, i) => ({ w, sym: i, left: -1, right: -1 }));
  let alive = nodes.map((_, i) => i);
  while (alive.length > 1) {
    alive.sort((a, b) => nodes[a].w - nodes[b].w);
    const a = alive.shift()!;
    const b = alive.shift()!;
    nodes.push({ w: nodes[a].w + nodes[b].w, sym: -1, left: a, right: b });
    alive.push(nodes.length - 1);
  }
  const lengths = new Array<number>(n).fill(0);
  const walk = (i: number, depth: number): void => {
    const nd = nodes[i];
    if (nd.sym >= 0) { lengths[nd.sym] = Math.max(depth, 1); return; }
    walk(nd.left, depth + 1);
    walk(nd.right, depth + 1);
  };
  walk(alive[0], 0);
  return lengths;
}

// Canonical Huffman codes from a length set: symbols sorted by (length, symbol), codes assigned
// in increasing numeric order. Returns each symbol's code as an MSB-first bit array.
function canonicalCodes(lengths: number[]): number[][] {
  const order = [...lengths.keys()].sort((a, b) => lengths[a] - lengths[b] || a - b);
  const codes: number[][] = new Array(lengths.length);
  let code = 0;
  let prevLen = lengths[order[0]];
  for (const sym of order) {
    const len = lengths[sym];
    code <<= (len - prevLen);
    const bits: number[] = [];
    for (let i = len - 1; i >= 0; i--) bits.push((code >> i) & 1);
    codes[sym] = bits;
    code += 1;
    prevLen = len;
  }
  return codes;
}

function buildTrie(codes: number[][]): TrieNode {
  const root: TrieNode = { child: [] };
  codes.forEach((bits, sym) => {
    let node = root;
    for (const b of bits) {
      if (!node.child[b]) node.child[b] = { child: [] };
      node = node.child[b]!;
    }
    node.sym = sym;
  });
  return root;
}

const TABLES: Table[] = WEIGHTS.map((w) => {
  const codes = canonicalCodes(huffmanLengths(w));
  return { codes, root: buildTrie(codes) };
});

// Appends the Huffman code for `wmoIdx` (under `table`) to `bits`.
export function encodeWeathercode(bits: number[], table: number, wmoIdx: number): void {
  for (const b of TABLES[table].codes[wmoIdx]) bits.push(b);
}

// Reads one Huffman-coded weathercode (under `table`), returning [wmoIdx, nextPos].
export function decodeWeathercode(bits: number[], pos: number, table: number): [number, number] {
  let node = TABLES[table].root;
  while (node.sym === undefined) {
    node = node.child[bits[pos++] ?? 0]!;
    if (!node) throw new Error("huffman: invalid weathercode bitstream");
  }
  return [node.sym, pos];
}

// Picks the codebook that encodes `wmoIdxs` in the fewest total bits.
export function chooseWcTable(wmoIdxs: number[]): number {
  let best = 0;
  let bestBits = Infinity;
  for (let t = 0; t < TABLES.length; t++) {
    let total = 0;
    for (const idx of wmoIdxs) total += TABLES[t].codes[idx].length;
    if (total < bestBits) { bestBits = total; best = t; }
  }
  return best;
}

// ── Wind direction codebooks ────────────────────────────────────────────────────
// Static Huffman codebooks for the 8-point wind direction (symbols are direction indices 0..7; see
// CARDINALS). Derived by k-means clustering the corpus's per-column direction distributions across
// all wind levels (see server/scripts/derive-wind-dir-codebooks.ts) — each codebook captures a
// dominant-direction regime, plus a uniform table so a column is never worse than raw 3 bits. The
// encoder picks the cheapest per wind column and stores its index in a 3-bit selector.
const WIND_DIR_WEIGHTS: number[][] = [
  [34, 17, 13, 21, 98, 503, 243, 71],
  [97, 34, 21, 23, 43, 129, 352, 301],
  [1, 1, 1, 1, 1, 1, 1, 1],
  [120, 23, 12, 19, 22, 39, 140, 624],
  [53, 46, 123, 428, 156, 63, 47, 84],
  [13, 6, 6, 8, 24, 166, 651, 126],
  [451, 102, 27, 28, 34, 54, 69, 236],
  [45, 32, 35, 105, 417, 221, 90, 55],
];

export const WIND_DIR_TABLE_COUNT = WIND_DIR_WEIGHTS.length; // 8
export const WIND_DIR_TABLE_BITS = 3;                        // per-column codebook selector width

const WIND_DIR_TABLES: Table[] = WIND_DIR_WEIGHTS.map((w) => {
  const codes = canonicalCodes(huffmanLengths(w));
  return { codes, root: buildTrie(codes) };
});

// Appends the Huffman code for direction index `dirIdx` (0..7) under `table`.
export function encodeWindDir(bits: number[], table: number, dirIdx: number): void {
  for (const b of WIND_DIR_TABLES[table].codes[dirIdx]) bits.push(b);
}

// Reads one Huffman-coded direction (under `table`), returning [dirIdx, nextPos].
export function decodeWindDir(bits: number[], pos: number, table: number): [number, number] {
  let node = WIND_DIR_TABLES[table].root;
  while (node.sym === undefined) {
    node = node.child[bits[pos++] ?? 0]!;
    if (!node) throw new Error("huffman: invalid wind-direction bitstream");
  }
  return [node.sym, pos];
}

// Picks the codebook that encodes `dirIdxs` in the fewest total bits.
export function chooseWindDirTable(dirIdxs: number[]): number {
  let best = 0;
  let bestBits = Infinity;
  for (let t = 0; t < WIND_DIR_TABLES.length; t++) {
    let total = 0;
    for (const idx of dirIdxs) total += WIND_DIR_TABLES[t].codes[idx].length;
    if (total < bestBits) { bestBits = total; best = t; }
  }
  return best;
}

// ── Temperature delta codebooks ─────────────────────────────────────────────────
// Static Huffman codebooks for period-over-period temp_c change. Symbols are quantized deltas
// -7..7 (indices 0..14) plus an ESCAPE symbol (index 15) for rarer bigger jumps, followed by a raw
// 6-bit signed (bias 32) field covering -32..31°C. Derived by k-means clustering per-(forecast ×
// resolution) delta histograms pooled across 1h/3h/6h/12h/24h — see
// server/scripts/derive-temp-delta-codebooks.ts — deliberately NOT keyed by resolution: resolution
// is never on the wire (see v1.ts), and a future dynamic-duration message could mix resolutions
// within one column, so the codebook has to earn its keep on the actual delta shape alone. The
// encoder picks the cheapest per column and stores its index in a 4-bit selector.
const TEMP_DELTA_WEIGHTS: number[][] = [
  [8, 15, 27, 45, 69, 107, 205, 124, 119, 79, 76, 50, 33, 19, 10, 14],
  [1, 1, 1, 3, 8, 26, 148, 622, 152, 27, 7, 3, 1, 1, 1, 1],
  [4, 8, 13, 22, 43, 80, 261, 277, 80, 81, 53, 34, 20, 10, 5, 8],
  [3, 5, 10, 21, 38, 72, 97, 354, 272, 66, 31, 14, 7, 3, 2, 5],
  [12, 22, 41, 75, 136, 97, 74, 81, 120, 87, 83, 53, 36, 29, 20, 33],
  [1, 1, 3, 7, 18, 52, 230, 391, 201, 62, 20, 7, 4, 1, 1, 1],
  [1, 1, 1, 4, 11, 38, 192, 508, 187, 41, 12, 4, 1, 1, 1, 1],
  [9, 15, 22, 39, 61, 72, 126, 145, 120, 256, 59, 32, 18, 8, 4, 14],
  [4, 7, 13, 26, 43, 86, 373, 108, 110, 89, 55, 37, 22, 11, 6, 11],
  [2, 5, 9, 20, 41, 91, 210, 252, 199, 85, 41, 21, 12, 5, 3, 4],
  [12, 21, 33, 51, 65, 80, 108, 223, 128, 77, 70, 45, 32, 21, 12, 22],
  [5, 10, 17, 29, 47, 85, 123, 372, 98, 91, 49, 30, 18, 11, 5, 9],
  [5, 10, 16, 24, 47, 258, 126, 143, 105, 100, 65, 43, 24, 13, 8, 14],
  [39, 35, 36, 40, 41, 54, 72, 99, 72, 46, 39, 38, 37, 42, 35, 275],
  [44, 66, 64, 58, 37, 47, 83, 82, 42, 61, 104, 110, 85, 49, 24, 44],
  [5, 11, 17, 27, 46, 81, 139, 138, 353, 86, 45, 22, 11, 6, 3, 9],
];

export const TEMP_DELTA_CORE_RADIUS = 7;
const TEMP_DELTA_ESCAPE_SYM = 2 * TEMP_DELTA_CORE_RADIUS + 1; // 15
export const TEMP_DELTA_ESCAPE_BITS = 6;
const TEMP_DELTA_ESCAPE_BIAS = 1 << (TEMP_DELTA_ESCAPE_BITS - 1); // 32, covers -32..31°C jumps
export const TEMP_DELTA_TABLE_COUNT = TEMP_DELTA_WEIGHTS.length; // 16
export const TEMP_DELTA_TABLE_BITS = 4;

const TEMP_DELTA_TABLES: Table[] = TEMP_DELTA_WEIGHTS.map((w) => {
  const codes = canonicalCodes(huffmanLengths(w));
  return { codes, root: buildTrie(codes) };
});

function tempDeltaSym(delta: number): number {
  return Math.abs(delta) <= TEMP_DELTA_CORE_RADIUS ? delta + TEMP_DELTA_CORE_RADIUS : TEMP_DELTA_ESCAPE_SYM;
}

// Appends the Huffman code for a period-over-period temp change `delta` (°C) under `table`; jumps
// outside ±7°C fall back to the escape symbol plus a raw 6-bit field.
export function encodeTempDelta(bits: number[], table: number, delta: number): void {
  const sym = tempDeltaSym(delta);
  for (const b of TEMP_DELTA_TABLES[table].codes[sym]) bits.push(b);
  if (sym === TEMP_DELTA_ESCAPE_SYM) putInt(bits, delta + TEMP_DELTA_ESCAPE_BIAS, TEMP_DELTA_ESCAPE_BITS);
}

// Reads one Huffman-coded temp delta (under `table`), returning [delta, nextPos].
export function decodeTempDelta(bits: number[], pos: number, table: number): [number, number] {
  let node = TEMP_DELTA_TABLES[table].root;
  while (node.sym === undefined) {
    node = node.child[bits[pos++] ?? 0]!;
    if (!node) throw new Error("huffman: invalid temp-delta bitstream");
  }
  if (node.sym === TEMP_DELTA_ESCAPE_SYM) {
    const [raw, next] = takeInt(bits, pos, TEMP_DELTA_ESCAPE_BITS);
    return [raw - TEMP_DELTA_ESCAPE_BIAS, next];
  }
  return [node.sym - TEMP_DELTA_CORE_RADIUS, pos];
}

// Picks the codebook that encodes `deltas` in the fewest total bits (escape payload included).
export function chooseTempDeltaTable(deltas: number[]): number {
  let best = 0;
  let bestBits = Infinity;
  for (let t = 0; t < TEMP_DELTA_TABLES.length; t++) {
    let total = 0;
    for (const d of deltas) {
      const sym = tempDeltaSym(d);
      total += TEMP_DELTA_TABLES[t].codes[sym].length + (sym === TEMP_DELTA_ESCAPE_SYM ? TEMP_DELTA_ESCAPE_BITS : 0);
    }
    if (total < bestBits) { bestBits = total; best = t; }
  }
  return best;
}
