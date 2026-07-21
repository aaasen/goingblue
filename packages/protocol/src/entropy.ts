// All weight tables live in codebooks.gen.ts (the base set — codebook class 0) and
// codebooks-classes.gen.ts (classes 1..CODEBOOK_CLASSES-1), written by the derive pipeline —
// never edited by hand. They are wire format; see V1_CODEBOOKS at the bottom of this file.
import {
  WEATHERCODE_BOOTSTRAP_WEIGHTS, WEATHERCODE_WEIGHTS,
  WIND_DIR_BOOTSTRAP_WEIGHTS, WIND_DIR_WEIGHTS_BY_RES, WIND_DIR_UPPER_WEIGHTS_BY_RES,
  WIND_SPEED_DELTA_WEIGHTS_BY_RES_LEVEL, WIND_SPEED_UPPER_DELTA_WEIGHTS_BY_RES,
  FREEZE_DELTA_WEIGHTS_BY_RES, FREEZE_DELTA_TEMP_WEIGHTS_BY_RES,
  CLOUD_LOW_DELTA_WEIGHTS, CLOUD_MID_DELTA_WEIGHTS, CLOUD_HIGH_DELTA_WEIGHTS,
  TEMP_DELTA_BOOTSTRAP_WEIGHTS, TEMP_DELTA_WEIGHTS_BY_RES,
  PRECIP_BOOTSTRAP_WEIGHTS, PRECIP_WEIGHTS_BY_RES,
  SNOW_BOOTSTRAP_WEIGHTS, SNOW_WEIGHTS_BY_RES,
  RAIN_BOOTSTRAP_WEIGHTS, RAIN_WEIGHTS_BY_RES,
} from "./codebooks.gen.js";
import { CLASS_TABLES, CODEBOOK_CLASSES, type ClassTableSet } from "./codebooks-classes.gen.js";
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

// Single-table delta codec for a bounded quantized domain 0..maxDelta: the full delta range
// -maxDelta..maxDelta (2·maxDelta+1 symbols) fits directly in the alphabet — no escape/raw-payload
// fallback needed.
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

// ── Wire-format context functions (shared by every codebook class) ──────────────
// The CONTEXT a symbol's table is keyed by is identical across classes — a class only swaps the
// frequencies inside each table. So the bucketing functions below are wire format exactly once.

// The weathercode collapsed to a 4-class precipitation regime — WIRE FORMAT: the wet columns
// (precip/snow/rain) key their codebooks on the SAME period's class, which they may do for free
// because weathercode decodes first and is always present (the same trick the 600/700 hPa wind
// columns play on the upper level). Indexed by WMO *symbol index* (0..27, position in WMO_CODES),
// never by the raw input code: the encoder maps an unrecognized input code to index 0
// (`WMO2IDX[...] ?? 0`), so a class taken from the raw code would diverge from the one the decoder
// derives from the symbol it actually read.
//   0 dry (clear/cloud/fog) · 1 rain-ish (drizzle/rain/showers/thunder) ·
//   2 freezing (freezing drizzle/rain) · 3 snow-ish (snow/snow showers)
export const WC_CLASSES = 4;
export const WEATHERCODE_CLASS: readonly number[] = [
  //  0  1  2  3 45 48 51 53 55 56 57 61 63 65 66 67 71 73 75 77 80 81 82 85 86 95 96 99  ← WMO code
  0, 0, 0, 0, 0, 0, 1, 1, 1, 2, 2, 1, 1, 1, 2, 2, 3, 3, 3, 3, 1, 1, 1, 3, 3, 1, 1, 1,
];

const NDIR = 8;

// must mirror WIND_SPEED_BITS in v1.ts (0..31)
export const WIND_SPEED_DELTA_MAX = 31;

// Buckets an upper-level same-period speed delta for table selection (must match the derive
// script): ≤-2, -1, 0, +1, ≥+2.
export function upperDeltaBucket(d: number): number {
  return d <= -2 ? 0 : d === -1 ? 1 : d === 0 ? 2 : d === 1 ? 3 : 4;
}

