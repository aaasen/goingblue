import {
  WMO_CODES, VARS_BIT, CLOUD_BAND_LEVELS_HPA,
} from "../constants.js";
import { layoutFor, maxFillSeq, effectiveMode } from "../layout.js";
import { putInt, takeInt, compandSqrt, expandSqrt } from "../bits.js";
import {
  encode, decode, encodeBodyLE, encodeBodyWide, decodeBodyAuto, nCharsForBits, type Alphabet,
} from "../codec.js";
import { encodeVersion, takeVersion, VERSION_PREFIX_CHARS } from "../version.js";
import { DEVICE_TRANSPORT } from "../devices.js";
import { WMO2IDX, type Period } from "../model.js";
import type { ForecastMessage, MessageHeader, VersionedCodec, ContextResolver } from "../model.js";
import {
  WEATHERCODE_CLASS, CLASS_BOOKS, CODEBOOK_CLASSES, type ClassBooks,
  encodeWindSpeedDelta, decodeWindSpeedDelta, quantWind, beaufortMidKph, CALM_MAX_FORCE,
  encodeFreezeDelta, decodeFreezeDelta,
  encodeAqiDelta, decodeAqiDelta, quantAqi, aqiMid,
  AQI_US_LOWER, AQI_EU_LOWER, AQI_RESIDUAL_MAX,
  AQI_BASE_PM25, AQI_BASE_O3, AQI_BASE_PM10,
  AQI_US_RESIDUAL_MASKS, AQI_EU_RESIDUAL_MASKS,
  AQ_DOMINANT_US, AQ_DOMINANT_EU, AQI_NO_DATA, aqDominantUnknown, aqDominantNSym,
  encodeTempDelta, decodeTempDelta, tempTodBucket,
  TEMP_DELTA_MIN, TEMP_DELTA_MAX,
  makeBitSink, makeBitSource, type CodeBook, type DeltaCodec,
} from "../entropy.js";

export const V3_VERSION = 3;
const VERSION = V3_VERSION;

// Duration-first fill: the user requests a duration in days and the server fills the message
// budget by refining days from the front of the window (see layout.ts).
//
// The response is slim: lat/lon/model/vars, the priority mode, the UTC offset, AND the
// request datetime are NOT on the wire. The client stores the request under `code` and recovers
// them via a ContextResolver at decode time (see RequestContext). The period layout — count and
// per-period resolution — isn't on the wire either: the header carries only the fill-sequence
// number, from which both sides derive the identical layout via layoutFor(). Periods within one
// message can span different resolutions, which the column codecs already handle (the temp-delta
// codebooks were derived across resolutions for exactly this reason, see entropy.ts).
//
// The 7-bit version field lives in the shared, self-describing prefix (see version.ts), not in this
// packed header. Packed header layout (25 bits):
//   code:7 seq:8 elev:7 class:3
// seq:8 stores (seq - 1), i.e. 1..256; the largest layout is seq = maxFillSeq(mode).
// class:3 is the codebook-class selector: the encoder builds the body under every class's table
// set and keeps the cheapest (see CLASS_BOOKS in entropy.ts). The 3 bits ride free — 25 bits
// still fit the same 4 base-85 header chars 22 did (4 × log2(85) ≈ 25.6).
// The body carries no length field — it is a single rANS stream (see rans.ts), serialized
// little-endian and self-delimiting: the decoder knows the structure and consumes exactly the
// symbols the encoder wrote (see encodeBodyLE/decodeBodyLE and SymSource.assertDone).
// The columns have no per-column selectors: within a class, each symbol's codebook is keyed by
// context both sides already have (see entropy.ts).
export const V3_SEQ_BITS = 8;

// Message code: client-assigned key the response echoes; see RequestContext / model.ts.
const CODE_BITS = 7;
// Elevation: 7 bits in 100 m steps → 0..12700 m. It's a coarse sanity check (summit vs. valley),
// so metre precision isn't needed.
const ELEV_BITS = 7;
const ELEV_STEP_M = 100;
// Codebook-class selector: 3 bits for up to 8 classes (CODEBOOK_CLASSES may be smaller; the
// field width is wire format and stays fixed).
const CLASS_BITS = 3;

export const V3_HEADER_BITS =
  CODE_BITS + V3_SEQ_BITS + ELEV_BITS + CLASS_BITS; // 25
// Total chars before the body: the shared version prefix plus this version's packed header.
export const V3_HEADER_CHARS = VERSION_PREFIX_CHARS + nCharsForBits(V3_HEADER_BITS); // 1 + 4 = 5
const HEADER_BITS = V3_HEADER_BITS;
const HEADER_CHARS = nCharsForBits(V3_HEADER_BITS); // packed-header chars (excludes version prefix)

// temp: 8 bits, 1°C steps, offset -100°C → -100°C to +155°C
// snow/rain: 6 bits each, sqrt-companded (see ACCUM_* below). rain is bit 12, the slot
// formerly reserved for the removed `vis`; bit 13 (formerly tmin) is reserved.
// wind: 8 = 5-bit speed (extended Beaufort force 0..17) + 3-bit direction (raw-width
// equivalent; both entropy-coded).
// gust: 5 = speed only, no direction (bit 8, formerly cloud_total).
// cloud band: bit 9 (v2's cch) carries the whole CLOUD_BAND_LEVELS_HPA stack at 3 bits per
// level anchor; bits 10/11 (v2's ccm/ccl) carry nothing in v3 but stay in the table so the
// `c` toggle's mask decodes identically.
// air quality: 5 bits each — a 26-symbol ladder (0 = no data, 1..25 bands), both scales.
export const VAR_BITS_V3 = [3, 8, 6, 5, 8, 8, 8, 8, 5, 3, 3, 3, 6, 5, 5, 5, 5, 5, 5, 5, 5, 5, 5, 5, 5];
//                          ^p ^t ^s ^f ^w ^5 ^6 ^7 ^g ^cband ^(10/11 unused) ^rain
//                                                    ^aq_pm25 ^aq_o3 ^aqi ^aqi_eu ^aqi_eu_pm25
//                                     ^aqi_eu_pm10 ^aqi_eu_no2 ^aqi_eu_o3 ^aqi_eu_so2
//                                                  ^aq_pm10 ^aq_no2 ^aq_so2

const TEMP_OFFSET = 100;

// Snow (cm) and rain (mm) use sqrt companding (see compandSqrt): fine resolution near zero,
// coarsening with magnitude, so one 6-bit field spans light hourly through heavy daily
// accumulation. k = (2^bits - 1) / sqrt(maxValue).
export const ACCUM_BITS = 6;
const ACCUM_MAX = (1 << ACCUM_BITS) - 1;
export const SNOW_MAX_CM = 200;
export const RAIN_MAX_MM = 144;
export const SNOW_K = ACCUM_MAX / Math.sqrt(SNOW_MAX_CM); // ≈ 4.4548
export const RAIN_K = ACCUM_MAX / Math.sqrt(RAIN_MAX_MM); // = 5.25
// Every wind speed column quantizes to the extended Beaufort scale (forces 0..17, 5-bit
// anchors) — quantWind/beaufortMidKph in entropy.ts, where the band bounds are wire format and
// digest-pinned. Decoded speeds are band midpoints (kph); the app may display the force
// directly. Direction symbols are calm-gated at force ≤ CALM_MAX_FORCE (< 6 kph).
const WIND_FORCE_BITS = 5;

function clampInt(v: number, width: number): number {
  return Math.min(Math.max(v, 0), (1 << width) - 1);
}

