import { WMO_CODES } from "./constants.js";
import { putInt, takeInt } from "./bits.js";

// Static, order-1 Huffman codebooks for the weathercode column. Weather persists hour-to-hour far
// more than it varies by climate/region (a "clear" hour is followed by "clear" 85% of the time
// regardless of location), so rather than picking one of several regime-tuned tables per message,
// each symbol is coded under a table keyed by the *previously decoded* symbol — context both
// encoder and decoder already have, so it costs no header bits. Derived from the corpus's
// prev-symbol -> next-symbol transition counts — see
// server/scripts/derive-weathercode-codebooks.ts. Symbols are WMO indices (0..NSYM-1), mapping to
// WMO_CODES; every table assigns a code to every symbol so any outlier is representable.

const NSYM = WMO_CODES.length; // 28

// Distribution of the *first* weathercode of a sequence, which has no predecessor to key off of.
const BOOTSTRAP_WEIGHTS: number[] = [282, 50, 50, 295, 80, 1, 76, 19, 7, 1, 1, 5, 3, 1, 1, 1, 32, 37, 18, 1, 4, 3, 2, 30, 6, 1, 1, 1];

// WEIGHTS[prevSym] is the codebook for the symbol that follows `prevSym` (frequency weights,
// length NSYM, all > 0). A prevSym never observed as a predecessor in the corpus falls back to
// the corpus-wide marginal distribution.
// WMO index legend: 0 clear · 1-3 cloud · 4-5 fog · 6-8 drizzle · 9-10 freezing drizzle ·
// 11-13 rain · 14-15 freezing rain · 16-19 snow · 20-22 rain showers · 23-24 snow showers ·
// 25-27 thunderstorm.
const WEIGHTS: number[][] = [
  [854, 51, 32, 47, 11, 1, 4, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1],
  [328, 270, 147, 215, 21, 1, 14, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 2, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1],
  [215, 160, 227, 350, 26, 1, 16, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 2, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1],
  [50, 36, 59, 754, 41, 1, 34, 2, 1, 1, 1, 1, 1, 1, 1, 1, 10, 7, 1, 1, 1, 1, 1, 2, 1, 1, 1, 1],
  [39, 13, 17, 179, 632, 1, 53, 3, 1, 4, 1, 1, 1, 1, 1, 1, 23, 23, 6, 1, 1, 1, 1, 2, 1, 1, 1, 1],
  [312, 50, 48, 297, 74, 1, 71, 17, 5, 1, 1, 4, 3, 1, 1, 1, 30, 36, 15, 1, 5, 3, 1, 22, 3, 1, 1, 1],
  [21, 10, 12, 158, 67, 1, 557, 74, 12, 1, 1, 7, 3, 1, 1, 1, 35, 8, 1, 1, 6, 1, 1, 26, 1, 1, 1, 1],
  [5, 2, 3, 41, 17, 1, 329, 361, 92, 1, 1, 36, 12, 1, 1, 1, 12, 7, 1, 1, 44, 10, 1, 22, 1, 2, 1, 1],
  [2, 1, 4, 30, 15, 1, 164, 285, 179, 1, 1, 81, 32, 1, 1, 1, 16, 8, 2, 1, 132, 24, 1, 18, 1, 4, 1, 1],
  [5, 3, 1, 152, 244, 1, 40, 6, 1, 284, 73, 1, 1, 1, 16, 12, 43, 71, 26, 1, 1, 1, 1, 21, 1, 1, 1, 1],
  [1, 1, 1, 82, 144, 1, 26, 10, 3, 180, 229, 10, 1, 1, 54, 21, 62, 101, 62, 1, 3, 1, 1, 13, 1, 1, 1, 1],
  [3, 1, 2, 50, 24, 1, 130, 149, 110, 1, 1, 255, 153, 4, 1, 1, 26, 15, 6, 1, 37, 28, 2, 2, 1, 1, 1, 1],
  [1, 1, 2, 29, 13, 1, 44, 58, 41, 1, 1, 155, 422, 48, 1, 2, 27, 11, 10, 1, 31, 89, 13, 1, 1, 1, 1, 1],
  [1, 1, 1, 5, 10, 1, 12, 10, 7, 1, 1, 27, 214, 428, 2, 2, 27, 12, 7, 1, 7, 91, 135, 1, 2, 1, 1, 1],
  [1, 1, 1, 77, 105, 1, 11, 6, 1, 72, 110, 6, 22, 6, 182, 144, 28, 94, 138, 1, 1, 1, 1, 1, 1, 1, 1, 1],
  [5, 1, 1, 42, 78, 1, 1, 1, 5, 42, 73, 16, 31, 1, 115, 271, 5, 68, 240, 1, 5, 1, 1, 5, 1, 1, 1, 1],
  [1, 1, 2, 73, 38, 1, 105, 7, 3, 3, 1, 4, 3, 1, 1, 1, 534, 164, 13, 1, 1, 1, 1, 46, 1, 1, 1, 1],
  [2, 2, 3, 53, 47, 1, 27, 5, 1, 2, 2, 2, 2, 1, 1, 1, 110, 588, 97, 1, 1, 1, 1, 48, 7, 1, 1, 1],
  [1, 1, 1, 25, 37, 1, 7, 4, 2, 3, 2, 2, 3, 2, 2, 5, 22, 204, 621, 1, 1, 1, 1, 18, 37, 1, 1, 1],
  [312, 50, 48, 297, 74, 1, 71, 17, 5, 1, 1, 4, 3, 1, 1, 1, 30, 36, 15, 1, 5, 3, 1, 22, 3, 1, 1, 1],
  [3, 1, 2, 8, 1, 1, 102, 188, 135, 1, 1, 26, 14, 1, 1, 1, 5, 1, 1, 1, 334, 123, 6, 42, 2, 8, 1, 1],
  [2, 1, 1, 3, 1, 1, 31, 56, 46, 1, 1, 31, 61, 9, 1, 1, 1, 5, 1, 1, 198, 467, 60, 24, 1, 1, 1, 1],
  [1, 1, 1, 4, 1, 1, 8, 15, 2, 1, 1, 6, 40, 33, 1, 1, 1, 1, 6, 1, 63, 335, 443, 19, 11, 15, 1, 1],
  [1, 1, 1, 27, 8, 1, 107, 27, 4, 1, 1, 1, 1, 1, 1, 1, 63, 64, 10, 1, 8, 2, 1, 641, 32, 1, 1, 1],
  [1, 1, 1, 1, 1, 1, 16, 12, 1, 1, 1, 1, 1, 1, 1, 1, 3, 54, 120, 1, 5, 1, 1, 273, 513, 1, 1, 1],
  [1, 1, 1, 25, 1, 1, 50, 75, 65, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 196, 90, 40, 5, 1, 432, 20, 1],
  [1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 600, 400, 1],
  [312, 50, 48, 297, 74, 1, 71, 17, 5, 1, 1, 4, 3, 1, 1, 1, 30, 36, 15, 1, 5, 3, 1, 22, 3, 1, 1, 1],
];

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
const BOOTSTRAP_TABLE: Table = (() => {
  const codes = canonicalCodes(huffmanLengths(BOOTSTRAP_WEIGHTS));
  return { codes, root: buildTrie(codes) };
})();