// must mirror the freeze column width in v1.ts (0..31)
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
// (see the temp column in v1.ts).
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

// ── Codebook classes ────────────────────────────────────────────────────────────
// One ClassBooks per codebook class: the complete set of table-lookup functions the v1 body
// codec keys symbols with. Class 0 is the global (train-corpus-wide) tables in codebooks.gen.ts;
// classes 1..CODEBOOK_CLASSES-1 (codebooks-classes.gen.ts) were learned by EM in code-length
// space over the corpus (see server/scripts/derive-class-ladder.ts) — regional/seasonal regimes
// (marine, tropical, polar...) whose conditional distributions are sharper than the global
// mixture. The encoder builds the body under every class and keeps the cheapest (held-out
// -2.5% body bits at K=8); the 3-bit selector rides free in the v1 header. Which class a
// message used is in-band — the decoder needs nothing external.
//
// What a class does NOT change: alphabets, context functions (above), column structure. Only
// the frequencies inside each table.
export interface ClassBooks {
  // Emits/reads the code for a weathercode symbol under the table keyed by `prevSym` — the
  // previously decoded symbol, or null for the first symbol of a sequence (bootstrap). Weather
  // persists hour-to-hour far more than it varies by climate/region, hence order-1 tables (see
  // server/scripts/derive-weathercode-codebooks.ts).
  encodeWeathercode(sink: SymSink, prevSym: number | null, sym: number): void;
  decodeWeathercode(src: SymSource, prevSym: number | null): number;
  // The codebook for one direction symbol. `prev` is the last direction encoded in this column
  // (null for the column's first — bootstrap), `upper` the upper level's same-period displayed
  // direction (null when that column is absent or this level has none). See
  // server/scripts/derive-wind-dir-codebooks.ts for the context ladder.
  windDirBook(res: number, prev: number | null, upper: number | null): CodeBook;
  // The codebook for one speed delta. `level` indexes WIND_COLUMNS order (sfc, 500, 600, 700);
  // `upperDelta` is the upper level's same-period delta (null when that column is absent or this
  // level has none). See server/scripts/derive-wind-speed-delta-codebooks.ts.
  windSpeedBook(res: number, level: number, upperDelta: number | null): CodeBook;
  // The codebook for one freeze delta. `tempDelta` is the same period's decoded temp delta (the
  // post-clamp reconstruction, never the raw input), or null when temp is absent from vars_mask
  // — the res-keyed fallback (the tempΔ marginal). The freezing level is where the 0°C isotherm
  // sits, so it moves with the airmass temperature, and temp decodes first, making its delta
  // free context. See server/scripts/derive-freeze-delta-codebooks.ts.
  freezeDeltaBook(res: number, tempDelta: number | null): CodeBook;
  // Cloud cover deltas (0..7 quantized, deltas -7..7): low/mid/high each under its own single
  // shared table (not pooled across levels) — low clouds are local/convective, high clouds broad
  // persistent cirrus. See server/scripts/derive-cloud-delta-codebooks.ts.
  cloudLowDelta: DeltaCodec;
  cloudMidDelta: DeltaCodec;
  cloudHighDelta: DeltaCodec;
  // Order-1 codebooks over the wet columns' quantized VALUES (not deltas — zero is an absorbing
  // regime), keyed by (resolution, SAME-period weathercode class, previous decoded value) —
  // bootstrap for a column's first cell. Rain/snow key on a BUCKET of the previous value (see
  // accumBucket). See server/scripts/derive-precip-accum-codebooks.ts.
  precipBook(res: number, wcClass: number, prev: number | null): CodeBook;
  snowBook(res: number, wcClass: number, prev: number | null): CodeBook;
  rainBook(res: number, wcClass: number, prev: number | null): CodeBook;
  // The codebook for one temp delta. `tod` is the arriving period's tempTodBucket; `prevDelta`
  // the previous decoded delta in this column — the post-clamp reconstruction, never the raw
  // input — or null for the column's first delta (bootstrap). The diurnal cycle drives the delta
  // sign; the previous delta adds the airmass's actual trajectory. See
  // server/scripts/derive-temp-delta-codebooks.ts.
  tempDeltaBook(res: number, tod: number, prevDelta: number | null): CodeBook;
}