// temp: entropy-coded period-over-period deltas (see TEMP_DELTA_* in entropy.ts), not a plain
// scalar column — each model's first period is an anchor at full width, quantized the same way.
const TEMP_ANCHOR_BITS = VAR_BITS_V3[VARS_BIT.temp];
const quantTemp = (p: Period, field: "temp_c"): number =>
  clampInt(Math.round((p[field] ?? 0) + TEMP_OFFSET), TEMP_ANCHOR_BITS);
const TEMP_DELTA_COLUMNS: [bit: number, field: "temp_c", name: string][] = [
  [VARS_BIT.temp, "temp_c", "temp"],
];

// freeze: entropy-coded period-over-period deltas under tables keyed by (the arriving period's
// resolution, the SAME period's temp delta) — the 0°C isotherm moves with the airmass
// temperature, and temp decodes first, so its delta is free context; a res-keyed fallback covers
// messages without temp in vars_mask (see freezeDeltaBook in entropy.ts — no per-message
// selector; a held-out cheapest-of-16 measured worse than a shared table). Not a plain scalar
// column. 304.8 m (1000 ft) steps, 0..31
// (0-31000 ft) — tropical and subtropical high country (the Andes, central Mexico) sits above
// 15000 ft nearly year-round, and the corpus tops out at 21200 ft, so the domain has to reach
// well past that to stop clipping.
const FREEZE_STEP_M = 304.8;
const FREEZE_ANCHOR_BITS = VAR_BITS_V3[VARS_BIT.freeze];
// The 1e-9 rescues float dust only (14 × 304.8 / 304.8 = 13.999999999999998 → 13 without it, so
// a decoded value would re-quantize one step down); genuine sub-step values still floor down.
const quantFreeze = (p: Period): number => clampInt(Math.floor((p.freeze_m ?? 0) / FREEZE_STEP_M + 1e-9), FREEZE_ANCHOR_BITS);

// cloud band: coverage at each CLOUD_BAND_LEVELS_HPA pressure level, all riding the single cch
// bit — v3's replacement for the v2 low/mid/high trio. Same anchor+delta shape as freeze: per
// level, a 3-bit anchor then entropy-coded period-over-period deltas. Conditioning is
// deliberately just the previous value for now (internet-route testing; the vertical-neighbor
// chain is a later derive), and the tables are the v2-era low/mid/high tables mapped by each
// level's altitude — untrained for this exact use but alphabet-compatible (deltas −7..7), and
// cloud persistence is what they measure. 300 hPa (9.2 km) reads the high table, 400–700
// (7.2–3.0 km) the mid, 850–1000 (1.5–0.1 km) the low.
const CLOUD_ANCHOR_BITS = VAR_BITS_V3[VARS_BIT.cch]; // 3
const quantCover = (pct: number | undefined): number =>
  clampInt(Math.round((pct ?? 0) * 7 / 100), CLOUD_ANCHOR_BITS);
const cloudBandCodec = (bk: ClassBooks, hpa: number): DeltaCodec =>
  hpa <= 300 ? bk.cloudHighDelta : hpa <= 700 ? bk.cloudMidDelta : bk.cloudLowDelta;

// ── Air quality ────────────────────────────────────────────────────────────────
// Five columns over two incompatible index scales (see the AQI ladders in entropy.ts), all from
// CAMS, all model-independent — the `m:` center selection does not apply to any of them.
//
// THE 4-DAY CLAMP. CAMS forecasts 5 days from an init at most 12h old, so the data reaches ~4.5
// days from a request; the fill window reaches 12. Rather than pay for a per-message horizon
// field, every AQ column simply stops after the periods whose START is within AQ_HORIZON_HOURS of
// the first period's start — derived from the layout, which both sides already have, so the clamp
// costs zero wire bits (the same free-clamp idea as the GEM availability clamp in the server's
// buildLayoutMessage). 96h is deliberately inside the ~108h worst case, so the clamp bites before
// the data runs out; a ragged edge inside it still has the ladder's no-data symbol to fall back
// on. Periods past the clamp carry no AQ symbols at all and decode with the fields absent —
// "not forecast", which is what the app draws as an empty cell.
export const AQ_HORIZON_HOURS = 96;
const AQ_ANCHOR_BITS = VAR_BITS_V3[VARS_BIT.aqi]; // 5; every AQ column shares the width

// How many leading periods an AQ column covers. Always ≥ 1 (the first period starts at offset 0).
export function aqPeriodCount(periodHours: number[]): number {
  let start = 0;
  let n = 0;
  for (const h of periodHours) {
    if (start >= AQ_HORIZON_HOURS) break;
    n++;
    start += h;
  }
  return n;
}

// The eleven plain anchor+delta AQ columns, in body order — every constituent of both indices.
// The two HEADLINES are NOT here: each conditions on its own scale's sub-indices, so both encode
// after every column they might read. Within this list PM2.5, ozone and PM10 come first on each
// scale because they are the three a headline residual can key on (AQI_BASE_* in entropy.ts);
// the rest never lead an index and are carried purely because a reader may want to see them.
// `tod` marks the columns whose driver is diurnal — ozone is photochemical, NO2 follows the
// traffic cycle — and is ignored by the others' books.
type AqField =
  | "aqi_pm25" | "aqi_o3" | "aqi_pm10" | "aqi_no2" | "aqi_so2"
  | "aqi_eu_pm25" | "aqi_eu_o3" | "aqi_eu_pm10" | "aqi_eu_no2" | "aqi_eu_so2";
const AQ_DELTA_COLUMNS: {
  bit: number;
  field: AqField;
  lower: readonly number[];
  bookOf(bk: ClassBooks): (res: number, tod: number, prevDelta: number | null) => CodeBook;
}[] = [
  { bit: VARS_BIT.aq_pm25, field: "aqi_pm25", lower: AQI_US_LOWER,
    bookOf: (bk) => (res, _tod, prev) => bk.aqPm25Book(res, prev) },
  { bit: VARS_BIT.aq_o3, field: "aqi_o3", lower: AQI_US_LOWER,
    bookOf: (bk) => (res, tod, prev) => bk.aqO3Book(res, tod, prev) },
  { bit: VARS_BIT.aq_pm10, field: "aqi_pm10", lower: AQI_US_LOWER,
    bookOf: (bk) => (res, _tod, prev) => bk.aqPm10Book(res, prev) },
  { bit: VARS_BIT.aq_no2, field: "aqi_no2", lower: AQI_US_LOWER,
    bookOf: (bk) => (res, tod, prev) => bk.aqNo2Book(res, tod, prev) },
  { bit: VARS_BIT.aq_so2, field: "aqi_so2", lower: AQI_US_LOWER,
    bookOf: (bk) => (res, _tod, prev) => bk.aqSo2Book(res, prev) },
  { bit: VARS_BIT.aqi_eu_pm25, field: "aqi_eu_pm25", lower: AQI_EU_LOWER,
    bookOf: (bk) => (res, _tod, prev) => bk.aqiEuPm25Book(res, prev) },
  { bit: VARS_BIT.aqi_eu_o3, field: "aqi_eu_o3", lower: AQI_EU_LOWER,
    bookOf: (bk) => (res, tod, prev) => bk.aqiEuO3Book(res, tod, prev) },
  { bit: VARS_BIT.aqi_eu_pm10, field: "aqi_eu_pm10", lower: AQI_EU_LOWER,
    bookOf: (bk) => (res, _tod, prev) => bk.aqiEuPm10Book(res, prev) },
  { bit: VARS_BIT.aqi_eu_no2, field: "aqi_eu_no2", lower: AQI_EU_LOWER,
    bookOf: (bk) => (res, tod, prev) => bk.aqiEuNo2Book(res, tod, prev) },
  { bit: VARS_BIT.aqi_eu_so2, field: "aqi_eu_so2", lower: AQI_EU_LOWER,
    bookOf: (bk) => (res, _tod, prev) => bk.aqiEuSo2Book(res, prev) },
];