// Appends the Huffman code for `wmoIdx` to `bits`, under the table keyed by `prevSym` — the
// previously decoded symbol, or null for the first symbol of a sequence (no predecessor).
export function encodeWeathercode(bits: number[], prevSym: number | null, wmoIdx: number): void {
  const table = prevSym === null ? BOOTSTRAP_TABLE : TABLES[prevSym];
  for (const b of table.codes[wmoIdx]) bits.push(b);
}

// Reads one Huffman-coded weathercode keyed by `prevSym` (see encodeWeathercode), returning
// [wmoIdx, nextPos].
export function decodeWeathercode(bits: number[], pos: number, prevSym: number | null): [number, number] {
  const table = prevSym === null ? BOOTSTRAP_TABLE : TABLES[prevSym];
  let node = table.root;
  while (node.sym === undefined) {
    node = node.child[bits[pos++] ?? 0]!;
    if (!node) throw new Error("huffman: invalid weathercode bitstream");
  }
  return [node.sym, pos];
}

// ── Wind direction codebooks ────────────────────────────────────────────────────
// Static, order-1 Huffman codebooks for the 8-point wind direction (symbols are direction indices
// 0..7; see CARDINALS). Wind direction persists hour-to-hour far more than it varies by regime (see
// server/scripts/analyze-wind-dir-transitions.ts: P(next=prev) 68-90% depending on level), so like
// weathercode, each direction is coded under a table keyed by the *previously decoded* direction —
// context both sides already have, so it costs no header bits. One shared codebook set across all
// four wind levels (surface + 500/600/700 hPa): pooling the transition counts across levels barely
// changes the bit cost vs. deriving separate tables per level (<0.01 b/dir), so a single set keeps
// things simple and lets every wind column reuse it — each column tracks its own previous-direction
// context independently (a separate chain per wind level). Derived from the corpus's pooled
// prev-direction -> next-direction transition counts — see
// server/scripts/derive-wind-dir-codebooks.ts.
const WIND_DIR_BOOTSTRAP_WEIGHTS: number[] = [90, 50, 35, 66, 112, 185, 265, 196];

