import { WMO_CODES } from "./constants.js";
import { putInt, takeInt } from "./bits.js";

// ── Canonical Huffman machinery (shared by every codec below) ───────────────────

interface TrieNode { sym?: number; child: (TrieNode | undefined)[]; }
interface Table { codes: number[][]; root: TrieNode; }

// Huffman code lengths per symbol via repeated merge of the two lowest-weight nodes. Alphabets are
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

function buildTable(weights: number[]): Table {
  const codes = canonicalCodes(huffmanLengths(weights));
  return { codes, root: buildTrie(codes) };
}

// Reads one Huffman-coded symbol under `table`, returning [sym, nextPos].
function readSym(table: Table, bits: number[], pos: number, what: string): [number, number] {
  let node: TrieNode | undefined = table.root;
  while (node.sym === undefined) {
    node = node.child[bits[pos++] ?? 0];
    if (!node) throw new Error(`huffman: invalid ${what} bitstream`);
  }
  return [node.sym, pos];
}

// ── Codec factories ─────────────────────────────────────────────────────────────

// Order-1 conditional codec: each symbol is coded under a table keyed by the *previously decoded*
// symbol — context both encoder and decoder already have, so it costs no header bits — or by the
// bootstrap table for the first symbol of a sequence (no predecessor).
function makeConditionalCodec(bootstrapWeights: number[], weights: number[][], what: string) {
  const tables = weights.map(buildTable);
  const bootstrap = buildTable(bootstrapWeights);
  return {
    encode(bits: number[], prevSym: number | null, sym: number): void {
      const table = prevSym === null ? bootstrap : tables[prevSym];
      for (const b of table.codes[sym]) bits.push(b);
    },
    decode(bits: number[], pos: number, prevSym: number | null): [number, number] {
      return readSym(prevSym === null ? bootstrap : tables[prevSym], bits, pos, what);
    },
  };
}

// Single-table delta codec for a bounded quantized domain 0..maxDelta: the full delta range
// -maxDelta..maxDelta (2·maxDelta+1 symbols) fits directly in the alphabet — no escape/raw-payload
// fallback needed. One shared table, no per-message selector: held-out checks (see the derive
// scripts) found delta shape doesn't vary enough by location/season/level for a cheapest-of-k
// selector to pay for itself — everywhere is dominated by "usually 0, occasionally ±1".
export interface DeltaCodec {
  encode(bits: number[], delta: number): void;
  decode(bits: number[], pos: number): [number, number];
}

function makeDeltaCodec(weights: number[], maxDelta: number, what: string): DeltaCodec {
  const table = buildTable(weights);
  return {
    encode(bits: number[], delta: number): void {
      for (const b of table.codes[delta + maxDelta]) bits.push(b);
    },
    decode(bits: number[], pos: number): [number, number] {
      const [sym, next] = readSym(table, bits, pos, what);
      return [sym - maxDelta, next];
    },
  };
}

// ── Weathercode ─────────────────────────────────────────────────────────────────
// Static, order-1 Huffman codebooks for the weathercode column. Weather persists hour-to-hour far
// more than it varies by climate/region (a "clear" hour is followed by "clear" 85% of the time
// regardless of location). Derived from the corpus's prev-symbol -> next-symbol transition counts —
// see server/scripts/derive-weathercode-codebooks.ts. Symbols are WMO indices (0..NSYM-1), mapping
// to WMO_CODES; every table assigns a code to every symbol so any outlier is representable.

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

const WEATHERCODE_CODEC = makeConditionalCodec(BOOTSTRAP_WEIGHTS, WEIGHTS, "weathercode");

// Appends the Huffman code for `wmoIdx` to `bits`, under the table keyed by `prevSym` — the
// previously decoded symbol, or null for the first symbol of a sequence (no predecessor).
export const encodeWeathercode = WEATHERCODE_CODEC.encode;

// Reads one Huffman-coded weathercode keyed by `prevSym` (see encodeWeathercode), returning
// [wmoIdx, nextPos].
export const decodeWeathercode = WEATHERCODE_CODEC.decode;

// ── Wind direction ──────────────────────────────────────────────────────────────
// Static, order-1 Huffman codebooks for the 8-point wind direction (symbols are direction indices
// 0..7; see CARDINALS). Wind direction persists hour-to-hour far more than it varies by regime (see
// server/scripts/analyze-wind-dir-transitions.ts: P(next=prev) 68-90% depending on level), so like
// weathercode, each direction is coded under a table keyed by the previously decoded direction.
// One shared codebook set across all four wind levels (surface + 500/600/700 hPa): pooling the
// transition counts across levels barely changes the bit cost vs. deriving separate tables per
// level (<0.01 b/dir), so a single set keeps things simple and lets every wind column reuse it —
// each column tracks its own previous-direction context independently (a separate chain per wind
// level). Derived from the corpus's pooled prev-direction -> next-direction transition counts —
// see server/scripts/derive-wind-dir-codebooks.ts.
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

