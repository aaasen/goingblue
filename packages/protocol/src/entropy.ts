// All weight tables live in codebooks.gen.ts, written by the derive pipeline (`pnpm generate`)
// — never edited by hand. They are wire format; see V3_CODEBOOKS at the bottom of this file.
import {
  WEATHERCODE_BOOTSTRAP_WEIGHTS, WEATHERCODE_WEIGHTS,
  WIND_DIR_BOOTSTRAP_WEIGHTS, WIND_DIR_WEIGHTS_BY_RES, WIND_DIR_UPPER_WEIGHTS_BY_RES,
  WIND_SPEED_DELTA_WEIGHTS_BY_RES_LEVEL, WIND_SPEED_UPPER_DELTA_WEIGHTS_BY_RES,
  FREEZE_DELTA_WEIGHTS_BY_RES, FREEZE_DELTA_TEMP_WEIGHTS_BY_RES,
  GUST_DELTA_WEIGHTS_BY_RES, SFC_DELTA_GUST_WEIGHTS_BY_RES,
  CLOUD_BAND_WEIGHTS_BY_LEVEL_PREV,
  TEMP_DELTA_BOOTSTRAP_WEIGHTS, TEMP_DELTA_WEIGHTS_BY_RES,
  PRECIP_BOOTSTRAP_WEIGHTS, PRECIP_WEIGHTS_BY_RES,
  SNOW_BOOTSTRAP_WEIGHTS, SNOW_WEIGHTS_BY_RES,
  RAIN_BOOTSTRAP_WEIGHTS, RAIN_WEIGHTS_BY_RES,
  AQ_PM25_DELTA_WEIGHTS_BY_RES, AQ_O3_DELTA_WEIGHTS_BY_RES, AQI_DELTA_WEIGHTS_BY_RES,
  AQI_EU_DELTA_WEIGHTS_BY_RES, AQI_EU_PM25_DELTA_WEIGHTS_BY_RES, AQI_RESIDUAL_WEIGHTS_BY_MASK_RES,
  AQ_PM10_DELTA_WEIGHTS_BY_RES, AQ_NO2_DELTA_WEIGHTS_BY_RES, AQ_SO2_DELTA_WEIGHTS_BY_RES,
  AQI_EU_PM10_DELTA_WEIGHTS_BY_RES, AQI_EU_NO2_DELTA_WEIGHTS_BY_RES,
  AQI_EU_O3_DELTA_WEIGHTS_BY_RES, AQI_EU_SO2_DELTA_WEIGHTS_BY_RES,
  AQI_EU_RESIDUAL_WEIGHTS_BY_MASK_RES,
  AQ_DOMINANT_BOOTSTRAP_WEIGHTS, AQ_DOMINANT_WEIGHTS,
  AQ_DOMINANT_EU_BOOTSTRAP_WEIGHTS, AQ_DOMINANT_EU_WEIGHTS,
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
// selection (e.g. the codebook-class try-all-pick-best) and instrumentation; never on the wire.
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

// ── Wire-format context functions ───────────────────────────────────────────────

// The weathercode collapsed to a 4-class precipitation regime — WIRE FORMAT: the wet columns
// (precip/snow/rain) key their codebooks on the SAME period's class, which they may do for free
// because weathercode decodes first and is always present (the same trick the 600/700 hPa wind
// columns play on the upper level). Indexed by WMO *symbol index* (0..29, position in WMO_CODES),
// never by the raw input code: the encoder maps an unrecognized input code to index 0
// (`WMO2IDX[...] ?? 0`), so a class taken from the raw code would diverge from the one the decoder
// derives from the symbol it actually read.
//   0 dry (clear/cloud/fog) · 1 rain-ish (drizzle/rain/showers/thunder) ·
//   2 freezing (freezing drizzle/rain) · 3 snow-ish (snow/snow showers/mixed)
//
// The mixed codes 68/69 join snow-ish rather than taking a fifth class of their own: held-out,
// a fifth class moved the three wet columns by -0.003 b/period total (analyze-wc-aggregation-
// heldout.ts) while widening every wet-column table by 25% and dropping their minimum
// per-context training occupancy to zero. Not a trade worth making for ~0.8% of periods.
export const WC_CLASSES = 4;
export const WEATHERCODE_CLASS: readonly number[] = [
  //  0  1  2  3 45 48 51 53 55 56 57 61 63 65 66 67 71 73 75 77 80 81 82 85 86 95 96 99  ← WMO code
  0, 0, 0, 0, 0, 0, 1, 1, 1, 2, 2, 1, 1, 1, 2, 2, 3, 3, 3, 3, 1, 1, 1, 3, 3, 1, 1, 1,
  // 68 69  ← appended after 99, matching WMO_CODES' append-only order
  3, 3,
];

const NDIR = 8;

// ── Wind speed scale ────────────────────────────────────────────────────────────
// Every wind speed column (surface, gust, 500/600/700 hPa) quantizes to the EXTENDED BEAUFORT
// scale: forces 0..17, band lower bounds in km/h below — the standard 13 forces plus the
// force 13..17 extension so hurricane-force gusts and jet winds don't clip (corpus maxima:
// gust 225, 500 hPa 293 kph; force 17 is ≥202). Chosen 2026-07-31 over linear and sqrt/lin-log
// companded scales (held-out sfc+gust 2.638 vs 3.595 b/period under linear 5 kph — see
// analyze-wind-scale-heldout.ts): Beaufort bands track perceptible wind differences, which is
// also where the delta probability mass moves. Decoded values are band midpoints (kph); the
// bounds are wire format and pinned in V3_CODEBOOKS below.
export const BEAUFORT_KPH_LOWER: readonly number[] =
  [0, 1, 6, 12, 20, 29, 39, 50, 62, 75, 89, 103, 118, 134, 150, 167, 184, 202];
export const BEAUFORT_MAX = BEAUFORT_KPH_LOWER.length - 1; // 17
export function quantWind(kph: number): number {
  let f = 0;
  while (f < BEAUFORT_MAX && kph >= BEAUFORT_KPH_LOWER[f + 1]) f++;
  return f;
}
// Band midpoint for decode; force 0 is calm (0), force 17's open band reads as ~211 kph.
export function beaufortMidKph(force: number): number {
  if (force <= 0) return 0;
  if (force >= BEAUFORT_MAX) return 211;
  return (BEAUFORT_KPH_LOWER[force] + BEAUFORT_KPH_LOWER[force + 1]) / 2;
}
// Direction symbols are calm-gated at force ≤ 1 (< 6 kph, ≈ the old sub-one-step gate) —
// direction down there is weather-model dither.
export const CALM_MAX_FORCE = 1;

// Wind speed deltas: -17..17 over the force domain (35 symbols), shared by every wind column.
export const WIND_SPEED_DELTA_MAX = BEAUFORT_MAX;

// Buckets an upper-level same-period speed delta for table selection (must match the derive
// script): ≤-2, -1, 0, +1, ≥+2.
export function upperDeltaBucket(d: number): number {
  return d <= -2 ? 0 : d === -1 ? 1 : d === 0 ? 2 : d === 1 ? 3 : 4;
}
export const N_UPPER_BUCKETS = 5;

// How far apart, in WIND_LEVELS_HPA rungs, a pressure-level wind column and the served level it
// conditions on sit: adjacent (1), one rung skipped (2), or further (3+). Levels share the
// synoptic flow less the further apart they are, so the upper-conditioned wind tables are keyed
// by this class (must match the derive scripts). Classes 0..N_WIND_GAPS-1.
export const N_WIND_GAPS = 3;
export function windGapClass(gap: number): number {
  return Math.min(Math.max(gap, 1), N_WIND_GAPS) - 1;
}

// must mirror the freeze column width in v3.ts (0..31)
export const FREEZE_DELTA_MAX = 31;

// Previous-value buckets for the accumulation columns: 0 | 1-3 | 4-9 | 10-20 | 21+.
// Must match ACCUM_BUCKET_EDGES in derive-precip-accum-codebooks.ts.
const ACCUM_BUCKET_EDGES = [1, 4, 10, 21];
function accumBucket(v: number): number {
  let b = 0;
  for (const e of ACCUM_BUCKET_EDGES) { if (v < e) break; b++; }
  return b;
}

export const TEMP_DELTA_CORE_RADIUS = 7;
const TEMP_DELTA_ESCAPE_SYM = 2 * TEMP_DELTA_CORE_RADIUS + 1; // 15
export const TEMP_DELTA_ESCAPE_BITS = 6;
const TEMP_DELTA_ESCAPE_BIAS = 1 << (TEMP_DELTA_ESCAPE_BITS - 1); // 32
// The escape field's raw range. A delta outside it is NOT representable — encodeTempDelta (and
// the coder's raw bypass beneath it) refuses to emit it rather than truncating, so the encoder
// must clamp into this range and diff later periods against the clamped reconstruction
// (see the temp column in v3.ts).
export const TEMP_DELTA_MIN = -TEMP_DELTA_ESCAPE_BIAS;                      // -32
export const TEMP_DELTA_MAX = (1 << TEMP_DELTA_ESCAPE_BITS) - 1 - TEMP_DELTA_ESCAPE_BIAS; // 31

// Previous decoded delta (post-clamp reconstruction), 5 buckets: ≤-2 | -1 | 0 | +1 | ≥+2.
export const TEMP_DELTA_PREV_BUCKETS = 5;
const TEMP_DELTA_PREV_EDGES = [-1, 0, 1, 2];
export function tempDeltaBucket(prevDelta: number): number {
  let b = 0;
  for (const e of TEMP_DELTA_PREV_EDGES) { if (prevDelta < e) break; b++; }
  return b;
}

// Time-of-day of the ARRIVING period's midpoint, 8 uniform 3-hour buckets over the local day.
// Takes local half-hours (period start ×2 + span in hours stays integral for every resolution).
export const TEMP_DELTA_TOD_BUCKETS = 8;
export function tempTodBucket(localHalfHours: number): number {
  return Math.floor((((localHalfHours % 48) + 48) % 48) / 6);
}

function tempDeltaSym(delta: number): number {
  return Math.abs(delta) <= TEMP_DELTA_CORE_RADIUS ? delta + TEMP_DELTA_CORE_RADIUS : TEMP_DELTA_ESCAPE_SYM;
}

// ── Air quality index ladders ───────────────────────────────────────────────────
// Both AQ scales quantize to a 25-band ladder plus symbol 0 = NO DATA, so 26 symbols fit the same
// 5-bit anchor the wind columns use. The bands are non-uniform, spending resolution where the
// corpus mass and the decisions both are: the top of each ladder is one open band, since the
// difference between 400 and 500 US AQI changes nothing a reader would do. Symbol 0 covers an
// isolated upstream null and a failed air-quality fetch alike — without it a missing hour would
// have to encode as band 1, which reads as the cleanest air there is. These bounds are wire
// format and pinned in V3_CODEBOOKS below.
//
// The two ladders are NOT interchangeable. The US EPA index runs 0-500 with its categories at
// 50/100/150/200/300; the European index runs 0-100+ with categories every 20 and uses a 24h
// running mean for particulates (which is why the European PM2.5 column is so much smoother than
// the instantaneous US one). Passing a value to the wrong ladder silently misreports the air.
export const AQI_US_LOWER: readonly number[] =
  [0, 5, 10, 15, 20, 25, 30, 35, 40, 45, 50, 60, 70, 80, 90, 100, 120, 140, 160, 180, 200, 250, 300, 400, 500];
export const AQI_EU_LOWER: readonly number[] =
  [0, 4, 8, 12, 16, 20, 24, 28, 32, 36, 40, 45, 50, 55, 60, 70, 80, 90, 100, 120, 150, 200, 300, 400, 500];

// Symbol 0 is "no data"; the bands occupy 1..AQI_MAX_SYM.
export const AQI_NO_DATA = 0;
export const AQI_MAX_SYM = AQI_US_LOWER.length; // 25

// Period-over-period deltas span the whole ladder in both directions (-25..25), but the ends are
// nearly unvisited: across every resolution in the corpus, |delta| > 7 happens in 0.003% (US
// PM2.5) to 0.05% (US ozone) of periods. So the alphabet is the temp column's shape — a ±7 core
// plus one ESCAPE symbol followed by a raw 6-bit field — which costs ~0.006 b/period and keeps
// each conditioned table 16 symbols wide instead of 51. Three of the five AQ tables are
// res × tod × prevΔ, so that is the difference between ~33k and ~10k generated weights.
export const AQI_DELTA_CORE_RADIUS = 7;
export const AQI_DELTA_NSYM = 2 * AQI_DELTA_CORE_RADIUS + 2; // 16: 15 core + escape
const AQI_DELTA_ESCAPE_SYM = AQI_DELTA_NSYM - 1;
export const AQI_DELTA_ESCAPE_BITS = 6;
const AQI_DELTA_ESCAPE_BIAS = 1 << (AQI_DELTA_ESCAPE_BITS - 1); // 32, so the field spans -32..31
export function aqiDeltaSym(delta: number): number {
  return Math.abs(delta) <= AQI_DELTA_CORE_RADIUS ? delta + AQI_DELTA_CORE_RADIUS : AQI_DELTA_ESCAPE_SYM;
}

// Emits one period-over-period AQI ladder step under `book`. The ladder bounds the delta to
// ±AQI_MAX_SYM (±25), which the escape field's -32..31 covers with room to spare, so unlike the
// temp column there is nothing for the caller to clamp.
export function encodeAqiDelta(sink: SymSink, book: CodeBook, delta: number): void {
  const sym = aqiDeltaSym(delta);
  sink.sym(book, sym);
  if (sym === AQI_DELTA_ESCAPE_SYM) sink.raw(delta + AQI_DELTA_ESCAPE_BIAS, AQI_DELTA_ESCAPE_BITS);
}

export function decodeAqiDelta(src: SymSource, book: CodeBook): number {
  const sym = src.sym(book);
  if (sym === AQI_DELTA_ESCAPE_SYM) return src.raw(AQI_DELTA_ESCAPE_BITS) - AQI_DELTA_ESCAPE_BIAS;
  return sym - AQI_DELTA_CORE_RADIUS;
}

// The headline residual `index − max(sub-index)` is non-negative by construction (the headline
// is the max over sub-indices the wire already carries) and can reach the top of the ladder.
export const AQI_RESIDUAL_MAX = AQI_MAX_SYM;

// ── The headline residual's baseline ─────────────────────────────────────────────
// Each headline IS the max over its scale's sub-indices — over 52M corpus periods it exceeds that
// max in 0.00% of them, on both scales. So when the wire already carries some of those
// sub-indices, the headline can be coded as a residual against their max instead of as its own
// delta series. How well that works depends entirely on how much of the LEADERSHIP MASS the
// carried subset covers (share of periods where each constituent is the max):
//
//   US   pm2.5 56.9%   ozone 40.3%   pm10 2.8%   no2/so2/co 0.0%
//   EU   ozone 68.6%   pm2.5 23.1%   pm10 8.3%   no2 0.1%   so2 0.0%
//
// Only PM2.5, ozone and PM10 ever lead — the same three on both scales, in different order — so
// only those three key the residual tables. NO2/SO2/CO are carried as columns but never as
// context: adding NO2 to the US baseline measured 0.275 b/period, bit-for-bit identical to
// leaving it out. The key is a 3-bit presence mask over the three, so each of the 7 non-empty
// combinations gets its own fitted table rather than one table averaged over all of them.
export const AQI_BASE_PM25 = 1;
export const AQI_BASE_O3 = 2;
export const AQI_BASE_PM10 = 4;
export const AQI_BASE_MASKS = 8; // 0..7; mask 0 (none carried) has no residual table

// WHICH masks actually code as a residual. A baseline covering only one constituent is far WORSE
// than the headline's own deltas — the residual is then nonzero in every period something else
// leads (96% of them for US PM10) and spans the whole ladder, while the headline's own series is
// smooth. Held-out b/period, residual vs own-deltas (US 0.935, EU 1.180):
//
//   mask            US resid          EU resid
//   pm2.5             2.273  ✗          3.269  ✗
//   ozone             2.832  ✗          1.718  ✗
//   pm10              3.085  ✗          3.377  ✗
//   pm2.5+ozone       0.275  ✓          0.653  ✓
//   pm2.5+pm10        2.185  ✗          3.100  ✗
//   ozone+pm10        2.501  ✗          0.978  ✓
//   all three         0.036  ✓          0.040  ✓
//
// Both sides derive the mask from vars_mask, so choosing the mode costs zero wire bits — the same
// context-availability switch freezeDeltaBook (temp present/absent) and sfcSpeedBook (gust
// present/absent) use, with 8 states instead of 2. Pinned here rather than emitted by the derive
// pipeline so a regeneration can't silently flip a mode and change the wire format; the closest
// call is EU ozone+pm10 at 0.978 vs 1.180, a comfortable margin.
// ── The dominant pollutant ───────────────────────────────────────────────────────
// Each scale's constituents IN WIRE ORDER: a headline's dominant-pollutant symbol is a position
// in this list, so the order is wire format. The first three are the ones that ever lead (and the
// ones the residual keys on); the rest are here because the headline's max is taken over them and
// a symbol that could never be emitted would be a lie about what the index means. US carbon
// monoxide has NO column of its own (see VARS_BIT) but keeps its symbol for exactly that reason.
export const AQ_DOMINANT_US: readonly string[] = ["pm2.5", "ozone", "pm10", "no2", "so2", "co"];
export const AQ_DOMINANT_EU: readonly string[] = ["pm2.5", "ozone", "pm10", "no2", "so2"];

// Each alphabet carries ONE MORE symbol than it has pollutants: an explicit "unknown", emitted
// when the headline has a reading but the constituents behind it don't, so the column never has
// to invent an attribution. Upstream returning a headline without its parts is rare enough that
// the corpus barely sees it — which is the point: a symbol that costs nothing when unused is a
// better answer than naming PM2.5 because it happens to be index 0. Decodes to an absent field,
// which the app draws as "—", the same as a period with no reading at all.
export const aqDominantUnknown = (names: readonly string[]): number => names.length;
export const aqDominantNSym = (names: readonly string[]): number => names.length + 1;

// The identity is coded order-1 on the PREVIOUS period's dominant, which is where nearly all of
// the structure is — the leading pollutant persists. Held-out b/period: marginal 1.139 (US) /
// 1.151 (EU), order-1 0.252 / 0.254. Adding resolution and time-of-day axes measured 0.239/0.244
// and 0.225/0.230 — 0.013 to 0.027, under the bar the cross-variable work set, so neither axis is
// carried. The column's first period has no predecessor and uses a bootstrap table: unlike the AQ
// delta columns (whose first symbol looks like "no change"), the marginal and the conditioned
// distributions differ by 0.9 b/period here, far too much to share a row.
const residualModeSet = (...masks: number[]) => new Set(masks);
export const AQI_US_RESIDUAL_MASKS: ReadonlySet<number> = residualModeSet(
  AQI_BASE_PM25 | AQI_BASE_O3,
  AQI_BASE_PM25 | AQI_BASE_O3 | AQI_BASE_PM10,
);
export const AQI_EU_RESIDUAL_MASKS: ReadonlySet<number> = residualModeSet(
  AQI_BASE_PM25 | AQI_BASE_O3,
  AQI_BASE_O3 | AQI_BASE_PM10,
  AQI_BASE_PM25 | AQI_BASE_O3 | AQI_BASE_PM10,
);

// Quantize an index value onto one of the ladders. null/undefined — an hour the upstream model
// didn't forecast — is AQI_NO_DATA, never band 1.
export function quantAqi(value: number | null | undefined, lower: readonly number[]): number {
  if (value == null || Number.isNaN(value)) return AQI_NO_DATA;
  let b = 1;
  while (b < lower.length && value >= lower[b]) b++;
  return b;
}

// Band representative for decode: the midpoint, except the open top band, which reads as its own
// lower bound. AQI_NO_DATA has no value — the caller leaves the field undefined.
export function aqiMid(sym: number, lower: readonly number[]): number | undefined {
  if (sym <= AQI_NO_DATA || sym > lower.length) return undefined;
  if (sym === lower.length) return lower[sym - 1];
  return Math.round((lower[sym - 1] + lower[sym]) / 2);
}

// ── The codebooks ───────────────────────────────────────────────────────────────
// The complete set of table-lookup functions the v3 body codec keys symbols with, built once
// from the global (train-corpus-wide) tables in codebooks.gen.ts. (An EM-learned 8-class
// selectable-table-set scheme lived here until 2026-08-20 — held-out it bought −2.4% body bits
// for 8× encoder passes, ~4/5 of the shipped table bytes, and a second corpus-scan pipeline
// stage; removed as not worth the complexity.)
export interface Books {
  // Emits/reads the code for a weathercode symbol under the table keyed by `prevSym` — the
  // previously decoded symbol, or null for the first symbol of a sequence (bootstrap). Weather
  // persists hour-to-hour far more than it varies by climate/region, hence order-1 tables (see
  // codec-server/scripts/derive-weathercode-codebooks.ts).
  encodeWeathercode(sink: SymSink, prevSym: number | null, sym: number): void;
  decodeWeathercode(src: SymSource, prevSym: number | null): number;
  // The codebook for one direction symbol. `prev` is the last direction encoded in this column
  // (null for the column's first — bootstrap), `upper` the upper level's same-period displayed
  // direction (null when that column is absent or this level has none), `gap` the ladder
  // distance to that level (see windGapClass). See
  // codec-server/scripts/derive-wind-dir-codebooks.ts for the context ladder.
  windDirBook(res: number, prev: number | null, upper: number | null, gap: number): CodeBook;
  // The codebook for one speed delta. `level` indexes the unconditioned table axis (0 = surface,
  // 1 + WIND_LEVELS_HPA index for the pressure levels); `upperDelta` is the served level above's
  // same-period delta (null when there is none), `gap` the ladder distance to it. See
  // codec-server/scripts/derive-wind-speed-delta-codebooks.ts.
  windSpeedBook(res: number, level: number, upperDelta: number | null, gap: number): CodeBook;
  // The codebook for one gust delta. Gust decodes FIRST among the wind columns (no context of
  // its own) — chosen so the surface column can lean on it, and can one day become optional
  // without touching gust. See codec-server/scripts/derive-gust-delta-codebooks.ts.
  gustDeltaBook(res: number): CodeBook;
  // The codebook for one SURFACE wind speed delta. `gustDelta` is the gust column's same-period
  // decoded delta (free context — gusts and sustained wind move together), or null when gust is
  // absent from vars_mask, which falls back to the unconditioned [res][level 0] wind table.
  sfcSpeedBook(res: number, gustDelta: number | null): CodeBook;
  // The codebook for one freeze delta. `tempDelta` is the same period's decoded temp delta (the
  // post-clamp reconstruction, never the raw input), or null when temp is absent from vars_mask
  // — the res-keyed fallback (the tempΔ marginal). The freezing level is where the 0°C isotherm
  // sits, so it moves with the airmass temperature, and temp decodes first, making its delta
  // free context. See codec-server/scripts/derive-freeze-delta-codebooks.ts.
  freezeDeltaBook(res: number, tempDelta: number | null): CodeBook;
  // The codebook for one cloud-band cover step (0..7 quantized VALUE symbols, order-1): keyed
  // by (CLOUD_BAND_LEVELS_HPA index, the level's own previous decoded step). Persistence varies
  // with height (a 300 hPa cirrus sheet and a 1000 hPa deck are not the same process), so the
  // levels are not pooled — and the previous value is the dominant context: the RH-diagnostic
  // fill pins levels at exactly 0 for long runs, so "was clear" reshapes the whole next-step
  // distribution (held-out −27% vs unconditioned per-level deltas). Each model's first period
  // is a raw 3-bit anchor, not a symbol under these tables. Trained on the post-fillCloudBand
  // stack at the band's serving resolutions only (3h/1h — see cloudBandPeriodCount in v3.ts).
  // See codec-server/scripts/derive-cloud-delta-codebooks.ts.
  cloudBandBook(level: number, prev: number): CodeBook;
  // Order-1 codebooks over the wet columns' quantized VALUES (not deltas — zero is an absorbing
  // regime), keyed by (resolution, SAME-period weathercode class, previous decoded value) —
  // bootstrap for a column's first cell. Rain/snow key on a BUCKET of the previous value (see
  // accumBucket). See codec-server/scripts/derive-precip-accum-codebooks.ts.
  precipBook(res: number, wcClass: number, prev: number | null): CodeBook;
  snowBook(res: number, wcClass: number, prev: number | null): CodeBook;
  rainBook(res: number, wcClass: number, prev: number | null): CodeBook;
  // The codebook for one temp delta. `tod` is the arriving period's tempTodBucket; `prevDelta`
  // the previous decoded delta in this column — the post-clamp reconstruction, never the raw
  // input — or null for the column's first delta (bootstrap). The diurnal cycle drives the delta
  // sign; the previous delta adds the airmass's actual trajectory. See
  // codec-server/scripts/derive-temp-delta-codebooks.ts.
  tempDeltaBook(res: number, tod: number, prevDelta: number | null): CodeBook;
  // Air quality. Every AQ book is CLASS-INDEPENDENT — see AQ_BOOKS below — so these five resolve
  // to the same tables whichever class the header selected. `prevDelta` is the previous decoded
  // delta in the same column, null for the column's first (no bootstrap table: an AQ column's
  // first delta is one symbol in a hundred, so it shares the no-change context). `tod` is the
  // arriving period's tempTodBucket, carried by the columns whose driver is diurnal.
  // See codec-server/scripts/derive-air-quality-codebooks.ts.
  aqPm25Book(res: number, prevDelta: number | null): CodeBook;
  aqO3Book(res: number, tod: number, prevDelta: number | null): CodeBook;
  aqPm10Book(res: number, prevDelta: number | null): CodeBook;
  aqNo2Book(res: number, tod: number, prevDelta: number | null): CodeBook;
  aqSo2Book(res: number, prevDelta: number | null): CodeBook;
  aqiEuPm25Book(res: number, prevDelta: number | null): CodeBook;
  aqiEuPm10Book(res: number, prevDelta: number | null): CodeBook;
  aqiEuO3Book(res: number, tod: number, prevDelta: number | null): CodeBook;
  aqiEuNo2Book(res: number, tod: number, prevDelta: number | null): CodeBook;
  aqiEuSo2Book(res: number, prevDelta: number | null): CodeBook;
  // Each headline's FALLBACK column — its own deltas, used for the presence masks where a
  // residual would cost more than they do (see AQI_*_RESIDUAL_MASKS above).
  aqiDeltaBook(res: number, tod: number, prevDelta: number | null): CodeBook;
  aqiEuBook(res: number, tod: number, prevDelta: number | null): CodeBook;
  // Each headline's conditioned column: the residual against the max of whichever of
  // {pm2.5, ozone, pm10} vars_mask carries, keyed by that 3-bit presence mask and the
  // resolution. The residual is a spike at zero, so a richer context would only split it.
  aqiResidualBook(res: number, baseMask: number): CodeBook;
  aqiEuResidualBook(res: number, baseMask: number): CodeBook;
  // The headline's dominant-pollutant symbol, keyed by the previous period's dominant
  // (null for the column's first, which uses the bootstrap table).
  aqDominantBook(prev: number | null): CodeBook;
  aqDominantEuBook(prev: number | null): CodeBook;
}

function buildBooks(t: typeof BASE_TABLES): Books {
  const weathercode = makeConditionalCodec(t.WEATHERCODE_BOOTSTRAP_WEIGHTS, t.WEATHERCODE_WEIGHTS);

  const windDirBootstrap = buildTable(t.WIND_DIR_BOOTSTRAP_WEIGHTS);
  const windDirTables = t.WIND_DIR_WEIGHTS_BY_RES.map((rows) => rows.map(buildTable));
  const windDirUpperTables = t.WIND_DIR_UPPER_WEIGHTS_BY_RES.map((rows) => rows.map(buildTable));

  const windSpeedTables = t.WIND_SPEED_DELTA_WEIGHTS_BY_RES_LEVEL.map((rows) => rows.map(buildTable));
  const windSpeedUpperTables = t.WIND_SPEED_UPPER_DELTA_WEIGHTS_BY_RES.map((rows) => rows.map(buildTable));

  const freezeDeltaTablesByRes = t.FREEZE_DELTA_WEIGHTS_BY_RES.map(buildTable);
  const freezeDeltaTempTables = t.FREEZE_DELTA_TEMP_WEIGHTS_BY_RES.map((rows) => rows.map(buildTable));

  const cloudBandTables = t.CLOUD_BAND_WEIGHTS_BY_LEVEL_PREV.map((byPrev) => byPrev.map(buildTable));

  const gustDeltaTablesByRes = t.GUST_DELTA_WEIGHTS_BY_RES.map(buildTable);
  const sfcDeltaGustTables = t.SFC_DELTA_GUST_WEIGHTS_BY_RES.map((rows) => rows.map(buildTable));

  const makeValueCodec = (bootstrapWeights: number[], weightsByRes: number[][][], ctxOf: (prev: number) => number) => {
    const bootstrap = buildTable(bootstrapWeights);
    const tables = weightsByRes.map((rows) => rows.map(buildTable));
    // Context rows are prev-major (ctxOf(prev) × WC_CLASSES + wcClass), matching the derive
    // script's emission order.
    return (res: number, wcClass: number, prev: number | null): CodeBook =>
      prev === null ? bootstrap : tables[res][ctxOf(prev) * WC_CLASSES + wcClass];
  };

  const tempDeltaBootstrap = buildTable(t.TEMP_DELTA_BOOTSTRAP_WEIGHTS);
  const tempDeltaTablesByRes = t.TEMP_DELTA_WEIGHTS_BY_RES.map((rows) => rows.map(buildTable));

  return {
    encodeWeathercode: weathercode.encode,
    decodeWeathercode: weathercode.decode,
    windDirBook(res, prev, upper, gap) {
      if (prev === null) return windDirBootstrap;
      return upper === null
        ? windDirTables[res][prev]
        : windDirUpperTables[res][(windGapClass(gap) * NDIR + prev) * NDIR + upper];
    },
    windSpeedBook(res, level, upperDelta, gap) {
      return upperDelta === null
        ? windSpeedTables[res][level]
        : windSpeedUpperTables[res][windGapClass(gap) * N_UPPER_BUCKETS + upperDeltaBucket(upperDelta)];
    },
    gustDeltaBook(res) {
      return gustDeltaTablesByRes[res];
    },
    sfcSpeedBook(res, gustDelta) {
      return gustDelta === null
        ? windSpeedTables[res][0]
        : sfcDeltaGustTables[res][upperDeltaBucket(gustDelta)];
    },
    freezeDeltaBook(res, tempDelta) {
      return tempDelta === null
        ? freezeDeltaTablesByRes[res]
        : freezeDeltaTempTables[res][tempDeltaBucket(tempDelta)];
    },
    cloudBandBook(level, prev) {
      return cloudBandTables[level][prev];
    },
    precipBook: makeValueCodec(t.PRECIP_BOOTSTRAP_WEIGHTS, t.PRECIP_WEIGHTS_BY_RES, (p) => p),
    snowBook: makeValueCodec(t.SNOW_BOOTSTRAP_WEIGHTS, t.SNOW_WEIGHTS_BY_RES, accumBucket),
    rainBook: makeValueCodec(t.RAIN_BOOTSTRAP_WEIGHTS, t.RAIN_WEIGHTS_BY_RES, accumBucket),
    tempDeltaBook(res, tod, prevDelta) {
      if (prevDelta === null) return tempDeltaBootstrap;
      return tempDeltaTablesByRes[res][tempDeltaBucket(prevDelta) * TEMP_DELTA_TOD_BUCKETS + tod];
    },
    ...AQ_BOOKS,
  };
}

// ── Air-quality books ───────────────────────────────────────────────────────────
// Built alongside the weather books; kept as their own block only because their builders share
// the delta/tod/residual shapes below.
const aqDeltaByResPrev = (weights: number[][][]) => {
  const tables = weights.map((rows) => rows.map(buildTable));
  // A column's first delta has no predecessor and shares the no-change bucket — the shape a
  // fresh column looks most like, and rare enough not to deserve a table of its own.
  return (res: number, prevDelta: number | null): CodeBook =>
    tables[res][tempDeltaBucket(prevDelta ?? 0)];
};
const aqDeltaByResTodPrev = (weights: number[][][]) => {
  const tables = weights.map((rows) => rows.map(buildTable));
  return (res: number, tod: number, prevDelta: number | null): CodeBook =>
    tables[res][tempDeltaBucket(prevDelta ?? 0) * TEMP_DELTA_TOD_BUCKETS + tod];
};
// Residual tables are [baseMask][res]. Mask 0 is never looked up (no carried constituent means
// the headline codes its own deltas), but the row is generated so the array indexes by mask
// directly rather than by mask-1.
const aqResidualByMaskRes = (weights: number[][][]) => {
  const tables = weights.map((rows) => rows.map(buildTable));
  return (res: number, baseMask: number): CodeBook => tables[baseMask][res];
};
const aqDominantOrder1 = (bootstrapWeights: number[], weights: number[][]) => {
  const bootstrap = buildTable(bootstrapWeights);
  const tables = weights.map(buildTable);
  return (prev: number | null): CodeBook => (prev === null ? bootstrap : tables[prev]);
};
const AQ_BOOKS = {
  aqPm25Book: aqDeltaByResPrev(AQ_PM25_DELTA_WEIGHTS_BY_RES),
  aqO3Book: aqDeltaByResTodPrev(AQ_O3_DELTA_WEIGHTS_BY_RES),
  aqPm10Book: aqDeltaByResPrev(AQ_PM10_DELTA_WEIGHTS_BY_RES),
  aqNo2Book: aqDeltaByResTodPrev(AQ_NO2_DELTA_WEIGHTS_BY_RES),
  aqSo2Book: aqDeltaByResPrev(AQ_SO2_DELTA_WEIGHTS_BY_RES),
  aqiDeltaBook: aqDeltaByResTodPrev(AQI_DELTA_WEIGHTS_BY_RES),
  aqiEuBook: aqDeltaByResTodPrev(AQI_EU_DELTA_WEIGHTS_BY_RES),
  aqiEuPm25Book: aqDeltaByResPrev(AQI_EU_PM25_DELTA_WEIGHTS_BY_RES),
  aqiEuPm10Book: aqDeltaByResPrev(AQI_EU_PM10_DELTA_WEIGHTS_BY_RES),
  aqiEuO3Book: aqDeltaByResTodPrev(AQI_EU_O3_DELTA_WEIGHTS_BY_RES),
  aqiEuNo2Book: aqDeltaByResTodPrev(AQI_EU_NO2_DELTA_WEIGHTS_BY_RES),
  aqiEuSo2Book: aqDeltaByResPrev(AQI_EU_SO2_DELTA_WEIGHTS_BY_RES),
  aqiResidualBook: aqResidualByMaskRes(AQI_RESIDUAL_WEIGHTS_BY_MASK_RES),
  aqiEuResidualBook: aqResidualByMaskRes(AQI_EU_RESIDUAL_WEIGHTS_BY_MASK_RES),
  aqDominantBook: aqDominantOrder1(AQ_DOMINANT_BOOTSTRAP_WEIGHTS, AQ_DOMINANT_WEIGHTS),
  aqDominantEuBook: aqDominantOrder1(AQ_DOMINANT_EU_BOOTSTRAP_WEIGHTS, AQ_DOMINANT_EU_WEIGHTS),
};

// The table set — codebooks.gen.ts gathered into one object, the shape buildBooks reads.
const BASE_TABLES = {
  CLOUD_BAND_WEIGHTS_BY_LEVEL_PREV,
  FREEZE_DELTA_WEIGHTS_BY_RES, FREEZE_DELTA_TEMP_WEIGHTS_BY_RES,
  GUST_DELTA_WEIGHTS_BY_RES, SFC_DELTA_GUST_WEIGHTS_BY_RES,
  PRECIP_BOOTSTRAP_WEIGHTS, PRECIP_WEIGHTS_BY_RES,
  SNOW_BOOTSTRAP_WEIGHTS, SNOW_WEIGHTS_BY_RES,
  RAIN_BOOTSTRAP_WEIGHTS, RAIN_WEIGHTS_BY_RES,
  TEMP_DELTA_BOOTSTRAP_WEIGHTS, TEMP_DELTA_WEIGHTS_BY_RES,
  WEATHERCODE_BOOTSTRAP_WEIGHTS, WEATHERCODE_WEIGHTS,
  WIND_DIR_BOOTSTRAP_WEIGHTS, WIND_DIR_WEIGHTS_BY_RES, WIND_DIR_UPPER_WEIGHTS_BY_RES,
  WIND_SPEED_DELTA_WEIGHTS_BY_RES_LEVEL, WIND_SPEED_UPPER_DELTA_WEIGHTS_BY_RES,
};

export const BOOKS: Books = buildBooks(BASE_TABLES);

// ── Symbol codecs ───────────────────────────────────────────────────────────────

export function encodeWindSpeedDelta(sink: SymSink, book: CodeBook, delta: number): void {
  sink.sym(book, delta + WIND_SPEED_DELTA_MAX);
}

export function decodeWindSpeedDelta(src: SymSource, book: CodeBook): number {
  return src.sym(book) - WIND_SPEED_DELTA_MAX;
}

export function encodeFreezeDelta(sink: SymSink, book: CodeBook, delta: number): void {
  sink.sym(book, delta + FREEZE_DELTA_MAX);
}

export function decodeFreezeDelta(src: SymSource, book: CodeBook): number {
  return src.sym(book) - FREEZE_DELTA_MAX;
}

// Emits the code for a period-over-period temp change `delta` (°C) under `book`; jumps outside
// ±7°C fall back to the escape symbol plus a raw 6-bit field. Throws on a delta outside
// TEMP_DELTA_MIN..TEMP_DELTA_MAX — the caller must clamp (see above).
export function encodeTempDelta(sink: SymSink, book: CodeBook, delta: number): void {
  if (delta < TEMP_DELTA_MIN || delta > TEMP_DELTA_MAX)
    throw new Error(`entropy: temp delta ${delta} outside ${TEMP_DELTA_MIN}..${TEMP_DELTA_MAX}`);
  const sym = tempDeltaSym(delta);
  sink.sym(book, sym);
  if (sym === TEMP_DELTA_ESCAPE_SYM) sink.raw(delta + TEMP_DELTA_ESCAPE_BIAS, TEMP_DELTA_ESCAPE_BITS);
}

// Reads one coded temp delta (under `book`).
export function decodeTempDelta(src: SymSource, book: CodeBook): number {
  const sym = src.sym(book);
  if (sym === TEMP_DELTA_ESCAPE_SYM) return src.raw(TEMP_DELTA_ESCAPE_BITS) - TEMP_DELTA_ESCAPE_BIAS;
  return sym - TEMP_DELTA_CORE_RADIUS;
}

// ── Book aliases ────────────────────────────────────────────────────────────────
// The books under standalone names, for tests and analysis scripts. The v3 codec itself goes
// through BOOKS.
export const encodeWeathercode = BOOKS.encodeWeathercode;
export const decodeWeathercode = BOOKS.decodeWeathercode;
export const windDirBook = BOOKS.windDirBook;
export const windSpeedBook = BOOKS.windSpeedBook;
export const gustDeltaBook = BOOKS.gustDeltaBook;
export const sfcSpeedBook = BOOKS.sfcSpeedBook;
export const freezeDeltaBook = BOOKS.freezeDeltaBook;
export const cloudBandBook = BOOKS.cloudBandBook;
export const precipBook = BOOKS.precipBook;
export const snowBook = BOOKS.snowBook;
export const rainBook = BOOKS.rainBook;
export const tempDeltaBook = BOOKS.tempDeltaBook;

// ── Wire-format freeze ──────────────────────────────────────────────────────────
// Every table above is wire format: re-deriving any of them changes what already-encoded v3
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
const bundleOf = (t: typeof BASE_TABLES) => ({
  weathercode: {
    bootstrap: qf(t.WEATHERCODE_BOOTSTRAP_WEIGHTS),
    weights: t.WEATHERCODE_WEIGHTS.map(qf),
  },
  windDir: {
    bootstrap: qf(t.WIND_DIR_BOOTSTRAP_WEIGHTS),
    byRes: t.WIND_DIR_WEIGHTS_BY_RES.map((rows) => rows.map(qf)),
    upperByRes: t.WIND_DIR_UPPER_WEIGHTS_BY_RES.map((rows) => rows.map(qf)),
  },
  windSpeedDelta: {
    byResLevel: t.WIND_SPEED_DELTA_WEIGHTS_BY_RES_LEVEL.map((rows) => rows.map(qf)),
    upperByRes: t.WIND_SPEED_UPPER_DELTA_WEIGHTS_BY_RES.map((rows) => rows.map(qf)),
    maxDelta: WIND_SPEED_DELTA_MAX,
  },
  precip: { bootstrap: qf(t.PRECIP_BOOTSTRAP_WEIGHTS), byRes: t.PRECIP_WEIGHTS_BY_RES.map((rows) => rows.map(qf)) },
  snow: { bootstrap: qf(t.SNOW_BOOTSTRAP_WEIGHTS), byRes: t.SNOW_WEIGHTS_BY_RES.map((rows) => rows.map(qf)), bucketEdges: ACCUM_BUCKET_EDGES },
  rain: { bootstrap: qf(t.RAIN_BOOTSTRAP_WEIGHTS), byRes: t.RAIN_WEIGHTS_BY_RES.map((rows) => rows.map(qf)), bucketEdges: ACCUM_BUCKET_EDGES },
  // The freeze tables also key on tempDelta.prevBucketEdges (below) via tempDeltaBucket.
  freezeDelta: {
    byRes: t.FREEZE_DELTA_WEIGHTS_BY_RES.map(qf),
    tempByRes: t.FREEZE_DELTA_TEMP_WEIGHTS_BY_RES.map((rows) => rows.map(qf)),
  },
  // Gust decodes first (res-keyed); the surface column keys on gust's same-period delta via
  // upperDeltaBucket, falling back to windSpeedDelta[res][0] when gust is absent.
  gustDelta: { byRes: t.GUST_DELTA_WEIGHTS_BY_RES.map(qf) },
  sfcDeltaGust: { byRes: t.SFC_DELTA_GUST_WEIGHTS_BY_RES.map((rows) => rows.map(qf)) },
  // One table per (CLOUD_BAND_LEVELS_HPA level, previous step), in that order — both indices
  // are the book indices, so a reordering of either axis is itself a wire change and trips the
  // digest.
  cloudBand: t.CLOUD_BAND_WEIGHTS_BY_LEVEL_PREV.map((rows) => rows.map(qf)),
  tempDelta: {
    bootstrap: qf(t.TEMP_DELTA_BOOTSTRAP_WEIGHTS),
    byRes: t.TEMP_DELTA_WEIGHTS_BY_RES.map((rows) => rows.map(qf)),
    coreRadius: TEMP_DELTA_CORE_RADIUS,
    escapeBits: TEMP_DELTA_ESCAPE_BITS,
    prevBucketEdges: TEMP_DELTA_PREV_EDGES,
    todBuckets: TEMP_DELTA_TOD_BUCKETS,
  },
});
// Air quality is pinned once, outside bundleOf: the classes don't carry AQ tables (see AQ_BOOKS),
// so there is one set for every class. The ladders go in alongside the weights — they are what
// gives a symbol its meaning, exactly like beaufortKphLower for the wind columns.
const airQualityBundle = {
  usLadder: AQI_US_LOWER,
  euLadder: AQI_EU_LOWER,
  deltaCoreRadius: AQI_DELTA_CORE_RADIUS,
  deltaEscapeBits: AQI_DELTA_ESCAPE_BITS,
  pm25ByRes: AQ_PM25_DELTA_WEIGHTS_BY_RES.map((rows) => rows.map(qf)),
  o3ByRes: AQ_O3_DELTA_WEIGHTS_BY_RES.map((rows) => rows.map(qf)),
  pm10ByRes: AQ_PM10_DELTA_WEIGHTS_BY_RES.map((rows) => rows.map(qf)),
  no2ByRes: AQ_NO2_DELTA_WEIGHTS_BY_RES.map((rows) => rows.map(qf)),
  so2ByRes: AQ_SO2_DELTA_WEIGHTS_BY_RES.map((rows) => rows.map(qf)),
  aqiByRes: AQI_DELTA_WEIGHTS_BY_RES.map((rows) => rows.map(qf)),
  euByRes: AQI_EU_DELTA_WEIGHTS_BY_RES.map((rows) => rows.map(qf)),
  euPm25ByRes: AQI_EU_PM25_DELTA_WEIGHTS_BY_RES.map((rows) => rows.map(qf)),
  euPm10ByRes: AQI_EU_PM10_DELTA_WEIGHTS_BY_RES.map((rows) => rows.map(qf)),
  euO3ByRes: AQI_EU_O3_DELTA_WEIGHTS_BY_RES.map((rows) => rows.map(qf)),
  euNo2ByRes: AQI_EU_NO2_DELTA_WEIGHTS_BY_RES.map((rows) => rows.map(qf)),
  euSo2ByRes: AQI_EU_SO2_DELTA_WEIGHTS_BY_RES.map((rows) => rows.map(qf)),
  // Residuals are [baseMask][res]; the mode sets say which masks use them at all, and are wire
  // format just as much as the weights are — a decoder that disagreed would read a residual as
  // a delta series.
  residualByMaskRes: AQI_RESIDUAL_WEIGHTS_BY_MASK_RES.map((rows) => rows.map(qf)),
  euResidualByMaskRes: AQI_EU_RESIDUAL_WEIGHTS_BY_MASK_RES.map((rows) => rows.map(qf)),
  dominantUs: AQ_DOMINANT_US,
  dominantEu: AQ_DOMINANT_EU,
  dominantBootstrap: qf(AQ_DOMINANT_BOOTSTRAP_WEIGHTS),
  dominantByPrev: AQ_DOMINANT_WEIGHTS.map(qf),
  dominantEuBootstrap: qf(AQ_DOMINANT_EU_BOOTSTRAP_WEIGHTS),
  dominantEuByPrev: AQ_DOMINANT_EU_WEIGHTS.map(qf),
  usResidualMasks: [...AQI_US_RESIDUAL_MASKS].sort((a, b) => a - b),
  euResidualMasks: [...AQI_EU_RESIDUAL_MASKS].sort((a, b) => a - b),
};
export const V3_CODEBOOKS = {
  rans: { probBits: RANS_PROB_BITS, stateLow: RANS_L, wordBits: RANS_WORD_BITS },
  ...bundleOf(BASE_TABLES),
  airQuality: airQualityBundle,
  weathercodeClassOf: WEATHERCODE_CLASS, // keys the wet columns' tables — drift desyncs them silently
  beaufortKphLower: BEAUFORT_KPH_LOWER,  // wind quantization geometry — drift re-means every speed symbol
} as const;
