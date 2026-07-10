import { WMO_CODES } from "./constants.js";

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
  [113, 34, 37, 263, 312, 1, 59, 13, 6, 4, 2, 6, 5, 2, 1, 1, 29, 51, 38, 1, 3, 4, 1, 13, 1, 1, 1, 1],
  [854, 38, 25, 61, 14, 1, 3, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1],
  [417, 72, 65, 282, 53, 1, 46, 10, 3, 1, 1, 2, 2, 1, 1, 1, 11, 15, 6, 1, 3, 2, 1, 7, 1, 1, 1, 1],
  [624, 74, 56, 180, 32, 1, 14, 3, 1, 1, 1, 1, 1, 1, 1, 1, 5, 5, 1, 1, 1, 1, 1, 2, 1, 1, 1, 1],
  [250, 65, 69, 410, 59, 1, 52, 12, 4, 1, 1, 5, 4, 1, 1, 1, 20, 24, 8, 1, 3, 4, 1, 9, 1, 1, 1, 1],
  [80, 37, 48, 564, 55, 1, 68, 10, 3, 2, 1, 2, 1, 1, 1, 1, 53, 40, 9, 1, 2, 1, 1, 23, 2, 1, 1, 1],
  [90, 32, 35, 284, 51, 1, 277, 83, 24, 1, 1, 12, 11, 1, 1, 1, 11, 8, 3, 1, 25, 15, 2, 31, 2, 1, 1, 1],
];

export const WC_TABLE_COUNT = WEIGHTS.length; // 8 (fills the 3-bit wc_table field)

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