const WIND_DIR_CODEC = makeConditionalCodec(WIND_DIR_BOOTSTRAP_WEIGHTS, WIND_DIR_WEIGHTS, "wind-direction");

// Appends the Huffman code for direction index `dirIdx` (0..7) to `bits`, under the table keyed by
// `prevDir` — the previously decoded direction, or null for the first direction of a sequence (no
// predecessor).
export const encodeWindDir = WIND_DIR_CODEC.encode;

// Reads one Huffman-coded direction keyed by `prevDir` (see encodeWindDir), returning
// [dirIdx, nextPos].
export const decodeWindDir = WIND_DIR_CODEC.decode;

// ── Wind speed deltas ───────────────────────────────────────────────────────────
// Period-over-period wind-speed change, in quantized steps (see WIND_SPEED_BITS in v1.ts: 0..15,
// so deltas -15..15). One table pooled across all four wind levels (surface + 500/600/700 hPa) —
// same call as wind direction. A held-out check (split by location) found a cheapest-of-16 k-means
// selector at 1.529 b/period vs 1.514 b/period for this single table — the selector was only
// fitting local volatility. Derived from the corpus's pooled delta distribution — see
// server/scripts/derive-wind-speed-delta-codebooks.ts.
const WIND_SPEED_DELTA_WEIGHTS: number[] = [1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 2, 10, 141, 698, 136, 11, 2, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1];

// must mirror WIND_SPEED_BITS in v1.ts (0..15)
export const WIND_SPEED_DELTA = makeDeltaCodec(WIND_SPEED_DELTA_WEIGHTS, 15, "wind-speed-delta");

// ── Freezing-level deltas ───────────────────────────────────────────────────────
// Period-over-period freezing-level change, in quantized steps (see the freeze column in v1.ts:
// 0..15, 304.8 m / 1000 ft steps, so deltas -15..15). Held-out: cheapest-of-16 with a 4-bit
// selector cost 1.371 b/period vs 1.340 b/period for this single table. Derived from the corpus's
// pooled delta distribution — see server/scripts/derive-freeze-delta-codebooks.ts.
const FREEZE_DELTA_WEIGHTS: number[] = [1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 2, 5, 88, 812, 83, 5, 2, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1];

// must mirror the freeze column width in v1.ts (0..15)
export const FREEZE_DELTA = makeDeltaCodec(FREEZE_DELTA_WEIGHTS, 15, "freeze-delta");

// ── Cloud cover deltas ──────────────────────────────────────────────────────────
// Period-over-period cloud-cover change, in quantized steps (see the cloud columns in v1.ts: 0..7,
// 3-bit, so deltas -7..7). Low/mid/high get separate tables (not pooled) — low clouds are
// local/convective and change quickly, high clouds are broad cirrus sheets that persist for hours.
// Held-out (split by location): a cheapest-of-16 k-means selector per level was within 0.01
// b/period of these single tables (low 1.688 vs 1.696, mid 1.826 vs 1.826, high 1.908 vs 1.915) —
// not worth 48 tables and three selectors. Derived from the corpus's pooled per-level delta
// distributions — see server/scripts/derive-cloud-delta-codebooks.ts.
const CLOUD_LOW_DELTA_WEIGHTS: number[] = [11, 5, 6, 10, 13, 18, 36, 804, 36, 18, 12, 9, 6, 5, 11];
const CLOUD_MID_DELTA_WEIGHTS: number[] = [12, 9, 9, 12, 15, 19, 38, 774, 38, 19, 14, 12, 9, 9, 13];
const CLOUD_HIGH_DELTA_WEIGHTS: number[] = [14, 10, 8, 12, 16, 20, 42, 754, 43, 21, 16, 13, 9, 10, 13];

// maxDelta must mirror the cloud column width in v1.ts (0..7)
export const CLOUD_LOW_DELTA = makeDeltaCodec(CLOUD_LOW_DELTA_WEIGHTS, 7, "cloud-low-delta");
export const CLOUD_MID_DELTA = makeDeltaCodec(CLOUD_MID_DELTA_WEIGHTS, 7, "cloud-mid-delta");
export const CLOUD_HIGH_DELTA = makeDeltaCodec(CLOUD_HIGH_DELTA_WEIGHTS, 7, "cloud-high-delta");