// WIND_DIR_WEIGHTS[prevDir] is the codebook for the direction that follows `prevDir`.
const WIND_DIR_WEIGHTS: number[][] = [
  [810, 63, 6, 3, 3, 3, 6, 107],
  [109, 763, 96, 11, 4, 3, 4, 10],
  [13, 114, 731, 117, 12, 4, 3, 5],
  [5, 9, 79, 774, 117, 9, 3, 3],
  [3, 2, 5, 64, 802, 115, 7, 3],
  [2, 1, 1, 3, 58, 841, 90, 4],
  [3, 1, 1, 1, 2, 64, 868, 61],
  [57, 3, 1, 1, 2, 4, 80, 853],
];

const WIND_DIR_TABLES: Table[] = WIND_DIR_WEIGHTS.map((w) => {
  const codes = canonicalCodes(huffmanLengths(w));
  return { codes, root: buildTrie(codes) };
});
const WIND_DIR_BOOTSTRAP_TABLE: Table = (() => {
  const codes = canonicalCodes(huffmanLengths(WIND_DIR_BOOTSTRAP_WEIGHTS));
  return { codes, root: buildTrie(codes) };
})();

// Appends the Huffman code for direction index `dirIdx` (0..7) to `bits`, under the table keyed by
// `prevDir` — the previously decoded direction, or null for the first direction of a sequence (no
// predecessor).
export function encodeWindDir(bits: number[], prevDir: number | null, dirIdx: number): void {
  const table = prevDir === null ? WIND_DIR_BOOTSTRAP_TABLE : WIND_DIR_TABLES[prevDir];
  for (const b of table.codes[dirIdx]) bits.push(b);
}

// Reads one Huffman-coded direction keyed by `prevDir` (see encodeWindDir), returning
// [dirIdx, nextPos].
export function decodeWindDir(bits: number[], pos: number, prevDir: number | null): [number, number] {
  const table = prevDir === null ? WIND_DIR_BOOTSTRAP_TABLE : WIND_DIR_TABLES[prevDir];
  let node = table.root;
  while (node.sym === undefined) {
    node = node.child[bits[pos++] ?? 0]!;
    if (!node) throw new Error("huffman: invalid wind-direction bitstream");
  }
  return [node.sym, pos];
}

// ── Wind speed delta codebooks ──────────────────────────────────────────────────
// Static Huffman codebooks for period-over-period wind-speed change, in quantized steps (see
// WIND_SPEED_BITS in v1.ts: 0..15). Unlike temperature the domain is already small and bounded, so
// the full delta range -15..15 (31 symbols) fits directly in the alphabet — no escape/raw-payload
// fallback needed. Derived by k-means clustering per-(forecast × wind level) delta histograms
// pooled across all four wind levels (surface + 500/600/700 hPa) — same call as wind direction
// (pooling barely changes the bit cost vs. separate tables per level) — see
// server/scripts/derive-wind-speed-delta-codebooks.ts. The encoder picks the cheapest per column
// and stores its index in a 4-bit selector.
const WIND_SPEED_DELTA_WEIGHTS: number[][] = [
  [1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1],
  [1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 8, 127, 707, 151, 5, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1],
  [1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 56, 889, 55, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1],
  [1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 2, 8, 40, 165, 541, 201, 34, 6, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1],
  [1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 10, 183, 635, 154, 14, 2, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1],
  [1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 5, 160, 690, 137, 7, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1],
  [1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 2, 7, 35, 213, 479, 224, 32, 6, 2, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1],
  [1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 29, 943, 28, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1],
  [1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 2, 104, 790, 101, 2, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1],
  [1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 11, 151, 655, 171, 8, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1],
  [1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 3, 18, 209, 578, 161, 24, 5, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1],
  [1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 2, 15, 175, 602, 193, 11, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1],
  [1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 5, 28, 238, 505, 174, 39, 7, 2, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1],
  [1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 81, 838, 79, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1],
  [1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 3, 127, 744, 120, 4, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1],
  [1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 2, 16, 209, 546, 209, 14, 2, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1],
];

