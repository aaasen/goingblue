import { WMO_CODES } from "./constants.js";

// Static, regime-tuned Huffman codebooks for the weathercode column. Weathercodes are strongly
// skewed toward a few common conditions, and which conditions are common depends on the climate,
// so we keep several codebooks and let the encoder pick the cheapest per message (its index is
// stored in the header's `wc_table` field). Symbols are WMO indices (0..NSYM-1), mapping to
// WMO_CODES; every table assigns a code to every symbol so any outlier is representable.

const NSYM = WMO_CODES.length; // 28

// Frequency weights per regime (length NSYM, all > 0). Hand-seeded; retune against real data.
// WMO index legend: 0 clear · 1-3 cloud · 4-5 fog · 6-8 drizzle · 9-10 freezing drizzle ·
// 11-13 rain · 14-15 freezing rain · 16-19 snow · 20-22 rain showers · 23-24 snow showers ·
// 25-27 thunderstorm.
const WEIGHTS: number[][] = [
  // 0 general — near-uniform fallback (~5-bit codes; never much worse than raw).
  Array(NSYM).fill(1),
  // 1 dry — clear/cloud dominated.
  [100, 80, 70, 60, 10, 8, 4, 4, 4, 2, 2, 6, 6, 6, 1, 1, 2, 2, 2, 2, 3, 3, 3, 1, 1, 1, 1, 1],
  // 2 cold/snow — snow, freezing, fog.
  [60, 40, 50, 60, 20, 20, 2, 2, 2, 15, 15, 5, 5, 5, 15, 15, 50, 50, 40, 20, 2, 2, 2, 30, 25, 1, 1, 1],
  // 3 maritime — cloud, drizzle, steady rain.
  [20, 30, 60, 70, 25, 5, 40, 35, 25, 2, 2, 50, 45, 30, 3, 3, 3, 3, 3, 3, 40, 35, 10, 2, 2, 10, 4, 2],
  // 4 convective — clear, showers, thunderstorms.
  [60, 50, 45, 30, 10, 2, 8, 8, 8, 1, 1, 40, 40, 30, 1, 1, 2, 2, 2, 2, 45, 40, 25, 2, 2, 35, 20, 12],
];

export const WC_TABLE_COUNT = WEIGHTS.length; // 5 (fits in the 3-bit wc_table field)

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
