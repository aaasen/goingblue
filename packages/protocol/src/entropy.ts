// All weight tables live in codebooks.gen.ts, written by `pnpm generate` from the cached corpus —
// never edited by hand. They are wire format; see V1_CODEBOOKS at the bottom of this file.
import {
  WEATHERCODE_BOOTSTRAP_WEIGHTS, WEATHERCODE_WEIGHTS,
  WIND_DIR_BOOTSTRAP_WEIGHTS, WIND_DIR_WEIGHTS,
  WIND_SPEED_DELTA_WEIGHTS, FREEZE_DELTA_WEIGHTS,
  CLOUD_LOW_DELTA_WEIGHTS, CLOUD_MID_DELTA_WEIGHTS, CLOUD_HIGH_DELTA_WEIGHTS,
  TEMP_DELTA_WEIGHTS,
} from "./codebooks.gen.js";
import {
  buildRansTable, symCostBits, ransEncode, ransReader, quantizeFreqs,
  RANS_PROB_BITS, RANS_L, RANS_WORD_BITS,
  type RansTable, type RansOp,
} from "./rans.js";

// ── Entropy-coding substrate (rANS; see rans.ts) ────────────────────────────────
//
// The models below (order-1 contexts, delta alphabets, the temp escape) emit (table, symbol)
// pairs through a SymSink and read them back through a SymSource; the rANS coder underneath
// charges each symbol its exact information content -log2(f/M) — fractional bits — so the peaked
// distributions these tables have (P(delta=0) ≈ 0.7-0.8) cost well under the 1-bit-per-symbol
// floor the previous Huffman substrate could never cross.

// Opaque handle to one symbol table: corpus weights quantized to rANS frequencies.
export type CodeBook = RansTable;

// Where encoded symbols go: `sym` entropy-codes `s` under `book`; `raw` emits exactly `width`
// literal bits via the coder's bypass path (anchors, selectors, FOR/sparse payloads, escape
// payloads — everything that used to be a putInt).
export interface SymSink {
  sym(book: CodeBook, s: number): void;
  raw(v: number, width: number): void;
}

// The decode-side mirror of SymSink. Stateful: each call consumes from the stream in order.
export interface SymSource {
  sym(book: CodeBook): number;
  raw(width: number): number;
  // Throws unless the stream has been consumed exactly — codebook drift or corruption otherwise.
  assertDone(): void;
}

// The model cost of coding `s` under `book`, in fractional bits — for encoder-side candidate
// selection (e.g. chooseTempDeltaTable) and instrumentation; never on the wire.
export function symBits(book: CodeBook, s: number): number {
  return symCostBits(book, s);
}

function buildTable(weights: number[]): CodeBook {
  return buildRansTable(weights);
}

// SymSink over the rANS coder. Ops are collected in decode order (rANS is LIFO, so the coder
// walks them backwards at serialization time); `bits` materializes the encoded stream for
// encodeBodyLE. `cost` is the exact model cost in fractional bits — the actual stream adds the
// coder's constant flush/renormalization overhead on top (~2-4 chars per message, paid once).
export function makeBitSink(): SymSink & { readonly bits: number[]; readonly cost: number } {
  const ops: RansOp[] = [];
  let cost = 0;
  let cached: number[] | null = null;
  return {
    get bits() { return (cached ??= ransEncode(ops)); },
    get cost() { return cost; },
    sym(book, s) { cached = null; ops.push({ table: book, sym: s }); cost += symCostBits(book, s); },
    raw(v, width) { cached = null; ops.push({ raw: v, width }); cost += width; },
  };
}

// SymSource over an encoded body. Trailing zero words dropped by encodeBodyLE are reproduced by
// reads-past-end (see rans.ts); assertDone checks the decoder's state returned exactly to its
// seed, which catches desynced reads (codebook drift, corruption) that would otherwise return
// plausible garbage silently.
export function makeBitSource(bits: number[]): SymSource {
  return ransReader(bits);
}

// ── Codec factories ─────────────────────────────────────────────────────────────