// One headline's residual wiring: which sub-index columns can form its baseline, and which
// presence masks are actually cheaper as a residual than as the headline's own deltas.
interface AqHeadline {
  bit: number;
  field: "aqi" | "aqi_eu";
  lower: readonly number[];
  // The three constituents that ever lead this index, in AQI_BASE_* bit order.
  baseBits: [pm25: number, o3: number, pm10: number];
  residualMasks: ReadonlySet<number>;
  residualBook(bk: ClassBooks, res: number, baseMask: number): CodeBook;
  deltaBook(bk: ClassBooks, res: number, tod: number, prevDelta: number | null): CodeBook;
  // The dominant-pollutant column that rides this headline: which constituent it is reporting.
  dominantField: "aqi_dominant" | "aqi_eu_dominant";
  nDominant: number;
  dominantUnknown: number;
  dominantBook(bk: ClassBooks, prev: number | null): CodeBook;
}
const AQ_HEADLINES: AqHeadline[] = [
  {
    bit: VARS_BIT.aqi, field: "aqi", lower: AQI_US_LOWER,
    baseBits: [VARS_BIT.aq_pm25, VARS_BIT.aq_o3, VARS_BIT.aq_pm10],
    residualMasks: AQI_US_RESIDUAL_MASKS,
    residualBook: (bk, res, m) => bk.aqiResidualBook(res, m),
    deltaBook: (bk, res, tod, prev) => bk.aqiDeltaBook(res, tod, prev),
    dominantField: "aqi_dominant", nDominant: aqDominantNSym(AQ_DOMINANT_US),
    dominantUnknown: aqDominantUnknown(AQ_DOMINANT_US),
    dominantBook: (bk, prev) => bk.aqDominantBook(prev),
  },
  {
    bit: VARS_BIT.aqi_eu, field: "aqi_eu", lower: AQI_EU_LOWER,
    baseBits: [VARS_BIT.aqi_eu_pm25, VARS_BIT.aqi_eu_o3, VARS_BIT.aqi_eu_pm10],
    residualMasks: AQI_EU_RESIDUAL_MASKS,
    residualBook: (bk, res, m) => bk.aqiEuResidualBook(res, m),
    deltaBook: (bk, res, tod, prev) => bk.aqiEuBook(res, tod, prev),
    dominantField: "aqi_eu_dominant", nDominant: aqDominantNSym(AQ_DOMINANT_EU),
    dominantUnknown: aqDominantUnknown(AQ_DOMINANT_EU),
    dominantBook: (bk, prev) => bk.aqDominantEuBook(prev),
  },
];

// Which of a headline's three keyable constituents vars_mask carries, as an AQI_BASE_* mask.
// Derived identically on both sides, so selecting the mode costs no wire bits.
const aqBaseMask = (h: AqHeadline, varsMask: number): number => {
  const [pm25, o3, pm10] = h.baseBits;
  return (varsMask & (1 << pm25) ? AQI_BASE_PM25 : 0)
    | (varsMask & (1 << o3) ? AQI_BASE_O3 : 0)
    | (varsMask & (1 << pm10) ? AQI_BASE_PM10 : 0);
};

// Value columns (precip chance, snow, rain), in body (column-major) order: each cell's quantized
// value is entropy-coded directly — no anchor, no deltas — under a codebook keyed by (the period's
// resolution, the SAME cell's weathercode class, the previously decoded value), or the variable's
// bootstrap table for the column's first cell (see precipBook/snowBook/rainBook in entropy.ts).
// The weathercode column decodes first and is always present, so its class is free context for
// all three — the same trick the 600/700 hPa wind columns play on the upper pressure level, and
// worth 0.10-0.33 b/period each (see WEATHERCODE_CLASS in entropy.ts). Values, not deltas,
// because zero is an absorbing regime: "still dry" is the single strongest signal these columns
// carry, and a delta of 0 would conflate it with "steady heavy snowfall". This replaced the
// adaptive best-of (raw / FOR / sparse / empty + 2-bit selector) scheme — sparse charged a full
// bit per dry period where the order-1 tables charge a small fraction of one. temp (bit 1),
// freeze (bit 3) and the cloud band (bit 9) are handled separately in buildBody/decode below.
const VALUE_COLUMNS: {
  bit: number;
  bookOf(bk: ClassBooks): (res: number, wcClass: number, prev: number | null) => CodeBook;
  get(p: Period): number;          // quantized value symbol
  set(p: Period, v: number): void; // dequantize the symbol back onto the period
}[] = [
  { bit: 0, bookOf: (bk) => bk.precipBook,
    get: (p) => clampInt(Math.round((p.precip ?? 0) * 7 / 100), 3),
    set: (p, v) => { p.precip = Math.round(v * 100 / 7); } },
  { bit: 2, bookOf: (bk) => bk.snowBook,
    get: (p) => compandSqrt(p.snow_cm ?? 0, SNOW_K, ACCUM_BITS),
    set: (p, v) => { p.snow_cm = expandSqrt(v, SNOW_K); } },
  { bit: 12, bookOf: (bk) => bk.rainBook,
    get: (p) => compandSqrt(p.rain_mm ?? 0, RAIN_K, ACCUM_BITS),
    set: (p, v) => { p.rain_mm = expandSqrt(v, RAIN_K); } },
];

// Wind columns (surface gusts + surface + 500/600/700 hPa): speed + direction per cell, both
// entropy-coded under tables keyed by context both sides already have — each period's
// resolution, the column's level, and another column's already-decoded same-period values (see
// gustDeltaBook/sfcSpeedBook/windSpeedBook/windDirBook in entropy.ts). `upperBit` names the
// column conditioned on, applied only when that column is present in vars_mask (conditioning
// columns encode/decode first in this array's order). GUST LEADS: it carries the peak-wind
// story and conditions the surface column — not the reverse — so surface wind can one day
// leave the always-on set without touching gust (direction of conditioning is bit-neutral;
// the option value decided it, 2026-07-31). 600/700 hPa condition on the level above, since
// adjacent pressure levels share the synoptic flow. Calm periods (force ≤ CALM_MAX_FORCE)
// carry no direction symbol at all — see buildBody. `dir: null` marks a speed-only column
// (gusts). All speeds share the extended-Beaufort quantization (see WIND_FORCE_BITS above);
// `level` indexes the unconditioned windSpeedDelta table axis (level 0 = the surface fallback
// when gust is absent).
const WIND_COLUMNS: {
  bit: number; kph: keyof Period; dir: keyof Period | null; level: number; upperBit: number;
}[] = [
  { bit: 8, kph: "wind_gust_kph", dir: null, level: 0, upperBit: -1 },
  { bit: 4, kph: "wind_sfc_kph", dir: "wind_sfc_dir", level: 0, upperBit: 8 },
  { bit: 5, kph: "wind_500_kph", dir: "wind_500_dir", level: 1, upperBit: -1 },
  { bit: 6, kph: "wind_600_kph", dir: "wind_600_dir", level: 2, upperBit: 5 },
  { bit: 7, kph: "wind_700_kph", dir: "wind_700_dir", level: 3, upperBit: 6 },
];