// ── Temperature deltas ──────────────────────────────────────────────────────────
// Static Huffman codebooks for period-over-period temp_c change. Symbols are quantized deltas
// -7..7 (indices 0..14) plus an ESCAPE symbol (index 15) for rarer bigger jumps, followed by a raw
// 6-bit signed (bias 32) field covering -32..31°C. Unlike the bounded delta columns above, temp
// KEEPS its cheapest-of-16 selector: temp is the only delta column whose messages span 1h..24h
// resolutions, and the delta shape differs enough by resolution that a held-out check (split by
// location) found the selector worth ~0.20 b/period over a single pooled table (2.776 vs 2.977).
// Derived by k-means clustering per-(forecast × resolution) delta histograms pooled across
// 1h/3h/6h/12h/24h — see server/scripts/derive-temp-delta-codebooks.ts — deliberately NOT keyed by
// resolution: resolution is never on the wire (see v1.ts), and a future dynamic-duration message
// could mix resolutions within one column, so the codebook has to earn its keep on the actual
// delta shape alone. The encoder picks the cheapest per column and stores its index in a 4-bit
// selector.
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
const TEMP_DELTA_ESCAPE_BIAS = 1 << (TEMP_DELTA_ESCAPE_BITS - 1); // 32
// The escape field's raw range. A delta outside it is NOT representable — putInt would silently
// truncate to the low 6 bits and every later temperature in the column would inherit the error, so
// the encoder must clamp into this range and diff later periods against the clamped reconstruction
// (see the temp column in v1.ts).
export const TEMP_DELTA_MIN = -TEMP_DELTA_ESCAPE_BIAS;                      // -32
export const TEMP_DELTA_MAX = (1 << TEMP_DELTA_ESCAPE_BITS) - 1 - TEMP_DELTA_ESCAPE_BIAS; // 31
export const TEMP_DELTA_TABLE_COUNT = TEMP_DELTA_WEIGHTS.length; // 16
export const TEMP_DELTA_TABLE_BITS = 4;

const TEMP_DELTA_TABLES: Table[] = TEMP_DELTA_WEIGHTS.map(buildTable);

function tempDeltaSym(delta: number): number {
  return Math.abs(delta) <= TEMP_DELTA_CORE_RADIUS ? delta + TEMP_DELTA_CORE_RADIUS : TEMP_DELTA_ESCAPE_SYM;
}

// Appends the Huffman code for a period-over-period temp change `delta` (°C) under `table`; jumps
// outside ±7°C fall back to the escape symbol plus a raw 6-bit field. Throws on a delta outside
// TEMP_DELTA_MIN..TEMP_DELTA_MAX — the caller must clamp (see above).
export function encodeTempDelta(bits: number[], table: number, delta: number): void {
  if (delta < TEMP_DELTA_MIN || delta > TEMP_DELTA_MAX)
    throw new Error(`huffman: temp delta ${delta} outside ${TEMP_DELTA_MIN}..${TEMP_DELTA_MAX}`);
  const sym = tempDeltaSym(delta);
  for (const b of TEMP_DELTA_TABLES[table].codes[sym]) bits.push(b);
  if (sym === TEMP_DELTA_ESCAPE_SYM) putInt(bits, delta + TEMP_DELTA_ESCAPE_BIAS, TEMP_DELTA_ESCAPE_BITS);
}

// Reads one Huffman-coded temp delta (under `table`), returning [delta, nextPos].
export function decodeTempDelta(bits: number[], pos: number, table: number): [number, number] {
  const [sym, next] = readSym(TEMP_DELTA_TABLES[table], bits, pos, "temp-delta");
  if (sym === TEMP_DELTA_ESCAPE_SYM) {
    const [raw, after] = takeInt(bits, next, TEMP_DELTA_ESCAPE_BITS);
    return [raw - TEMP_DELTA_ESCAPE_BIAS, after];
  }
  return [sym - TEMP_DELTA_CORE_RADIUS, next];
}

// ── Wire-format freeze ──────────────────────────────────────────────────────────
// Every table above is wire format: re-deriving any of them changes what already-encoded v1
// messages mean, silently — a Huffman decode under drifted tables produces plausible garbage, not
// an error. This bundle exists so test/codebooks.test.ts can pin a digest of it per protocol
// version; change a table (or the temp escape geometry) and that test fails until the protocol
// version is bumped and the new digest recorded. The delta ranges need no separate entries: each
// weight array's length encodes its range (2·maxDelta+1 symbols, +1 escape for temp).
export const V1_CODEBOOKS = {
  weathercode: { bootstrap: BOOTSTRAP_WEIGHTS, weights: WEIGHTS },
  windDir: { bootstrap: WIND_DIR_BOOTSTRAP_WEIGHTS, weights: WIND_DIR_WEIGHTS },
  windSpeedDelta: WIND_SPEED_DELTA_WEIGHTS,
  freezeDelta: FREEZE_DELTA_WEIGHTS,
  cloudLowDelta: CLOUD_LOW_DELTA_WEIGHTS,
  cloudMidDelta: CLOUD_MID_DELTA_WEIGHTS,
  cloudHighDelta: CLOUD_HIGH_DELTA_WEIGHTS,
  tempDelta: {
    weights: TEMP_DELTA_WEIGHTS,
    coreRadius: TEMP_DELTA_CORE_RADIUS,
    escapeBits: TEMP_DELTA_ESCAPE_BITS,
    tableBits: TEMP_DELTA_TABLE_BITS,
  },
} as const;

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