// Order-1 conditional codec: each symbol is coded under a table keyed by the *previously decoded*
// symbol — context both encoder and decoder already have, so it costs no header bits — or by the
// bootstrap table for the first symbol of a sequence (no predecessor).
function makeConditionalCodec(bootstrapWeights: number[], weights: number[][]) {
  const tables = weights.map(buildTable);
  const bootstrap = buildTable(bootstrapWeights);
  return {
    encode(sink: SymSink, prevSym: number | null, sym: number): void {
      sink.sym(prevSym === null ? bootstrap : tables[prevSym], sym);
    },
    decode(src: SymSource, prevSym: number | null): number {
      return src.sym(prevSym === null ? bootstrap : tables[prevSym]);
    },
  };
}

// Single-table delta codec for a bounded quantized domain 0..maxDelta: the full delta range
// -maxDelta..maxDelta (2·maxDelta+1 symbols) fits directly in the alphabet — no escape/raw-payload
// fallback needed. One shared table, no per-message selector: held-out checks (see the derive
// scripts) found delta shape doesn't vary enough by location/season/level for a cheapest-of-k
// selector to pay for itself — everywhere is dominated by "usually 0, occasionally ±1".
export interface DeltaCodec {
  encode(sink: SymSink, delta: number): void;
  decode(src: SymSource): number;
}

function makeDeltaCodec(weights: number[], maxDelta: number): DeltaCodec {
  const table = buildTable(weights);
  return {
    encode(sink: SymSink, delta: number): void {
      sink.sym(table, delta + maxDelta);
    },
    decode(src: SymSource): number {
      return src.sym(table) - maxDelta;
    },
  };
}

// ── Weathercode ─────────────────────────────────────────────────────────────────
// Static, order-1 codebooks for the weathercode column. Weather persists hour-to-hour far
// more than it varies by climate/region (a "clear" hour is followed by "clear" 85% of the time
// regardless of location). Derived from the corpus's prev-symbol -> next-symbol transition counts —
// see server/scripts/derive-weathercode-codebooks.ts. Symbols are WMO indices (0..27), mapping
// to WMO_CODES; every table assigns a code to every symbol so any outlier is representable.
//
// WEATHERCODE_BOOTSTRAP_WEIGHTS is the distribution of the *first* weathercode of a sequence
// (no predecessor to key off of); WEATHERCODE_WEIGHTS[prevSym] is the codebook for the symbol
// that follows `prevSym` (frequency weights, one per WMO index, all > 0 — a prevSym never
// observed as a predecessor in the corpus falls back to the corpus-wide marginal distribution).
// WMO index legend: 0 clear · 1-3 cloud · 4-5 fog · 6-8 drizzle · 9-10 freezing drizzle ·
// 11-13 rain · 14-15 freezing rain · 16-19 snow · 20-22 rain showers · 23-24 snow showers ·
// 25-27 thunderstorm.
const WEATHERCODE_CODEC = makeConditionalCodec(WEATHERCODE_BOOTSTRAP_WEIGHTS, WEATHERCODE_WEIGHTS);

// Emits the code for `wmoIdx`, under the table keyed by `prevSym` — the
// previously decoded symbol, or null for the first symbol of a sequence (no predecessor).
export const encodeWeathercode = WEATHERCODE_CODEC.encode;

// Reads one coded weathercode keyed by `prevSym` (see encodeWeathercode).
export const decodeWeathercode = WEATHERCODE_CODEC.decode;

// ── Wind direction ──────────────────────────────────────────────────────────────
// Static, order-1 codebooks for the 8-point wind direction (symbols are direction indices
// 0..7; see CARDINALS). Wind direction persists hour-to-hour far more than it varies by regime (see
// server/scripts/analyze-wind-dir-transitions.ts: P(next=prev) 68-90% depending on level), so like
// weathercode, each direction is coded under a table keyed by the previously decoded direction.
// One shared codebook set across all four wind levels (surface + 500/600/700 hPa): pooling the
// transition counts across levels barely changes the bit cost vs. deriving separate tables per
// level (<0.01 b/dir), so a single set keeps things simple and lets every wind column reuse it —
// each column tracks its own previous-direction context independently (a separate chain per wind
// level). Derived from the corpus's pooled prev-direction -> next-direction transition counts —
// see server/scripts/derive-wind-dir-codebooks.ts. WIND_DIR_WEIGHTS[prevDir] is the codebook for
// the direction that follows `prevDir`.
const WIND_DIR_CODEC = makeConditionalCodec(WIND_DIR_BOOTSTRAP_WEIGHTS, WIND_DIR_WEIGHTS);