// Per-period codebook resolution index (0..4 = 24h..1h) from each period's span. The fill mixes
// resolutions within one message, and both sides know the layout (the encoder from
// msg.periodHours, the decoder from layoutFor), so a per-period table key costs no wire bits.
// A period-over-period delta at a resolution boundary is keyed by the ARRIVING period's
// resolution — the step it spans.
const HOURS_TO_RES: Record<number, number> = { 24: 0, 12: 1, 6: 2, 3: 3, 1: 4 };
const resTableIdx = (periodHours: number[]): number[] =>
  periodHours.map((h) => HOURS_TO_RES[h] ?? 0);

// Per-period local time-of-day bucket (see tempTodBucket in entropy.ts), from the first period's
// UTC start hour (msg.hour — layout-derived on both sides), the contiguous period spans, and the
// location's UTC offset — all context both sides already have, so it costs no wire bits. Periods
// are contiguous by construction (see layoutFor), so start times are prefix sums of the spans;
// half-hours keep the midpoint integral at every resolution.
const todTableIdx = (firstHour: number, periodHours: number[], utcOffsetHours: number): number[] => {
  const out: number[] = [];
  let startHalfHours = (firstHour + utcOffsetHours) * 2;
  for (const h of periodHours) {
    out.push(tempTodBucket(startHalfHours + h)); // midpoint = start + h/2
    startHalfHours += 2 * h;
  }
  return out;
};

// A sequential reader over the entropy-coded body: convenience wrappers for each codec around
// the shared SymSource (which owns the coder state). `books` is the codebook class the header
// selected — the table set every symbol decodes under.
function reader(bits: number[], books: ClassBooks) {
  const src = makeBitSource(bits);
  return {
    int: (n: number): number => src.raw(n),
    weathercode: (prevSym: number | null): number => books.decodeWeathercode(src, prevSym),
    sym: (book: CodeBook): number => src.sym(book),
    windSpeedDelta: (book: CodeBook): number => decodeWindSpeedDelta(src, book),
    freezeDelta: (book: CodeBook): number => decodeFreezeDelta(src, book),
    aqiDelta: (book: CodeBook): number => decodeAqiDelta(src, book),
    delta: (codec: DeltaCodec): number => codec.decode(src),
    tempDelta: (book: CodeBook): number => decodeTempDelta(src, book),
    assertDone: (): void => src.assertDone(),
  };
}

// The packed header is plain fixed-width MSB-first bits — not part of the body's rANS stream —
// so it gets a plain bit cursor, not a SymSource.
function headerReader(bits: number[]) {
  let pos = 0;
  return {
    int(n: number): number { const [v, p] = takeInt(bits, pos, n); pos = p; return v; },
  };
}

// Visits every cell in column-major (period-major, model-minor) order.
function eachCell(nPeriods: number, nModels: number, fn: (p: number, m: number) => void): void {
  for (let p = 0; p < nPeriods; p++) for (let m = 0; m < nModels; m++) fn(p, m);
}

// ── Top-level codec ────────────────────────────────────────────────────────────

// Column-name map (bit → var label from VARS_BIT), for the instrumented breakdown below.
const BIT_NAME: Record<number, string> = Object.fromEntries(
  Object.entries(VARS_BIT).map(([name, bit]) => [bit, name]),
);

// Callback receiving each column's contribution as it is emitted: label and bit cost.
type ColumnSink = (name: string, bits: number) => void;