const WIND_SPEED_DELTA_MAX = 15; // must mirror WIND_SPEED_BITS in v1.ts (0..15)
export const WIND_SPEED_DELTA_TABLE_COUNT = WIND_SPEED_DELTA_WEIGHTS.length; // 16
export const WIND_SPEED_DELTA_TABLE_BITS = 4;

const WIND_SPEED_DELTA_TABLES: Table[] = WIND_SPEED_DELTA_WEIGHTS.map((w) => {
  const codes = canonicalCodes(huffmanLengths(w));
  return { codes, root: buildTrie(codes) };
});

function windSpeedDeltaSym(delta: number): number {
  return delta + WIND_SPEED_DELTA_MAX;
}

// Appends the Huffman code for a period-over-period wind-speed change `delta` (quantized steps)
// under `table`.
export function encodeWindSpeedDelta(bits: number[], table: number, delta: number): void {
  for (const b of WIND_SPEED_DELTA_TABLES[table].codes[windSpeedDeltaSym(delta)]) bits.push(b);
}

// Reads one Huffman-coded wind-speed delta (under `table`), returning [delta, nextPos].
export function decodeWindSpeedDelta(bits: number[], pos: number, table: number): [number, number] {
  let node = WIND_SPEED_DELTA_TABLES[table].root;
  while (node.sym === undefined) {
    node = node.child[bits[pos++] ?? 0]!;
    if (!node) throw new Error("huffman: invalid wind-speed-delta bitstream");
  }
  return [node.sym - WIND_SPEED_DELTA_MAX, pos];
}

// Picks the codebook that encodes `deltas` in the fewest total bits.
export function chooseWindSpeedDeltaTable(deltas: number[]): number {
  let best = 0;
  let bestBits = Infinity;
  for (let t = 0; t < WIND_SPEED_DELTA_TABLES.length; t++) {
    let total = 0;
    for (const d of deltas) total += WIND_SPEED_DELTA_TABLES[t].codes[windSpeedDeltaSym(d)].length;
    if (total < bestBits) { bestBits = total; best = t; }
  }
  return best;
}

// ── Freezing-level delta codebook ───────────────────────────────────────────────
// Static Huffman codebook for period-over-period freezing-level change, in quantized steps (see
// the freeze column in v1.ts: 0..15, 304.8 m / 1000 ft steps). Like wind speed the domain is
// already small and bounded, so the full delta range -15..15 (31 symbols) fits directly in the
// alphabet — no escape/raw-payload fallback needed. A SINGLE shared table, no per-message selector:
// unlike weathercode/wind direction, freeze-level deltas don't have genuinely distinct regimes
// across locations/seasons — everywhere is dominated by "usually 0, occasionally ±1" — so k-means
// clustering into several per-message tables was checked and found to not pay off (held-out:
// cheapest-of-16 with a 4-bit selector cost 1.371 b/period vs 1.340 b/period for one shared table).
// Derived from the corpus's pooled delta distribution — see
// server/scripts/derive-freeze-delta-codebooks.ts.
const FREEZE_DELTA_WEIGHTS: number[] = [1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 2, 5, 88, 812, 83, 5, 2, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1];

const FREEZE_DELTA_MAX = 15; // must mirror the freeze column width in v1.ts (0..15)

const FREEZE_DELTA_TABLE: Table = (() => {
  const codes = canonicalCodes(huffmanLengths(FREEZE_DELTA_WEIGHTS));
  return { codes, root: buildTrie(codes) };
})();

function freezeDeltaSym(delta: number): number {
  return delta + FREEZE_DELTA_MAX;
}

// Appends the Huffman code for a period-over-period freezing-level change `delta` (quantized steps).
export function encodeFreezeDelta(bits: number[], delta: number): void {
  for (const b of FREEZE_DELTA_TABLE.codes[freezeDeltaSym(delta)]) bits.push(b);
}