// Emits the code for direction index `dirIdx` (0..7), under the table keyed by
// `prevDir` — the previously decoded direction, or null for the first direction of a sequence (no
// predecessor).
export const encodeWindDir = WIND_DIR_CODEC.encode;

// Reads one coded direction keyed by `prevDir` (see encodeWindDir).
export const decodeWindDir = WIND_DIR_CODEC.decode;

// ── Wind speed deltas ───────────────────────────────────────────────────────────
// Period-over-period wind-speed change, in quantized steps (see WIND_SPEED_BITS in v1.ts: 0..15,
// so deltas -15..15). One table pooled across all four wind levels (surface + 500/600/700 hPa) —
// same call as wind direction. A held-out check (split by location) found a cheapest-of-16 k-means
// selector at 1.529 b/period vs 1.514 b/period for this single table — the selector was only
// fitting local volatility. Derived from the corpus's pooled delta distribution — see
// server/scripts/derive-wind-speed-delta-codebooks.ts.

// must mirror WIND_SPEED_BITS in v1.ts (0..15)
export const WIND_SPEED_DELTA = makeDeltaCodec(WIND_SPEED_DELTA_WEIGHTS, 15);

// ── Freezing-level deltas ───────────────────────────────────────────────────────
// Period-over-period freezing-level change, in quantized steps (see the freeze column in v1.ts:
// 0..15, 304.8 m / 1000 ft steps, so deltas -15..15). Held-out: cheapest-of-16 with a 4-bit
// selector cost 1.371 b/period vs 1.340 b/period for this single table. Derived from the corpus's
// pooled delta distribution — see server/scripts/derive-freeze-delta-codebooks.ts.

// must mirror the freeze column width in v1.ts (0..15)
export const FREEZE_DELTA = makeDeltaCodec(FREEZE_DELTA_WEIGHTS, 15);

// ── Cloud cover deltas ──────────────────────────────────────────────────────────
// Period-over-period cloud-cover change, in quantized steps (see the cloud columns in v1.ts: 0..7,
// 3-bit, so deltas -7..7). Low/mid/high get separate tables (not pooled) — low clouds are
// local/convective and change quickly, high clouds are broad cirrus sheets that persist for hours.
// Held-out (split by location): a cheapest-of-16 k-means selector per level was within 0.01
// b/period of these single tables (low 1.688 vs 1.696, mid 1.826 vs 1.826, high 1.908 vs 1.915) —
// not worth 48 tables and three selectors. Derived from the corpus's pooled per-level delta
// distributions — see server/scripts/derive-cloud-delta-codebooks.ts.

// maxDelta must mirror the cloud column width in v1.ts (0..7)
export const CLOUD_LOW_DELTA = makeDeltaCodec(CLOUD_LOW_DELTA_WEIGHTS, 7);
export const CLOUD_MID_DELTA = makeDeltaCodec(CLOUD_MID_DELTA_WEIGHTS, 7);
export const CLOUD_HIGH_DELTA = makeDeltaCodec(CLOUD_HIGH_DELTA_WEIGHTS, 7);

// ── Temperature deltas ──────────────────────────────────────────────────────────
// Static codebooks for period-over-period temp_c change. Symbols are quantized deltas
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

export const TEMP_DELTA_CORE_RADIUS = 7;
const TEMP_DELTA_ESCAPE_SYM = 2 * TEMP_DELTA_CORE_RADIUS + 1; // 15
export const TEMP_DELTA_ESCAPE_BITS = 6;
const TEMP_DELTA_ESCAPE_BIAS = 1 << (TEMP_DELTA_ESCAPE_BITS - 1); // 32
// The escape field's raw range. A delta outside it is NOT representable — encodeTempDelta (and
// the coder's raw bypass beneath it) refuses to emit it rather than truncating, so the encoder
// must clamp into this range and diff later periods against the clamped reconstruction
// (see the temp column in v1.ts).
export const TEMP_DELTA_MIN = -TEMP_DELTA_ESCAPE_BIAS;                      // -32
export const TEMP_DELTA_MAX = (1 << TEMP_DELTA_ESCAPE_BITS) - 1 - TEMP_DELTA_ESCAPE_BIAS; // 31
export const TEMP_DELTA_TABLE_COUNT = TEMP_DELTA_WEIGHTS.length; // 16
export const TEMP_DELTA_TABLE_BITS = 4;