// Build the column-major body under one codebook class's table set (shared by the string
// encoder — which tries every class and keeps the cheapest — and the instrumented breakdown).
// The optional sink observes per-column bit costs without changing the bytes produced. The
// returned sink exposes `cost` (exact model bits) without serializing, so the class search
// only pays for serialization once, on the winner.
function buildBody(msg: ForecastMessage, books: ClassBooks, sink?: ColumnSink): ReturnType<typeof makeBitSink> {
  const nModels = msg.periods.length;
  const nPeriods = msg.periods[0].length;
  const res = resTableIdx(msg.periodHours);
  const em = makeBitSink();
  const mark = (name: string, before: number) => sink?.(name, em.cost - before);

  // Weathercode column (always present, entropy-coded). Each symbol's codebook is keyed by the
  // previously encoded symbol — null (the bootstrap table) for the first symbol of the sequence.
  // The symbols are kept: their classes key the value columns below, and taking the class from the
  // ENCODED symbol (not the raw input code, which may not be a known WMO code) is what keeps the
  // encoder's context identical to the decoder's.
  let before = em.cost;
  let prevWcSym: number | null = null;
  const wcSym: number[][] = msg.periods.map((rows) => rows.map(() => 0));
  eachCell(nPeriods, nModels, (p, m) => {
    const idx = WMO2IDX[msg.periods[m][p].weathercode] ?? 0;
    books.encodeWeathercode(em, prevWcSym, idx);
    wcSym[m][p] = idx;
    prevWcSym = idx;
  });
  mark("weathercode", before);

  // temp: per model, an anchor (first period, full width) followed by entropy-coded
  // period-over-period deltas — never diffed across a model boundary. Each delta's codebook is
  // keyed by (the arriving period's resolution and time-of-day bucket, the previous decoded
  // delta) — see tempDeltaBook in entropy.ts; the model's first delta uses the bootstrap table.
  // A delta beyond the escape field's range (|jump| > 32°C between periods) is clamped to
  // TEMP_DELTA_MIN..TEMP_DELTA_MAX, and every later delta is diffed against the decoder's
  // reconstruction, so the error heals on the next period instead of offsetting the rest of the
  // column. CRITICAL: the context chains the CLAMPED delta (what the decoder will decode), never
  // the raw input difference — otherwise the two sides' contexts diverge after a clamp.
  const tod = todTableIdx(msg.hour, msg.periodHours, msg.utcOffsetHours);
  // The clamped temp deltas ([model][period], p ≥ 1) are kept: they key the freeze column's
  // codebooks below, and keeping the CLAMPED value (what the decoder reconstructs) rather than
  // the raw input difference is what keeps the two sides' freeze contexts identical.
  let tempDeltas: number[][] | null = null;
  for (const [bit, field, name] of TEMP_DELTA_COLUMNS) {
    if (!(msg.vars_mask & (1 << bit))) continue;
    before = em.cost;
    const deltas: number[][] = msg.periods.map(() => []);
    for (let m = 0; m < nModels; m++) {
      let reconstructed = quantTemp(msg.periods[m][0], field);
      em.raw(reconstructed, TEMP_ANCHOR_BITS);
      let prevDelta: number | null = null;
      for (let p = 1; p < nPeriods; p++) {
        const delta = Math.min(Math.max(
          quantTemp(msg.periods[m][p], field) - reconstructed, TEMP_DELTA_MIN), TEMP_DELTA_MAX);
        encodeTempDelta(em, books.tempDeltaBook(res[p], tod[p], prevDelta), delta);
        reconstructed += delta;
        prevDelta = delta;
        deltas[m][p] = delta;
      }
    }
    if (bit === VARS_BIT.temp) tempDeltas = deltas;
    mark(name, before);
  }

  // freeze: per model, an anchor (first period, full width) followed by entropy-coded
  // period-over-period deltas, each under a table keyed by (the arriving period's resolution,
  // the same period's temp delta) — or the res-keyed fallback when temp is absent (see
  // freezeDeltaBook in entropy.ts).
  if (msg.vars_mask & (1 << VARS_BIT.freeze)) {
    before = em.cost;
    for (let m = 0; m < nModels; m++) {
      em.raw(quantFreeze(msg.periods[m][0]), FREEZE_ANCHOR_BITS);
      for (let p = 1; p < nPeriods; p++) {
        const book = books.freezeDeltaBook(res[p], tempDeltas ? tempDeltas[m][p] : null);
        encodeFreezeDelta(em, book, quantFreeze(msg.periods[m][p]) - quantFreeze(msg.periods[m][p - 1]));
      }
    }
    mark("freeze", before);
  }

  // cloud band: level-major — for each pressure level, per model, an anchor (first period, full
  // width) followed by entropy-coded period-over-period deltas under the altitude-mapped table
  // (see cloudBandCodec above — no per-message selector).
  if (msg.vars_mask & (1 << VARS_BIT.cch)) {
    before = em.cost;
    for (let li = 0; li < CLOUD_BAND_LEVELS_HPA.length; li++) {
      const codec = cloudBandCodec(books, CLOUD_BAND_LEVELS_HPA[li]);
      for (let m = 0; m < nModels; m++) {
        em.raw(quantCover(msg.periods[m][0].cloud_band?.[li]), CLOUD_ANCHOR_BITS);
        for (let p = 1; p < nPeriods; p++) {
          codec.encode(em, quantCover(msg.periods[m][p].cloud_band?.[li])
            - quantCover(msg.periods[m][p - 1].cloud_band?.[li]));
        }
      }
    }
    mark("cband", before);
  }

  // Air quality: per model, a ladder anchor on the first period then period-over-period deltas,
  // stopping at the 4-day clamp (aqPeriodCount). Each delta's table is keyed by the arriving
  // period's resolution, its time-of-day bucket where the column's driver is diurnal, and the
  // previous delta in the same column. Quantized values (not the raw index) are kept so the
  // headline column below can take its residual against exactly what the decoder will reconstruct.
  const nAq = aqPeriodCount(msg.periodHours);
  const aqQuant = new Map<number, number[][]>();
  for (const col of AQ_DELTA_COLUMNS) {
    if (!(msg.vars_mask & (1 << col.bit))) continue;
    before = em.cost;
    const book = col.bookOf(books);
    const q: number[][] = msg.periods.map((rows) =>
      rows.slice(0, nAq).map((c) => quantAqi(c[col.field], col.lower)));
    for (let m = 0; m < nModels; m++) {
      em.raw(q[m][0], AQ_ANCHOR_BITS);
      let prevDelta: number | null = null;
      for (let p = 1; p < nAq; p++) {
        const delta = q[m][p] - q[m][p - 1];
        encodeAqiDelta(em, book(res[p], tod[p], prevDelta), delta);
        prevDelta = delta;
      }
    }
    aqQuant.set(col.bit, q);
    mark(BIT_NAME[col.bit], before);
  }

  // The headlines, each after its own scale's constituents. With enough of {pm2.5, ozone, pm10}
  // on the wire the headline is the residual against their max — the headline IS that max, so the
  // residual is zero for every period no uncarried pollutant is leading. The residual is
  // non-negative by that definition; a negative one can only come from a band-edge rounding
  // artifact, or from upstream returning a headline of nothing while a sub-index has a value, and
  // clamping it to 0 resolves both to "the headline equals the worst sub-index we know about" —
  // the best available estimate rather than a fabricated clean reading. For the presence masks
  // where a residual costs MORE than the headline's own deltas (any single constituent, and the
  // pairs that miss too much leadership mass — see AQI_*_RESIDUAL_MASKS) the column falls back to
  // its own delta series instead.
  for (const h of AQ_HEADLINES) {
    if (!(msg.vars_mask & (1 << h.bit))) continue;
    before = em.cost;
    const q: number[][] = msg.periods.map((rows) =>
      rows.slice(0, nAq).map((c) => quantAqi(c[h.field], h.lower)));
    const baseMask = aqBaseMask(h, msg.vars_mask);
    // What the DECODER will reconstruct, which is not always q: the residual is clamped
    // non-negative, so a headline below its own baseline comes back as the baseline. The
    // dominant-pollutant pass below gates on this, so both sides agree on which periods carry a
    // symbol without spending a bit saying so.
    const recon: number[][] = msg.periods.map(() => new Array<number>(nAq).fill(0));
    if (h.residualMasks.has(baseMask)) {
      const bases = h.baseBits
        .filter((_, i) => baseMask & (1 << i))
        .map((bit) => aqQuant.get(bit)!);
      for (let m = 0; m < nModels; m++) {
        for (let p = 0; p < nAq; p++) {
          let base = 0;
          for (const b of bases) if (b[m][p] > base) base = b[m][p];
          const resid = Math.min(Math.max(q[m][p] - base, 0), AQI_RESIDUAL_MAX);
          em.sym(h.residualBook(books, res[p], baseMask), resid);
          recon[m][p] = base + resid;
        }
      }
    } else {
      for (let m = 0; m < nModels; m++) {
        em.raw(q[m][0], AQ_ANCHOR_BITS);
        recon[m][0] = q[m][0];
        let prevDelta: number | null = null;
        for (let p = 1; p < nAq; p++) {
          const delta = q[m][p] - q[m][p - 1];
          encodeAqiDelta(em, h.deltaBook(books, res[p], tod[p], prevDelta), delta);
          recon[m][p] = q[m][p];
          prevDelta = delta;
        }
      }
    }
    // Which constituent the headline is reporting, order-1 on the previous period's answer. Only
    // periods that decode to an actual reading carry one — a no-data headline has no pollutant to
    // name, and the decoder knows which those are because it reads the headline first.
    for (let m = 0; m < nModels; m++) {
      let prevDom: number | null = null;
      for (let p = 0; p < nAq; p++) {
        if (recon[m][p] === AQI_NO_DATA) continue;
        const raw = msg.periods[m][p][h.dominantField];
        const dom = raw == null ? h.dominantUnknown
          : Math.min(Math.max(Math.round(raw), 0), h.nDominant - 1);
        em.sym(h.dominantBook(books, prevDom), dom);
        prevDom = dom;
      }
    }
    mark(BIT_NAME[h.bit], before);
  }

  // Value columns (precip chance, snow, rain): each cell's quantized value entropy-coded under a
  // table keyed by (the period's resolution, the cell's own weathercode class, the previously
  // encoded value) — bootstrap for the column's first cell. The chain carries across model
  // boundaries, like weathercode.
  for (const col of VALUE_COLUMNS) {
    if (!(msg.vars_mask & (1 << col.bit))) continue;
    before = em.cost;
    const book = col.bookOf(books);
    let prev: number | null = null;
    eachCell(nPeriods, nModels, (p, m) => {
      const v = col.get(msg.periods[m][p]);
      em.sym(book(res[p], WEATHERCODE_CLASS[wcSym[m][p]], prev), v);
      prev = v;
    });
    mark(BIT_NAME[col.bit], before);
  }
  // Both sides quantize identically: a decoded band midpoint re-quantizes to its force.
  const windSpeed = (c: Period, col: (typeof WIND_COLUMNS)[number]) =>
    quantWind((c[col.kph] as number) ?? 0);
  // Quantized speeds and displayed directions of already-encoded wind columns, keyed by var
  // bit — the cross-column context for the surface (← gust) and 600/700 hPa (← level above)
  // columns; conditioning columns encode first.
  const spdByBit = new Map<number, number[][]>();
  const dispByBit = new Map<number, number[][]>();
  for (const col of WIND_COLUMNS) {
    if (!(msg.vars_mask & (1 << col.bit))) continue;
    before = em.cost;
    const upper = col.upperBit >= 0 && (msg.vars_mask & (1 << col.upperBit))
      ? { spd: spdByBit.get(col.upperBit)!, disp: dispByBit.get(col.upperBit)! }
      : null;
    // Direction context only exists when the conditioning column HAS a direction stream —
    // gust doesn't, so the surface column's dir tables stay unconditioned.
    const upperDir = upper && WIND_COLUMNS.find((c) => c.bit === col.upperBit)?.dir ? upper.disp : null;
    const spd: number[][] = msg.periods.map((rows) => rows.map((c) => windSpeed(c, col)));

    // Speed: per model, a raw force anchor then entropy-coded period-over-period deltas —
    // gust under its res-keyed tables, surface keyed by gust's same-period delta (falling back
    // to the level-0 table when gust is absent), 500/600/700 keyed by (res, level) or the level
    // above's same-period delta (see gustDeltaBook/sfcSpeedBook/windSpeedBook in entropy.ts).
    // Never diffed across a model boundary.
    for (let m = 0; m < nModels; m++) {
      em.raw(spd[m][0], WIND_FORCE_BITS);
      for (let p = 1; p < nPeriods; p++) {
        const upperDelta = upper ? upper.spd[m][p] - upper.spd[m][p - 1] : null;
        const book = col.bit === VARS_BIT.gust ? books.gustDeltaBook(res[p])
          : col.bit === VARS_BIT.wind ? books.sfcSpeedBook(res[p], upperDelta)
          : books.windSpeedBook(res[p], col.level, upperDelta);
        encodeWindSpeedDelta(em, book, spd[m][p] - spd[m][p - 1]);
      }
    }

    // Direction: entropy-coded under a table keyed by (the period's resolution, previously
    // encoded direction, and the upper level's same-period displayed direction when present).
    // Calm periods (force ≤ CALM_MAX_FORCE, < 6 kph) emit no symbol at all — direction there
    // is weather-model dither — and the context chain carries the last encoded direction across
    // the gap. disp[] is the direction a client shows for each period (last encoded, 0 before
    // any); the decoder reconstructs it identically. Speed-only columns (gusts) emit no
    // direction symbols.
    const disp: number[][] = msg.periods.map((rows) => rows.map(() => 0));
    if (col.dir) {
      const dir = col.dir;
      const eff: number[] = new Array(nModels).fill(0);
      let prevDir: number | null = null;
      eachCell(nPeriods, nModels, (p, m) => {
        if (spd[m][p] > CALM_MAX_FORCE) {
          const d = ((msg.periods[m][p][dir] as number) ?? 0) % 8;
          em.sym(books.windDirBook(res[p], prevDir, upperDir ? upperDir[m][p] : null), d);
          prevDir = d;
          eff[m] = d;
        }
        disp[m][p] = eff[m];
      });
    }
    spdByBit.set(col.bit, spd);
    dispByBit.set(col.bit, disp);

    mark(BIT_NAME[col.bit], before);
  }

  return em;
}