function buildClassBooks(t: ClassTableSet): ClassBooks {
  const weathercode = makeConditionalCodec(t.WEATHERCODE_BOOTSTRAP_WEIGHTS, t.WEATHERCODE_WEIGHTS);

  const windDirBootstrap = buildTable(t.WIND_DIR_BOOTSTRAP_WEIGHTS);
  const windDirTables = t.WIND_DIR_WEIGHTS_BY_RES.map((rows) => rows.map(buildTable));
  const windDirUpperTables = t.WIND_DIR_UPPER_WEIGHTS_BY_RES.map((rows) => rows.map(buildTable));

  const windSpeedTables = t.WIND_SPEED_DELTA_WEIGHTS_BY_RES_LEVEL.map((rows) => rows.map(buildTable));
  const windSpeedUpperTables = t.WIND_SPEED_UPPER_DELTA_WEIGHTS_BY_RES.map((rows) => rows.map(buildTable));

  const freezeDeltaTablesByRes = t.FREEZE_DELTA_WEIGHTS_BY_RES.map(buildTable);
  const freezeDeltaTempTables = t.FREEZE_DELTA_TEMP_WEIGHTS_BY_RES.map((rows) => rows.map(buildTable));

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
    windDirBook(res, prev, upper) {
      if (prev === null) return windDirBootstrap;
      return upper === null
        ? windDirTables[res][prev]
        : windDirUpperTables[res][prev * NDIR + upper];
    },
    windSpeedBook(res, level, upperDelta) {
      return upperDelta === null
        ? windSpeedTables[res][level]
        : windSpeedUpperTables[res][upperDeltaBucket(upperDelta)];
    },
    freezeDeltaBook(res, tempDelta) {
      return tempDelta === null
        ? freezeDeltaTablesByRes[res]
        : freezeDeltaTempTables[res][tempDeltaBucket(tempDelta)];
    },
    cloudLowDelta: makeDeltaCodec(t.CLOUD_LOW_DELTA_WEIGHTS, 7),
    cloudMidDelta: makeDeltaCodec(t.CLOUD_MID_DELTA_WEIGHTS, 7),
    cloudHighDelta: makeDeltaCodec(t.CLOUD_HIGH_DELTA_WEIGHTS, 7),
    precipBook: makeValueCodec(t.PRECIP_BOOTSTRAP_WEIGHTS, t.PRECIP_WEIGHTS_BY_RES, (p) => p),
    snowBook: makeValueCodec(t.SNOW_BOOTSTRAP_WEIGHTS, t.SNOW_WEIGHTS_BY_RES, accumBucket),
    rainBook: makeValueCodec(t.RAIN_BOOTSTRAP_WEIGHTS, t.RAIN_WEIGHTS_BY_RES, accumBucket),
    tempDeltaBook(res, tod, prevDelta) {
      if (prevDelta === null) return tempDeltaBootstrap;
      return tempDeltaTablesByRes[res][tempDeltaBucket(prevDelta) * TEMP_DELTA_TOD_BUCKETS + tod];
    },
  };
}