// Reads one Huffman-coded freezing-level delta, returning [delta, nextPos].
export function decodeFreezeDelta(bits: number[], pos: number): [number, number] {
  let node = FREEZE_DELTA_TABLE.root;
  while (node.sym === undefined) {
    node = node.child[bits[pos++] ?? 0]!;
    if (!node) throw new Error("huffman: invalid freeze-delta bitstream");
  }
  return [node.sym - FREEZE_DELTA_MAX, pos];
}

// ── Cloud cover delta codebooks ─────────────────────────────────────────────────
// Static Huffman codebooks for period-over-period cloud-cover change, in quantized steps (see the
// cloud columns in v1.ts: 0..7, 3-bit). Like wind speed and freezing level the domain is already
// small and bounded, so the full delta range -7..7 (15 symbols) fits directly in the alphabet — no
// escape/raw-payload fallback needed. Low/mid/high clouds get INDEPENDENT codebook pools (not
// shared, unlike temp/tmin) — low clouds are local/convective and change quickly, high clouds are
// broad cirrus sheets that persist for hours, so a shared codebook would blur two genuinely
// different persistence regimes. Derived by k-means clustering per-forecast delta histograms, one
// clustering per level — see server/scripts/derive-cloud-delta-codebooks.ts. The encoder picks the
// cheapest per column and stores its index in a 4-bit selector.
const CLOUD_DELTA_MAX = 7; // must mirror the cloud column width in v1.ts (0..7)

const CLOUD_LOW_DELTA_WEIGHTS: number[][] = [
  [1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1],
  [39, 6, 4, 6, 10, 8, 16, 828, 13, 6, 7, 6, 4, 6, 40],
  [9, 9, 12, 20, 26, 38, 64, 638, 69, 39, 26, 19, 12, 10, 9],
  [1, 1, 1, 1, 1, 1, 1, 993, 1, 1, 1, 1, 1, 1, 1],
  [6, 5, 6, 7, 10, 15, 31, 843, 31, 15, 10, 7, 5, 4, 6],
  [7, 2, 2, 3, 4, 5, 11, 935, 9, 5, 3, 2, 2, 2, 8],
  [6, 8, 10, 16, 22, 32, 101, 601, 110, 37, 20, 14, 9, 9, 5],
  [8, 7, 9, 14, 18, 25, 46, 745, 48, 28, 17, 13, 8, 7, 9],
  [52, 12, 13, 18, 28, 26, 42, 631, 38, 23, 22, 17, 12, 14, 54],
  [10, 10, 13, 26, 40, 51, 106, 479, 119, 56, 35, 24, 14, 9, 9],
  [14, 9, 11, 18, 25, 33, 43, 694, 44, 31, 25, 18, 10, 10, 14],
  [4, 4, 5, 8, 10, 18, 55, 787, 59, 19, 11, 7, 5, 4, 3],
  [12, 6, 7, 11, 17, 20, 30, 796, 28, 19, 16, 10, 7, 6, 13],
  [48, 8, 7, 11, 16, 16, 29, 742, 23, 13, 13, 9, 8, 8, 50],
  [8, 4, 4, 6, 8, 10, 19, 887, 18, 9, 7, 6, 3, 4, 9],
  [5, 6, 8, 14, 15, 25, 75, 703, 77, 25, 16, 11, 8, 6, 6],
];

export const CLOUD_LOW_DELTA_TABLE_COUNT = CLOUD_LOW_DELTA_WEIGHTS.length; // 16
export const CLOUD_LOW_DELTA_TABLE_BITS = 4;

const CLOUD_LOW_DELTA_TABLES: Table[] = CLOUD_LOW_DELTA_WEIGHTS.map((w) => {
  const codes = canonicalCodes(huffmanLengths(w));
  return { codes, root: buildTrie(codes) };
});

function cloudLowDeltaSym(delta: number): number {
  return delta + CLOUD_DELTA_MAX;
}

// Appends the Huffman code for a period-over-period low-cloud change `delta` (quantized steps)
// under `table`.
export function encodeCloudLowDelta(bits: number[], table: number, delta: number): void {
  for (const b of CLOUD_LOW_DELTA_TABLES[table].codes[cloudLowDeltaSym(delta)]) bits.push(b);
}