// lat/lon/model/vars/duration/offset and the request datetime are recovered client-side via
// `code` (RequestContext), and the period layout is derived from `seq` — so all of them are
// intentionally absent from the header. `cls` is the codebook class the body was built under —
// encoder policy (cheapest of CLASS_BOOKS), never taken from the message.
function buildHeader(msg: ForecastMessage, cls: number): number[] {
  const seq = msg.seq;
  if (!Number.isInteger(seq) || seq < 1 || seq > 1 << V3_SEQ_BITS)
    throw new Error(`v3: message has no valid fill-sequence number (seq=${seq})`);
  const headerBits: number[] = [];
  putInt(headerBits, msg.code, CODE_BITS);
  putInt(headerBits, seq - 1, V3_SEQ_BITS);
  putInt(headerBits, Math.min(Math.max(Math.round(msg.elevation / ELEV_STEP_M), 0), (1 << ELEV_BITS) - 1), ELEV_BITS);
  putInt(headerBits, cls, CLASS_BITS);
  return headerBits;
}

// Builds the body under every codebook class and keeps the cheapest — the selector this buys is
// 3 free header bits, so the only cost is encoder CPU. Deterministic: model cost is exact and
// ties break to the lowest class, so re-encoding a decoded message reproduces the same string.
// The optional sink observes the WINNING class's per-column costs (that pass is rebuilt so the
// search itself stays sink-free).
function buildBestBody(msg: ForecastMessage, sink?: ColumnSink): { em: ReturnType<typeof makeBitSink>; cls: number } {
  let best = { em: buildBody(msg, CLASS_BOOKS[0]), cls: 0 };
  for (let cls = 1; cls < CLASS_BOOKS.length; cls++) {
    const em = buildBody(msg, CLASS_BOOKS[cls]);
    if (em.cost < best.em.cost) best = { em, cls };
  }
  if (sink) buildBody(msg, CLASS_BOOKS[best.cls], sink);
  return best;
}

// The version tag and packed header are always base-85; only the body follows `alphabet`. See
// the Alphabet type in codec.ts for why the ASCII prefix is the cheaper choice even on the
// route that wants a wide body.
function encodeBodyIn(alphabet: Alphabet, bits: number[]): string {
  return alphabet === "base32768" ? encodeBodyWide(bits) : encodeBodyLE(bits, alphabet);
}

export function v3MessageToString(msg: ForecastMessage, alphabet: Alphabet = "base85"): string {
  const { em, cls } = buildBestBody(msg);
  return encodeVersion(VERSION) + encode(buildHeader(msg, cls)) + encodeBodyIn(alphabet, em.bits);
}

// One column's contribution to a message: its model cost in (fractional) bits.
export interface ColumnBreakdown { name: string; bits: number }

// Per-column bit accounting for a message, for encoding experiments. Produces the identical string
// as v3MessageToString (via the same buildBestBody), plus the bit cost of the version prefix,
// packed header, weathercode, and every present variable column.
export interface V3Breakdown {
  encoded: string;
  chars: number;
  versionBits: number;   // self-describing version prefix
  headerBits: number;    // packed header (code/seq/elev/class)
  bodyBits: number;      // actual serialized body bits (rANS state + renorm words)
  overheadBits: number;  // bodyBits − Σ columns[].bits: the coder's flush/renorm slack
  codebookClass: number; // the class the try-all-pick-best encoder selected
  columns: ColumnBreakdown[];
}

export function v3EncodeBreakdown(msg: ForecastMessage, alphabet: Alphabet = "base85"): V3Breakdown {
  const columns: ColumnBreakdown[] = [];
  const { em, cls } = buildBestBody(msg, (name, bits) => columns.push({ name, bits }));
  const body = em.bits;
  const encoded = encodeVersion(VERSION) + encode(buildHeader(msg, cls)) + encodeBodyIn(alphabet, body);
  const modelBits = columns.reduce((s, c) => s + c.bits, 0);
  return {
    encoded,
    chars: encoded.length,
    versionBits: VERSION_PREFIX_CHARS * 7, // GSM-7 septet per prefix char
    headerBits: HEADER_BITS,
    bodyBits: body.length,
    overheadBits: body.length - modelBits,
    codebookClass: cls,
    columns,
  };
}