// The base (class 0) table set — codebooks.gen.ts as one ClassTableSet.
const BASE_TABLES: ClassTableSet = {
  CLOUD_LOW_DELTA_WEIGHTS, CLOUD_MID_DELTA_WEIGHTS, CLOUD_HIGH_DELTA_WEIGHTS,
  FREEZE_DELTA_WEIGHTS_BY_RES, FREEZE_DELTA_TEMP_WEIGHTS_BY_RES,
  PRECIP_BOOTSTRAP_WEIGHTS, PRECIP_WEIGHTS_BY_RES,
  SNOW_BOOTSTRAP_WEIGHTS, SNOW_WEIGHTS_BY_RES,
  RAIN_BOOTSTRAP_WEIGHTS, RAIN_WEIGHTS_BY_RES,
  TEMP_DELTA_BOOTSTRAP_WEIGHTS, TEMP_DELTA_WEIGHTS_BY_RES,
  WEATHERCODE_BOOTSTRAP_WEIGHTS, WEATHERCODE_WEIGHTS,
  WIND_DIR_BOOTSTRAP_WEIGHTS, WIND_DIR_WEIGHTS_BY_RES, WIND_DIR_UPPER_WEIGHTS_BY_RES,
  WIND_SPEED_DELTA_WEIGHTS_BY_RES_LEVEL, WIND_SPEED_UPPER_DELTA_WEIGHTS_BY_RES,
};

export { CODEBOOK_CLASSES };
export const CLASS_BOOKS: ClassBooks[] = [BASE_TABLES, ...CLASS_TABLES].map(buildClassBooks);
if (CLASS_BOOKS.length !== CODEBOOK_CLASSES)
  throw new Error(`entropy: ${CLASS_BOOKS.length} codebook classes built, expected ${CODEBOOK_CLASSES}`);

// ── Class-independent symbol codecs ─────────────────────────────────────────────

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

// ── Class-0 aliases ─────────────────────────────────────────────────────────────
// The base class's books under their historical names, for tests and analysis scripts. The v1
// codec itself goes through CLASS_BOOKS — never these.
const BASE = CLASS_BOOKS[0];
export const encodeWeathercode = BASE.encodeWeathercode;
export const decodeWeathercode = BASE.decodeWeathercode;
export const windDirBook = BASE.windDirBook;
export const windSpeedBook = BASE.windSpeedBook;
export const freezeDeltaBook = BASE.freezeDeltaBook;
export const CLOUD_LOW_DELTA = BASE.cloudLowDelta;
export const CLOUD_MID_DELTA = BASE.cloudMidDelta;
export const CLOUD_HIGH_DELTA = BASE.cloudHighDelta;
export const precipBook = BASE.precipBook;
export const snowBook = BASE.snowBook;
export const rainBook = BASE.rainBook;
export const tempDeltaBook = BASE.tempDeltaBook;

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
// range (2·maxDelta+1 symbols, +1 escape for temp). The per-class sets (classes 1..K-1) are
// pinned right alongside the base set: a drifted class table desyncs any message whose header
// selected it.
const qf = (w: number[]) => quantizeFreqs(w);
const bundleOf = (t: ClassTableSet) => ({
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
  cloudLowDelta: qf(t.CLOUD_LOW_DELTA_WEIGHTS),
  cloudMidDelta: qf(t.CLOUD_MID_DELTA_WEIGHTS),
  cloudHighDelta: qf(t.CLOUD_HIGH_DELTA_WEIGHTS),
  tempDelta: {
    bootstrap: qf(t.TEMP_DELTA_BOOTSTRAP_WEIGHTS),
    byRes: t.TEMP_DELTA_WEIGHTS_BY_RES.map((rows) => rows.map(qf)),
    coreRadius: TEMP_DELTA_CORE_RADIUS,
    escapeBits: TEMP_DELTA_ESCAPE_BITS,
    prevBucketEdges: TEMP_DELTA_PREV_EDGES,
    todBuckets: TEMP_DELTA_TOD_BUCKETS,
  },
});
export const V1_CODEBOOKS = {
  rans: { probBits: RANS_PROB_BITS, stateLow: RANS_L, wordBits: RANS_WORD_BITS },
  ...bundleOf(BASE_TABLES),
  weathercodeClassOf: WEATHERCODE_CLASS, // keys the wet columns' tables — drift desyncs them silently
  // Classes 1..CODEBOOK_CLASSES-1 (class 0 is the base bundle spread above).
  classes: CLASS_TABLES.map(bundleOf),
} as const;