const TEMP_DELTA_TABLES: CodeBook[] = TEMP_DELTA_WEIGHTS.map(buildTable);

function tempDeltaSym(delta: number): number {
  return Math.abs(delta) <= TEMP_DELTA_CORE_RADIUS ? delta + TEMP_DELTA_CORE_RADIUS : TEMP_DELTA_ESCAPE_SYM;
}

// Emits the code for a period-over-period temp change `delta` (°C) under `table`; jumps outside
// ±7°C fall back to the escape symbol plus a raw 6-bit field. Throws on a delta outside
// TEMP_DELTA_MIN..TEMP_DELTA_MAX — the caller must clamp (see above).
export function encodeTempDelta(sink: SymSink, table: number, delta: number): void {
  if (delta < TEMP_DELTA_MIN || delta > TEMP_DELTA_MAX)
    throw new Error(`entropy: temp delta ${delta} outside ${TEMP_DELTA_MIN}..${TEMP_DELTA_MAX}`);
  const sym = tempDeltaSym(delta);
  sink.sym(TEMP_DELTA_TABLES[table], sym);
  if (sym === TEMP_DELTA_ESCAPE_SYM) sink.raw(delta + TEMP_DELTA_ESCAPE_BIAS, TEMP_DELTA_ESCAPE_BITS);
}

// Reads one coded temp delta (under `table`).
export function decodeTempDelta(src: SymSource, table: number): number {
  const sym = src.sym(TEMP_DELTA_TABLES[table]);
  if (sym === TEMP_DELTA_ESCAPE_SYM) return src.raw(TEMP_DELTA_ESCAPE_BITS) - TEMP_DELTA_ESCAPE_BIAS;
  return sym - TEMP_DELTA_CORE_RADIUS;
}

// ── Wire-format freeze ──────────────────────────────────────────────────────────
// Every table above is wire format: re-deriving any of them changes what already-encoded v1
// messages mean, silently — a decode under drifted tables produces plausible garbage, not an
// error. This bundle exists so test/codebooks.test.ts can pin a digest of it per protocol
// version; change a table (or the temp escape geometry, or the coder geometry) and that test
// fails until the protocol version is bumped and the new digest recorded.
//
// What's pinned is the *quantized* frequencies — the exact tables the coder runs on — not the
// raw corpus weights, so drift in quantizeFreqs itself trips the same tripwire as a weight
// change. The delta ranges need no separate entries: each frequency array's length encodes its
// range (2·maxDelta+1 symbols, +1 escape for temp).
const qf = (w: number[]) => quantizeFreqs(w);
export const V1_CODEBOOKS = {
  rans: { probBits: RANS_PROB_BITS, stateLow: RANS_L, wordBits: RANS_WORD_BITS },
  weathercode: { bootstrap: qf(WEATHERCODE_BOOTSTRAP_WEIGHTS), weights: WEATHERCODE_WEIGHTS.map(qf) },
  windDir: { bootstrap: qf(WIND_DIR_BOOTSTRAP_WEIGHTS), weights: WIND_DIR_WEIGHTS.map(qf) },
  windSpeedDelta: qf(WIND_SPEED_DELTA_WEIGHTS),
  freezeDelta: qf(FREEZE_DELTA_WEIGHTS),
  cloudLowDelta: qf(CLOUD_LOW_DELTA_WEIGHTS),
  cloudMidDelta: qf(CLOUD_MID_DELTA_WEIGHTS),
  cloudHighDelta: qf(CLOUD_HIGH_DELTA_WEIGHTS),
  tempDelta: {
    weights: TEMP_DELTA_WEIGHTS.map(qf),
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
      total += symBits(TEMP_DELTA_TABLES[t], sym) + (sym === TEMP_DELTA_ESCAPE_SYM ? TEMP_DELTA_ESCAPE_BITS : 0);
    }
    if (total < bestBits) { bestBits = total; best = t; }
  }
  return best;
}