// Reads the fixed-width prefix — version tag plus packed header — WITHOUT touching the body.
//
// Split out of the decode path (which calls it) because the prefix is readable from a message
// that is only partly in hand: it is fixed-width and MSB-first, where the body's rANS stream
// needs its every last character. That is what lets a reader who was handed a reply in pieces be
// told which forecast the first piece belongs to, before there is enough of it to decode (see
// parts.ts). Throws on anything that isn't this version's prefix.
export function v3HeaderFromString(s: string): MessageHeader {
  const [version, rest] = takeVersion(s);
  if (version !== VERSION)
    throw new Error(`Version mismatch: encoded v${version}, expected v${VERSION}`);

  if (rest.length < HEADER_CHARS)
    throw new Error(`Unexpected message length: ${s.length} chars`);

  const hr = headerReader(decode(rest.slice(0, HEADER_CHARS), HEADER_BITS));
  const code = hr.int(CODE_BITS);
  const seq = hr.int(V3_SEQ_BITS) + 1;
  const elevation = hr.int(ELEV_BITS) * ELEV_STEP_M;
  const codebookClass = hr.int(CLASS_BITS);
  if (codebookClass >= CODEBOOK_CLASSES)
    throw new Error(`v3: unknown codebook class ${codebookClass} (this build has ${CODEBOOK_CLASSES})`);

  return { version, code, seq, elevation, codebookClass };
}

export function v3MessageFromString(s: string, resolve: ContextResolver): ForecastMessage {
  const { version, code, seq, elevation, codebookClass } = v3HeaderFromString(s);
  const rest = s.slice(VERSION_PREFIX_CHARS);

  // Recover the request-echo fields the slim header omits.
  const ctx = resolve(code);
  if (!ctx) throw new Error(`Unknown forecast code ${code}: no matching request in the store`);
  const { model, vars_mask, lat, lon, start, mode, utcOffsetHours, device } = ctx;
  if (mode == null || utcOffsetHours == null)
    throw new Error(`Forecast code ${code} matches a request without a priority mode`);
  // The mode the message was BUILT under, which for a short-horizon center isn't the one that
  // was asked for (see effectiveMode). The stored request holds the requested mode — clients
  // send and keep what the user picked — so the substitution is redone here against the same
  // model the server resolved it against. Only the layout reads this; the message reports the
  // requested mode, since that's what the reader chose and what the reply answers.
  const layoutMode = effectiveMode(mode, model);
  if (seq > maxFillSeq(layoutMode))
    throw new Error(`v3: seq ${seq} exceeds mode ${layoutMode}'s fill sequence`);
  const models_mask = 1 << model; // a response carries exactly one model

  // The period layout is derived, not decoded: both sides compute it from the stored request.
  const requestUtcHour = Math.floor(start / 3600000);
  const layout = layoutFor(layoutMode, requestUtcHour, utcOffsetHours, seq);

  // month/day/hour describe the FIRST PERIOD's start (which precedes the request time — the
  // first period is the one containing it), so display code can lay periods out from it.
  const firstStart = new Date(layout.periodStartUtcHour[0] * 3600000);

  // The body has no length field: the rANS stream is self-delimiting given the known structure
  // (nPeriods, nModels, vars_mask). decodeBodyAuto materializes the meaningful low bits, in
  // whichever alphabet the body arrived in; renorm words past them read as 0 — exactly the
  // trailing zero words the body encoder dropped. The first period's UTC start hour and the UTC
  // offset key the temp time-of-day tables — the identical values the encoder used (msg.hour is
  // layout-derived on both sides).
  //
  // The alphabet comes from the request's route, not the body: the server chose it off the same
  // DEVICE_TRANSPORT row when it encoded, so reading it back off the stored `d:` is exact where
  // inspecting the characters can only be a guess. A context without a route (one stored before
  // the field existed) leaves decodeBodyAuto to guess, which it can still do correctly for every
  // alphabet older than that context.
  const periods = decodeBody(
    decodeBodyAuto(rest.slice(HEADER_CHARS), device && DEVICE_TRANSPORT[device].alphabet),
    CLASS_BOOKS[codebookClass], vars_mask,
    layout.periodHours, firstStart.getUTCHours(), utcOffsetHours, 1);

  return {
    version,
    code,
    codebookClass,
    days: layout.days,
    models_mask,
    vars_mask,
    month: firstStart.getUTCMonth() + 1,
    day: firstStart.getUTCDate(),
    hour: firstStart.getUTCHours(),
    lat,
    lon,
    elevation,
    periods,
    seq,
    mode,
    periodHours: layout.periodHours,
    utcOffsetHours,
  };
}