// Reads one Huffman-coded low-cloud delta (under `table`), returning [delta, nextPos].
export function decodeCloudLowDelta(bits: number[], pos: number, table: number): [number, number] {
  let node = CLOUD_LOW_DELTA_TABLES[table].root;
  while (node.sym === undefined) {
    node = node.child[bits[pos++] ?? 0]!;
    if (!node) throw new Error("huffman: invalid cloud-low-delta bitstream");
  }
  return [node.sym - CLOUD_DELTA_MAX, pos];
}

// Picks the codebook that encodes `deltas` in the fewest total bits.
export function chooseCloudLowDeltaTable(deltas: number[]): number {
  let best = 0;
  let bestBits = Infinity;
  for (let t = 0; t < CLOUD_LOW_DELTA_TABLES.length; t++) {
    let total = 0;
    for (const d of deltas) total += CLOUD_LOW_DELTA_TABLES[t].codes[cloudLowDeltaSym(d)].length;
    if (total < bestBits) { bestBits = total; best = t; }
  }
  return best;
}

const CLOUD_MID_DELTA_WEIGHTS: number[][] = [
  [1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1],
  [11, 5, 5, 7, 8, 9, 16, 880, 16, 9, 7, 7, 5, 5, 11],
  [15, 16, 16, 23, 30, 43, 84, 546, 80, 42, 32, 24, 17, 15, 16],
  [17, 12, 13, 17, 22, 26, 39, 712, 40, 24, 20, 18, 11, 14, 17],
  [2, 1, 1, 1, 1, 1, 4, 977, 4, 2, 1, 1, 1, 1, 2],
  [8, 8, 8, 12, 16, 21, 49, 754, 50, 21, 14, 11, 10, 8, 8],
  [7, 3, 3, 4, 4, 6, 12, 925, 11, 6, 4, 4, 3, 3, 7],
  [8, 12, 12, 18, 24, 33, 83, 624, 82, 33, 21, 17, 12, 13, 9],
  [8, 8, 8, 10, 12, 17, 39, 800, 37, 16, 13, 9, 8, 8, 9],
  [24, 12, 10, 13, 16, 17, 29, 758, 28, 17, 16, 14, 10, 12, 24],
  [25, 9, 7, 10, 11, 9, 18, 819, 19, 11, 10, 9, 8, 10, 24],
  [27, 18, 17, 20, 21, 27, 49, 647, 47, 22, 21, 18, 16, 18, 30],
  [11, 10, 12, 19, 27, 38, 53, 664, 53, 36, 24, 19, 12, 11, 11],
  [21, 18, 16, 24, 32, 36, 55, 593, 59, 35, 29, 25, 17, 18, 22],
  [9, 9, 10, 13, 17, 24, 67, 702, 68, 24, 15, 12, 9, 11, 9],
  [6, 5, 6, 8, 10, 12, 29, 845, 30, 13, 9, 7, 6, 6, 6],
];

export const CLOUD_MID_DELTA_TABLE_COUNT = CLOUD_MID_DELTA_WEIGHTS.length; // 16
export const CLOUD_MID_DELTA_TABLE_BITS = 4;

const CLOUD_MID_DELTA_TABLES: Table[] = CLOUD_MID_DELTA_WEIGHTS.map((w) => {
  const codes = canonicalCodes(huffmanLengths(w));
  return { codes, root: buildTrie(codes) };
});

function cloudMidDeltaSym(delta: number): number {
  return delta + CLOUD_DELTA_MAX;
}

// Appends the Huffman code for a period-over-period mid-cloud change `delta` (quantized steps)
// under `table`.
export function encodeCloudMidDelta(bits: number[], table: number, delta: number): void {
  for (const b of CLOUD_MID_DELTA_TABLES[table].codes[cloudMidDeltaSym(delta)]) bits.push(b);
}

// Reads one Huffman-coded mid-cloud delta (under `table`), returning [delta, nextPos].
export function decodeCloudMidDelta(bits: number[], pos: number, table: number): [number, number] {
  let node = CLOUD_MID_DELTA_TABLES[table].root;
  while (node.sym === undefined) {
    node = node.child[bits[pos++] ?? 0]!;
    if (!node) throw new Error("huffman: invalid cloud-mid-delta bitstream");
  }
  return [node.sym - CLOUD_DELTA_MAX, pos];
}