// Decodes the column-major body written by buildBody, given the structure the header/context
// implies (`periodHours` is the derived layout — it keys the wind tables per period). Throws
// unless the stream is consumed exactly (see SymSource.assertDone).
function decodeBody(
  bodyBits: number[], books: ClassBooks, vars_mask: number, periodHours: number[],
  firstHour: number, utcOffsetHours: number, nModels: number,
): Period[][] {
  const nPeriods = periodHours.length;
  const rd = reader(bodyBits, books);

  const periods: Period[][] = Array.from({ length: nModels }, () =>
    Array.from({ length: nPeriods }, () => ({ weathercode: 0 } as Period)));

  // Weathercode column (entropy-coded, each symbol keyed by the previously decoded symbol). The
  // symbols are kept — their classes key the value columns below, mirroring buildBody.
  let prevWcSym: number | null = null;
  const wcSym: number[][] = periods.map((rows) => rows.map(() => 0));
  eachCell(nPeriods, nModels, (p, m) => {
    const sym = rd.weathercode(prevWcSym);
    periods[m][p].weathercode = WMO_CODES[sym] ?? 0;
    wcSym[m][p] = sym;
    prevWcSym = sym;
  });

  // Temp mirrors buildBody exactly: each delta's codebook keyed by (the arriving period's
  // resolution and time-of-day bucket, the previously decoded delta) — bootstrap for each
  // model's first delta.
  const res = resTableIdx(periodHours);
  const tod = todTableIdx(firstHour, periodHours, utcOffsetHours);
  // The decoded temp deltas ([model][period], p ≥ 1) are kept — they key the freeze column's
  // codebooks below, mirroring buildBody.
  let tempDeltas: number[][] | null = null;
  for (const [bit, field] of TEMP_DELTA_COLUMNS) {
    if (!(vars_mask & (1 << bit))) continue;
    const deltas: number[][] = periods.map(() => []);
    for (let m = 0; m < nModels; m++) {
      let quant = rd.int(TEMP_ANCHOR_BITS);
      periods[m][0][field] = quant - TEMP_OFFSET;
      let prevDelta: number | null = null;
      for (let p = 1; p < nPeriods; p++) {
        const delta = rd.tempDelta(books.tempDeltaBook(res[p], tod[p], prevDelta));
        quant += delta;
        periods[m][p][field] = quant - TEMP_OFFSET;
        prevDelta = delta;
        deltas[m][p] = delta;
      }
    }
    if (bit === VARS_BIT.temp) tempDeltas = deltas;
  }

  // Freeze mirrors buildBody exactly: each delta's table keyed by (the arriving period's
  // resolution, the same period's decoded temp delta), or the res-keyed fallback without temp.
  if (vars_mask & (1 << VARS_BIT.freeze)) {
    for (let m = 0; m < nModels; m++) {
      let quant = rd.int(FREEZE_ANCHOR_BITS);
      periods[m][0].freeze_m = quant * FREEZE_STEP_M;
      for (let p = 1; p < nPeriods; p++) {
        quant += rd.freezeDelta(books.freezeDeltaBook(res[p], tempDeltas ? tempDeltas[m][p] : null));
        periods[m][p].freeze_m = quant * FREEZE_STEP_M;
      }
    }
  }

  if (vars_mask & (1 << VARS_BIT.cch)) {
    const nLevels = CLOUD_BAND_LEVELS_HPA.length;
    for (let li = 0; li < nLevels; li++) {
      const codec = cloudBandCodec(books, CLOUD_BAND_LEVELS_HPA[li]);
      for (let m = 0; m < nModels; m++) {
        let quant = rd.int(CLOUD_ANCHOR_BITS);
        (periods[m][0].cloud_band ??= new Array<number>(nLevels).fill(0))[li] = Math.round((quant * 100) / 7);
        for (let p = 1; p < nPeriods; p++) {
          quant += rd.delta(codec);
          (periods[m][p].cloud_band ??= new Array<number>(nLevels).fill(0))[li] = Math.round((quant * 100) / 7);
        }
      }
    }
  }

  // Air quality mirrors buildBody exactly, including the 4-day clamp: only the first
  // aqPeriodCount periods carry symbols, and the periods past it are left without the fields —
  // absent means "not forecast", never "clean". A decoded no-data symbol is likewise left absent.
  const nAq = aqPeriodCount(periodHours);
  const aqQuant = new Map<number, number[][]>();
  for (const col of AQ_DELTA_COLUMNS) {
    if (!(vars_mask & (1 << col.bit))) continue;
    const book = col.bookOf(books);
    const q: number[][] = Array.from({ length: nModels }, () => new Array<number>(nAq).fill(0));
    for (let m = 0; m < nModels; m++) {
      let quant = rd.int(AQ_ANCHOR_BITS);
      q[m][0] = quant;
      periods[m][0][col.field] = aqiMid(quant, col.lower);
      let prevDelta: number | null = null;
      for (let p = 1; p < nAq; p++) {
        const delta = rd.aqiDelta(book(res[p], tod[p], prevDelta));
        quant += delta;
        q[m][p] = quant;
        periods[m][p][col.field] = aqiMid(quant, col.lower);
        prevDelta = delta;
      }
    }
    aqQuant.set(col.bit, q);
  }

  // The headlines mirror buildBody: residual against the max of whichever keyable constituents
  // vars_mask carries, or the column's own deltas for the masks where that is cheaper.
  for (const h of AQ_HEADLINES) {
    if (!(vars_mask & (1 << h.bit))) continue;
    const baseMask = aqBaseMask(h, vars_mask);
    const recon: number[][] = Array.from({ length: nModels }, () => new Array<number>(nAq).fill(0));
    if (h.residualMasks.has(baseMask)) {
      const bases = h.baseBits
        .filter((_, i) => baseMask & (1 << i))
        .map((bit) => aqQuant.get(bit)!);
      for (let m = 0; m < nModels; m++) {
        for (let p = 0; p < nAq; p++) {
          const resid = rd.sym(h.residualBook(books, res[p], baseMask));
          let base = 0;
          for (const b of bases) if (b[m][p] > base) base = b[m][p];
          recon[m][p] = base + resid;
          periods[m][p][h.field] = aqiMid(recon[m][p], h.lower);
        }
      }
    } else {
      for (let m = 0; m < nModels; m++) {
        let quant = rd.int(AQ_ANCHOR_BITS);
        recon[m][0] = quant;
        periods[m][0][h.field] = aqiMid(quant, h.lower);
        let prevDelta: number | null = null;
        for (let p = 1; p < nAq; p++) {
          const delta = rd.aqiDelta(h.deltaBook(books, res[p], tod[p], prevDelta));
          quant += delta;
          recon[m][p] = quant;
          periods[m][p][h.field] = aqiMid(quant, h.lower);
          prevDelta = delta;
        }
      }
    }
    for (let m = 0; m < nModels; m++) {
      let prevDom: number | null = null;
      for (let p = 0; p < nAq; p++) {
        if (recon[m][p] === AQI_NO_DATA) continue;
        const dom = rd.sym(h.dominantBook(books, prevDom));
        if (dom !== h.dominantUnknown) periods[m][p][h.dominantField] = dom;
        prevDom = dom;
      }
    }
  }

  // Value columns mirror buildBody exactly: each symbol's table keyed by (the period's
  // resolution, the cell's decoded weathercode class, the previously decoded value), bootstrap
  // first, chained across model boundaries.
  for (const col of VALUE_COLUMNS) {
    if (!(vars_mask & (1 << col.bit))) continue;
    const book = col.bookOf(books);
    let prev: number | null = null;
    eachCell(nPeriods, nModels, (p, m) => {
      const v = rd.sym(book(res[p], WEATHERCODE_CLASS[wcSym[m][p]], prev));
      col.set(periods[m][p], v);
      prev = v;
    });
  }
  // Wind columns mirror buildBody exactly: speeds first (anchors + deltas), then calm-gated
  // directions, with the upper column's already-decoded values as cross-level context.
  const spdByBit = new Map<number, number[][]>();
  const dispByBit = new Map<number, number[][]>();
  for (const col of WIND_COLUMNS) {
    if (!(vars_mask & (1 << col.bit))) continue;
    const upper = col.upperBit >= 0 && (vars_mask & (1 << col.upperBit))
      ? { spd: spdByBit.get(col.upperBit)!, disp: dispByBit.get(col.upperBit)! }
      : null;

    const upperDir = upper && WIND_COLUMNS.find((c) => c.bit === col.upperBit)?.dir ? upper.disp : null;
    const spd: number[][] = Array.from({ length: nModels }, () => new Array<number>(nPeriods).fill(0));
    for (let m = 0; m < nModels; m++) {
      let speed = rd.int(WIND_FORCE_BITS);
      spd[m][0] = speed;
      (periods[m][0][col.kph] as number) = beaufortMidKph(speed);
      for (let p = 1; p < nPeriods; p++) {
        const upperDelta = upper ? upper.spd[m][p] - upper.spd[m][p - 1] : null;
        const book = col.bit === VARS_BIT.gust ? books.gustDeltaBook(res[p])
          : col.bit === VARS_BIT.wind ? books.sfcSpeedBook(res[p], upperDelta)
          : books.windSpeedBook(res[p], col.level, upperDelta);
        speed += rd.windSpeedDelta(book);
        spd[m][p] = speed;
        (periods[m][p][col.kph] as number) = beaufortMidKph(speed);
      }
    }

    // Calm periods (force ≤ CALM_MAX_FORCE) carried no direction symbol; they display the last
    // decoded direction (0 before any), which is also the value the upper-context chain uses.
    // Speed-only columns (gusts) carried no direction symbols at all.
    const disp: number[][] = Array.from({ length: nModels }, () => new Array<number>(nPeriods).fill(0));
    if (col.dir) {
      const dir = col.dir;
      const eff: number[] = new Array(nModels).fill(0);
      let prevDir: number | null = null;
      eachCell(nPeriods, nModels, (p, m) => {
        if (spd[m][p] > CALM_MAX_FORCE) {
          const d = rd.sym(books.windDirBook(res[p], prevDir, upperDir ? upperDir[m][p] : null));
          prevDir = d;
          eff[m] = d;
        }
        disp[m][p] = eff[m];
        (periods[m][p][dir] as number) = eff[m];
      });
    }
    spdByBit.set(col.bit, spd);
    dispByBit.set(col.bit, disp);
  }

  // Column reads that desynced from what the encoder wrote — codebook drift or a corrupted
  // message — mean the values above are garbage; the source's end-of-stream invariant catches
  // that here (see SymSource.assertDone in entropy.ts).
  rd.assertDone();

  return periods;
}

export const v3Codec: VersionedCodec = {
  headerChars: V3_HEADER_CHARS,
  header: v3HeaderFromString,
  encode: v3MessageToString,
  decode: v3MessageFromString,
};