// Picks the codebook that encodes `deltas` in the fewest total bits.
export function chooseCloudMidDeltaTable(deltas: number[]): number {
  let best = 0;
  let bestBits = Infinity;
  for (let t = 0; t < CLOUD_MID_DELTA_TABLES.length; t++) {
    let total = 0;
    for (const d of deltas) total += CLOUD_MID_DELTA_TABLES[t].codes[cloudMidDeltaSym(d)].length;
    if (total < bestBits) { bestBits = total; best = t; }
  }
  return best;
}

const CLOUD_HIGH_DELTA_WEIGHTS: number[][] = [
  [1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1],
  [2, 1, 1, 2, 2, 3, 7, 967, 6, 2, 2, 2, 1, 1, 2],
  [8, 8, 9, 12, 17, 25, 57, 731, 56, 25, 17, 14, 8, 8, 8],
  [7, 10, 9, 15, 23, 31, 74, 658, 76, 32, 22, 17, 10, 9, 7],
  [7, 6, 6, 9, 11, 15, 35, 818, 36, 16, 12, 9, 6, 7, 7],
  [19, 12, 8, 13, 16, 19, 29, 765, 32, 20, 16, 12, 10, 12, 17],
  [31, 19, 15, 17, 23, 23, 45, 652, 46, 25, 24, 18, 15, 19, 29],
  [11, 5, 5, 7, 8, 11, 22, 857, 23, 12, 9, 8, 5, 6, 10],
  [6, 6, 6, 9, 12, 17, 54, 781, 56, 16, 12, 9, 6, 6, 5],
  [36, 16, 9, 12, 16, 16, 33, 719, 35, 16, 16, 15, 11, 16, 33],
  [7, 10, 13, 19, 24, 38, 90, 594, 92, 39, 25, 18, 12, 11, 7],
  [8, 4, 3, 5, 6, 8, 17, 900, 18, 8, 6, 5, 4, 4, 7],
  [14, 12, 10, 18, 23, 29, 45, 692, 50, 28, 24, 16, 12, 13, 13],
  [19, 18, 17, 24, 32, 37, 58, 593, 57, 36, 30, 24, 18, 18, 19],
  [10, 17, 16, 24, 36, 45, 92, 518, 91, 45, 36, 26, 17, 16, 11],
  [32, 11, 8, 8, 10, 11, 17, 803, 19, 13, 11, 9, 8, 11, 29],
];

export const CLOUD_HIGH_DELTA_TABLE_COUNT = CLOUD_HIGH_DELTA_WEIGHTS.length; // 16
export const CLOUD_HIGH_DELTA_TABLE_BITS = 4;

const CLOUD_HIGH_DELTA_TABLES: Table[] = CLOUD_HIGH_DELTA_WEIGHTS.map((w) => {
  const codes = canonicalCodes(huffmanLengths(w));
  return { codes, root: buildTrie(codes) };
});

function cloudHighDeltaSym(delta: number): number {
  return delta + CLOUD_DELTA_MAX;
}

// Appends the Huffman code for a period-over-period high-cloud change `delta` (quantized steps)
// under `table`.
export function encodeCloudHighDelta(bits: number[], table: number, delta: number): void {
  for (const b of CLOUD_HIGH_DELTA_TABLES[table].codes[cloudHighDeltaSym(delta)]) bits.push(b);
}

// Reads one Huffman-coded high-cloud delta (under `table`), returning [delta, nextPos].
export function decodeCloudHighDelta(bits: number[], pos: number, table: number): [number, number] {
  let node = CLOUD_HIGH_DELTA_TABLES[table].root;
  while (node.sym === undefined) {
    node = node.child[bits[pos++] ?? 0]!;
    if (!node) throw new Error("huffman: invalid cloud-high-delta bitstream");
  }
  return [node.sym - CLOUD_DELTA_MAX, pos];
}

// Picks the codebook that encodes `deltas` in the fewest total bits.
export function chooseCloudHighDeltaTable(deltas: number[]): number {
  let best = 0;
  let bestBits = Infinity;
  for (let t = 0; t < CLOUD_HIGH_DELTA_TABLES.length; t++) {
    let total = 0;
    for (const d of deltas) total += CLOUD_HIGH_DELTA_TABLES[t].codes[cloudHighDeltaSym(d)].length;
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
