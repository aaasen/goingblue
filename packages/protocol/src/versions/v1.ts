import {
  RESOLUTION_HOURS, WMO_CODES, VARS_BIT,
} from "../constants.js";
import { putInt, takeInt, compandSqrt, expandSqrt } from "../bits.js";
import { encode, decode, encodeBodyLE, decodeBodyLE, nCharsForBits } from "../codec.js";
import { encodeVersion, takeVersion, VERSION_PREFIX_CHARS } from "../version.js";
import { WMO2IDX, type Period } from "../model.js";
import type { ForecastMessage, VersionedCodec, ContextResolver } from "../model.js";
import {
  encodeWeathercode, decodeWeathercode,
  encodeWindDir, decodeWindDir,
  WIND_SPEED_DELTA, FREEZE_DELTA,
  CLOUD_HIGH_DELTA, CLOUD_MID_DELTA, CLOUD_LOW_DELTA, type DeltaCodec,
  encodeTempDelta, decodeTempDelta, chooseTempDeltaTable,
  TEMP_DELTA_TABLE_BITS, TEMP_DELTA_MIN, TEMP_DELTA_MAX,
  makeBitSink, makeBitSource, type SymSink,
} from "../entropy.js";

export const V1_VERSION = 1;
const VERSION = V1_VERSION;

// The response is slim: lat/lon/models/vars/resolution AND the start datetime are NOT on the wire.
// The client stores the request under `code` and recovers them via a ContextResolver at decode time
// (see RequestContext). The count is a period count (not days), so sub-daily resolutions can carry
// a partial final day. periods:8 stores (nPeriods - 1), i.e. 1..256 periods.
//
// The 7-bit version field lives in the shared, self-describing prefix (see version.ts), not in this
// packed header. Packed header layout (22 bits):
//   code:7 periods:8 elev:7
// The body carries no length field — it is a single rANS stream (see rans.ts), serialized
// little-endian and self-delimiting: the decoder knows the structure and consumes exactly the
// symbols the encoder wrote (see encodeBodyLE/decodeBodyLE and SymSource.assertDone).
// The weathercode column has no codebook selector either: each symbol's codebook is keyed by
// the previously decoded symbol, which both sides already have (see entropy.ts).
export const V1_PERIODS_BITS = 8;
export const V1_MAX_PERIODS = 1 << V1_PERIODS_BITS; // 256

// Message code: client-assigned key the response echoes; see RequestContext / model.ts.
const CODE_BITS = 7;
// Elevation: 7 bits in 100 m steps → 0..12700 m. It's a coarse sanity check (summit vs. valley),
// so metre precision isn't needed.
const ELEV_BITS = 7;
const ELEV_STEP_M = 100;

export const V1_HEADER_BITS =
  CODE_BITS + V1_PERIODS_BITS + ELEV_BITS; // 22
// Total chars before the body: the shared version prefix plus this version's packed header.
export const V1_HEADER_CHARS = VERSION_PREFIX_CHARS + nCharsForBits(V1_HEADER_BITS); // 1 + 4 = 5
const HEADER_BITS = V1_HEADER_BITS;
const HEADER_CHARS = nCharsForBits(V1_HEADER_BITS); // packed-header chars (excludes version prefix)

// Per-column encoding modes (2-bit selector on adaptive columns). The encoder emits whichever is
// cheapest for the column.
const MODE_RAW = 0;
const MODE_FOR = 1;     // baseline + W-bit offsets
const MODE_SPARSE = 2;  // presence bit + magnitude only when nonzero
const MODE_EMPTY = 3;   // every cell is zero — no preamble, no data
const MODE_BITS = 2;
export const MODE_NAMES = ["raw", "for", "sparse", "empty"];
const SUBWIDTH_BITS = 3; // width of the FOR offset-width / sparse magnitude-width field (0..7)

// temp/tmin: 8 bits, 1°C steps, offset -100°C → -100°C to +155°C
// snow/rain: 6 bits each, sqrt-companded (see ACCUM_* below). rain is bit 12, the slot
// formerly reserved for the removed `vis`.
export const VAR_BITS_V1 = [3, 8, 6, 4, 7, 7, 7, 7, 3, 3, 3, 3, 6, 8];
//                          ^p ^t ^s ^f ^w ^5 ^6 ^7 ^cc ^cch ^ccm ^ccl ^rain ^tmin

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
const KPH_PER_STEP = 5 * 1.609344;
const WIND_SPEED_BITS = 4; // speed steps 0..15
const WIND_SPEED_MAX = (1 << WIND_SPEED_BITS) - 1;

// A scalar column: one non-negative integer per cell, in a fixed quantized domain.
// "adaptive" columns carry a 2-bit mode selector and pick the cheapest of FOR / SPARSE / EMPTY /
// raw per message. "for" columns always use frame-of-reference (no mode selector — temperature
// picks FOR upward of 99% of the time in practice, so the selector and the raw/sparse/empty
// candidates are pure overhead there). "raw" columns are always fixed-width, no selector.
// Width is sourced from VAR_BITS_V1 so there is a single source of truth.
interface ScalarColumn {
  bit: number;
  mode: "raw" | "adaptive" | "for";
  get(p: Period): number;          // quantized integer (clamped to the field width)
  set(p: Period, v: number): void; // dequantize the integer back onto the period
}

function clampInt(v: number, width: number): number {
  return Math.min(Math.max(v, 0), (1 << width) - 1);
}

// temp/tmin: entropy-coded period-over-period deltas (see TEMP_DELTA_* in entropy.ts), not plain
// scalar columns — each model's first period is an anchor at full width, quantized the same way.
// Both fields share one codebook set: a min-of-window series behaves like a max-of-window one
// (same offset, same ~1°C-step physical process), so there's no need to derive a second table.
const TEMP_ANCHOR_BITS = VAR_BITS_V1[VARS_BIT.temp];
const quantTemp = (p: Period, field: "temp_c" | "temp_min_c"): number =>
  clampInt(Math.round((p[field] ?? 0) + TEMP_OFFSET), TEMP_ANCHOR_BITS);
const TEMP_DELTA_COLUMNS: [bit: number, field: "temp_c" | "temp_min_c", name: string][] = [
  [VARS_BIT.temp, "temp_c", "temp"],
  [VARS_BIT.tmin, "temp_min_c", "tmin"],
];

// freeze: entropy-coded period-over-period deltas under a single shared table (see FREEZE_DELTA
// in entropy.ts — no per-message selector; freeze-level delta shape doesn't vary enough by
// location/season to be worth one), not a plain scalar column. 304.8 m (1000 ft) steps,
// 0..15 (0-15000 ft).
const FREEZE_STEP_M = 304.8;
const FREEZE_ANCHOR_BITS = VAR_BITS_V1[VARS_BIT.freeze];
// The 1e-9 rescues float dust only (14 × 304.8 / 304.8 = 13.999999999999998 → 13 without it, so
// a decoded value would re-quantize one step down); genuine sub-step values still floor down.
const quantFreeze = (p: Period): number => clampInt(Math.floor((p.freeze_m ?? 0) / FREEZE_STEP_M + 1e-9), FREEZE_ANCHOR_BITS);

// cloud cover (low/mid/high): entropy-coded period-over-period deltas (see CLOUD_*_DELTA in
// entropy.ts), not plain scalar columns — same anchor+delta shape as freeze, each level under its
// own single shared table (not pooled across levels) since low/mid/high cloud persistence differs
// meaningfully by altitude. Total cloud cover (bit cc) stays a plain raw scalar column (see
// SCALAR_COLUMNS below) — untouched.
const CLOUD_ANCHOR_BITS = VAR_BITS_V1[VARS_BIT.cch]; // 3; ccm/ccl share the same width
const quantCloud = (p: Period, field: "cloud_high" | "cloud_mid" | "cloud_low"): number =>
  clampInt(Math.round((p[field] ?? 0) * 7 / 100), CLOUD_ANCHOR_BITS);
const CLOUD_DELTA_COLUMNS: {
  bit: number;
  field: "cloud_high" | "cloud_mid" | "cloud_low";
  codec: DeltaCodec;
}[] = [
  { bit: VARS_BIT.cch, field: "cloud_high", codec: CLOUD_HIGH_DELTA },
  { bit: VARS_BIT.ccm, field: "cloud_mid", codec: CLOUD_MID_DELTA },
  { bit: VARS_BIT.ccl, field: "cloud_low", codec: CLOUD_LOW_DELTA },
];

// Scalar columns, in body (column-major) order. Wind is handled separately (two ints per cell).
const SCALAR_COLUMNS: ScalarColumn[] = [
  // precip chance: adaptive — sparse/empty when mostly dry (often 0%), FOR when clustered, raw otherwise.
  { bit: 0, mode: "adaptive",
    get: (p) => clampInt(Math.round((p.precip ?? 0) * 7 / 100), 3),
    set: (p, v) => { p.precip = Math.round(v * 100 / 7); } },
  // temp (bit 1) and tmin (bit 13) are handled separately in buildBody/decode below.
  { bit: 2, mode: "adaptive",
    get: (p) => compandSqrt(p.snow_cm ?? 0, SNOW_K, ACCUM_BITS),
    set: (p, v) => { p.snow_cm = expandSqrt(v, SNOW_K); } },
  { bit: 12, mode: "adaptive",
    get: (p) => compandSqrt(p.rain_mm ?? 0, RAIN_K, ACCUM_BITS),
    set: (p, v) => { p.rain_mm = expandSqrt(v, RAIN_K); } },
  // freeze (bit 3) and cloud_high/mid/low (bits 9/10/11) are handled separately in
  // buildBody/decode below (entropy-coded deltas).
  { bit: 8, mode: "raw",
    get: (p) => clampInt(Math.round((p.cloud_total ?? 0) * 7 / 100), 3),
    set: (p, v) => { p.cloud_total = Math.round(v * 100 / 7); } },
];

// Wind columns (surface + 500/600/700 hPa): speed + direction per cell, both entropy-coded, same
// shape as temp/tmin and weathercode respectively. Speed: per model, an anchor (first period, full
// width) followed by entropy-coded period-over-period deltas under a single shared table (see
// WIND_SPEED_DELTA in entropy.ts — no per-message selector), never diffed across a model boundary. Direction: each symbol's codebook is keyed by
// the previously decoded direction (see encodeWindDir in entropy.ts), each column tracking its own
// context independently.
const WIND_COLUMNS: { bit: number; kph: keyof Period; dir: keyof Period }[] = [
  { bit: 4, kph: "wind_sfc_kph", dir: "wind_sfc_dir" },
  { bit: 5, kph: "wind_500_kph", dir: "wind_500_dir" },
  { bit: 6, kph: "wind_600_kph", dir: "wind_600_dir" },
  { bit: 7, kph: "wind_700_kph", dir: "wind_700_dir" },
];

// A sequential reader over the entropy-coded body: convenience wrappers for each codec around
// the shared SymSource (which owns the coder state).
function reader(bits: number[]) {
  const src = makeBitSource(bits);
  return {
    int: (n: number): number => src.raw(n),
    weathercode: (prevSym: number | null): number => decodeWeathercode(src, prevSym),
    windDir: (prevDir: number | null): number => decodeWindDir(src, prevDir),
    delta: (codec: DeltaCodec): number => codec.decode(src),
    tempDelta: (table: number): number => decodeTempDelta(src, table),
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

// ── Scalar column codecs ───────────────────────────────────────────────────────

// Bits needed to represent the unsigned value `n` (0 → 0 bits).
function bitWidth(n: number): number {
  return n <= 0 ? 0 : 32 - Math.clz32(n);
}

// A chosen per-column encoding: its mode tag, total bit cost, and an emitter for the body.
// Every payload here is raw (bypass) bits, so `cost` is exact under any coding substrate.
interface Candidate { mode: number; cost: number; emit: (sink: SymSink) => void; }

function rawCandidate(vals: number[], width: number): Candidate {
  return {
    mode: MODE_RAW,
    cost: vals.length * width,
    emit: (sink) => { for (const v of vals) sink.raw(v, width); },
  };
}

// Frame-of-reference: a baseline (column min) + offset width W, then each value as a W-bit offset.
function forCandidate(vals: number[], width: number): Candidate {
  let min = vals[0], max = vals[0];
  for (const v of vals) { if (v < min) min = v; if (v > max) max = v; }
  const W = bitWidth(max - min);
  return {
    mode: MODE_FOR,
    cost: width + SUBWIDTH_BITS + vals.length * W,
    emit: (sink) => {
      sink.raw(min, width);
      sink.raw(W, SUBWIDTH_BITS);
      if (W > 0) for (const v of vals) sink.raw(v - min, W);
    },
  };
}

// Sparse: a presence bit per cell, with the magnitude stored only for nonzero cells. Wins when
// the column is mostly zero (e.g. snow/rain with no precipitation in most periods).
function sparseCandidate(vals: number[], maxV: number, nonzero: number): Candidate {
  const magW = bitWidth(maxV);
  return {
    mode: MODE_SPARSE,
    cost: SUBWIDTH_BITS + vals.length + nonzero * magW,
    emit: (sink) => {
      sink.raw(magW, SUBWIDTH_BITS);
      for (const v of vals) {
        sink.raw(v > 0 ? 1 : 0, 1);
        if (v > 0) sink.raw(v, magW);
      }
    },
  };
}

// Empty: every cell is zero. No preamble, no data — the column is just its 2-bit mode selector.
const EMPTY_CANDIDATE: Candidate = { mode: MODE_EMPTY, cost: 0, emit: () => {} };

// Encodes a run of non-negative ints (each fitting `width` bits) with the cheapest adaptive mode —
// a 2-bit MODE_* selector plus the mode's payload. Shared by adaptive scalar columns and wind speed.
function encodeAdaptive(sink: SymSink, vals: number[], width: number): number {
  let maxV = 0, nonzero = 0;
  for (const v of vals) { if (v > 0) { nonzero++; if (v > maxV) maxV = v; } }

  const candidates: Candidate[] = maxV === 0
    ? [EMPTY_CANDIDATE]
    : [rawCandidate(vals, width), forCandidate(vals, width), sparseCandidate(vals, maxV, nonzero)];
  let best = candidates[0];
  for (const c of candidates) if (c.cost < best.cost) best = c;
  sink.raw(best.mode, MODE_BITS);
  best.emit(sink);
  return best.mode;
}

// Reads a payload written by forCandidate.emit: baseline + width field, then n W-bit offsets.
function decodeForPayload(rd: ReturnType<typeof reader>, width: number, n: number): number[] {
  const baseline = rd.int(width);
  const W = rd.int(SUBWIDTH_BITS);
  const out = new Array<number>(n).fill(0);
  for (let i = 0; i < n; i++) out[i] = baseline + (W > 0 ? rd.int(W) : 0);
  return out;
}

// Reads `n` ints written by encodeAdaptive (mode selector + payload), in emit order.
function decodeAdaptive(rd: ReturnType<typeof reader>, width: number, n: number): number[] {
  const out = new Array<number>(n).fill(0);
  const mode = rd.int(MODE_BITS);
  switch (mode) {
    case MODE_RAW:
      for (let i = 0; i < n; i++) out[i] = rd.int(width);
      break;
    case MODE_FOR:
      return decodeForPayload(rd, width, n);
    case MODE_SPARSE: {
      const magW = rd.int(SUBWIDTH_BITS);
      for (let i = 0; i < n; i++) out[i] = rd.int(1) ? rd.int(magW) : 0;
      break;
    }
    case MODE_EMPTY:
      break;
    default:
      throw new Error(`v1: unsupported column mode ${mode}`);
  }
  return out;
}

// Encodes one scalar column into `body`, returning the chosen adaptive mode (MODE_*), or -1 for a
// column with no mode selector (raw, and forced-FOR columns report MODE_FOR for the breakdown even
// though they carry no selector bit).
function encodeScalarColumn(
  sink: SymSink, col: ScalarColumn, periods: Period[][], nPeriods: number, nModels: number,
): number {
  const width = VAR_BITS_V1[col.bit];
  const vals: number[] = [];
  eachCell(nPeriods, nModels, (p, m) => vals.push(col.get(periods[m][p])));

  switch (col.mode) {
    case "raw":
      for (const v of vals) sink.raw(v, width);
      return -1;
    case "for":
      forCandidate(vals, width).emit(sink);
      return MODE_FOR;
    case "adaptive":
      return encodeAdaptive(sink, vals, width);
  }
}

function decodeScalarColumn(
  rd: ReturnType<typeof reader>, col: ScalarColumn, periods: Period[][],
  nPeriods: number, nModels: number,
): void {
  const width = VAR_BITS_V1[col.bit];
  if (col.mode === "raw") {
    eachCell(nPeriods, nModels, (p, m) => col.set(periods[m][p], rd.int(width)));
    return;
  }
  const n = nPeriods * nModels;
  const vals = col.mode === "for" ? decodeForPayload(rd, width, n) : decodeAdaptive(rd, width, n);
  let i = 0;
  eachCell(nPeriods, nModels, (p, m) => col.set(periods[m][p], vals[i++]));
}

// ── Top-level codec ────────────────────────────────────────────────────────────

// Column-name map (bit → var label from VARS_BIT), for the instrumented breakdown below.
const BIT_NAME: Record<number, string> = Object.fromEntries(
  Object.entries(VARS_BIT).map(([name, bit]) => [bit, name]),
);

// Callback receiving each column's contribution as it is emitted: label, bit cost, and the chosen
// adaptive mode (MODE_*), or -1 for columns with no mode selector (weathercode, wind, non-adaptive).
type ColumnSink = (name: string, bits: number, mode: number) => void;

// Build the column-major body (shared by the string encoder and the instrumented breakdown). The
// optional sink observes per-column bit costs without changing the bytes produced.
function buildBody(msg: ForecastMessage, sink?: ColumnSink): { body: number[] } {
  const nModels = msg.periods.length;
  const nPeriods = msg.periods[0].length;
  const em = makeBitSink();
  const mark = (name: string, before: number, mode: number) => sink?.(name, em.cost - before, mode);

  // Weathercode column (always present, entropy-coded). Each symbol's codebook is keyed by the
  // previously encoded symbol — null (the bootstrap table) for the first symbol of the sequence.
  let before = em.cost;
  let prevWcSym: number | null = null;
  eachCell(nPeriods, nModels, (p, m) => {
    const idx = WMO2IDX[msg.periods[m][p].weathercode] ?? 0;
    encodeWeathercode(em, prevWcSym, idx);
    prevWcSym = idx;
  });
  mark("weathercode", before, -1);

  // temp/tmin: per model, an anchor (first period, full width) followed by entropy-coded
  // period-over-period deltas — never diffed across a model boundary. Each column picks its own
  // cheapest-of-16 table (see TEMP_DELTA_* in entropy.ts) from the same shared codebook set.
  // A delta beyond the escape field's range (|jump| > 32°C between periods — possible at daily
  // resolution) is clamped to TEMP_DELTA_MIN..TEMP_DELTA_MAX, and every later delta is diffed
  // against the decoder's reconstruction, so the error heals on the next period instead of
  // offsetting the rest of the column.
  for (const [bit, field, name] of TEMP_DELTA_COLUMNS) {
    if (!(msg.vars_mask & (1 << bit))) continue;
    before = em.cost;
    const anchors: number[] = [];
    const modelDeltas: number[][] = [];
    const allDeltas: number[] = [];
    for (let m = 0; m < nModels; m++) {
      let reconstructed = quantTemp(msg.periods[m][0], field);
      anchors.push(reconstructed);
      const deltas: number[] = [];
      for (let p = 1; p < nPeriods; p++) {
        const delta = Math.min(Math.max(
          quantTemp(msg.periods[m][p], field) - reconstructed, TEMP_DELTA_MIN), TEMP_DELTA_MAX);
        deltas.push(delta);
        allDeltas.push(delta);
        reconstructed += delta;
      }
      modelDeltas.push(deltas);
    }
    const table = chooseTempDeltaTable(allDeltas);
    em.raw(table, TEMP_DELTA_TABLE_BITS);
    for (let m = 0; m < nModels; m++) {
      em.raw(anchors[m], TEMP_ANCHOR_BITS);
      for (const delta of modelDeltas[m]) encodeTempDelta(em, table, delta);
    }
    mark(name, before, -1);
  }

  // freeze: per model, an anchor (first period, full width) followed by entropy-coded
  // period-over-period deltas under a single shared table (see FREEZE_DELTA in entropy.ts —
  // no per-message selector).
  if (msg.vars_mask & (1 << VARS_BIT.freeze)) {
    before = em.cost;
    for (let m = 0; m < nModels; m++) {
      em.raw(quantFreeze(msg.periods[m][0]), FREEZE_ANCHOR_BITS);
      for (let p = 1; p < nPeriods; p++) {
        FREEZE_DELTA.encode(em, quantFreeze(msg.periods[m][p]) - quantFreeze(msg.periods[m][p - 1]));
      }
    }
    mark("freeze", before, -1);
  }

  // cloud cover (low/mid/high): per model, an anchor (first period, full width) followed by
  // entropy-coded period-over-period deltas, each level under its own single shared table (see
  // CLOUD_*_DELTA in entropy.ts — no per-message selector).
  for (const col of CLOUD_DELTA_COLUMNS) {
    if (!(msg.vars_mask & (1 << col.bit))) continue;
    before = em.cost;
    for (let m = 0; m < nModels; m++) {
      em.raw(quantCloud(msg.periods[m][0], col.field), CLOUD_ANCHOR_BITS);
      for (let p = 1; p < nPeriods; p++) {
        col.codec.encode(em, quantCloud(msg.periods[m][p], col.field) - quantCloud(msg.periods[m][p - 1], col.field));
      }
    }
    mark(BIT_NAME[col.bit], before, -1);
  }

  for (const col of SCALAR_COLUMNS) {
    if (!(msg.vars_mask & (1 << col.bit))) continue;
    before = em.cost;
    const mode = encodeScalarColumn(em, col, msg.periods, nPeriods, nModels);
    mark(BIT_NAME[col.bit], before, mode);
  }
  // Same float-dust epsilon as quantFreeze: a decoded speed (s × step) must re-quantize to s.
  const windSpeed = (c: Period, kph: keyof Period) =>
    Math.min(Math.floor(((c[kph] as number) ?? 0) / KPH_PER_STEP + 1e-9), WIND_SPEED_MAX);
  for (const col of WIND_COLUMNS) {
    if (!(msg.vars_mask & (1 << col.bit))) continue;
    before = em.cost;

    // Speed: per model, an anchor (first period, full width) then entropy-coded period-over-period
    // deltas under the single shared table (see WIND_SPEED_DELTA in entropy.ts).
    for (let m = 0; m < nModels; m++) {
      em.raw(windSpeed(msg.periods[m][0], col.kph), WIND_SPEED_BITS);
      for (let p = 1; p < nPeriods; p++) {
        WIND_SPEED_DELTA.encode(em, windSpeed(msg.periods[m][p], col.kph) - windSpeed(msg.periods[m][p - 1], col.kph));
      }
    }

    // Direction: order-1 conditional, keyed by the previously decoded direction.
    let prevDir: number | null = null;
    eachCell(nPeriods, nModels, (p, m) => {
      const d = ((msg.periods[m][p][col.dir] as number) ?? 0) % 8;
      encodeWindDir(em, prevDir, d);
      prevDir = d;
    });

    mark(BIT_NAME[col.bit], before, -1);
  }

  return { body: em.bits };
}

// lat/lon/models/vars/resolution and the start datetime are recovered client-side via `code`
// (RequestContext), so they are intentionally absent from the header.
function buildHeader(msg: ForecastMessage, nPeriods: number): number[] {
  const headerBits: number[] = [];
  putInt(headerBits, msg.code, CODE_BITS);
  putInt(headerBits, nPeriods - 1, V1_PERIODS_BITS);
  putInt(headerBits, Math.min(Math.max(Math.round(msg.elevation / ELEV_STEP_M), 0), (1 << ELEV_BITS) - 1), ELEV_BITS);
  return headerBits;
}

export function v1MessageToString(msg: ForecastMessage): string {
  const nPeriods = msg.periods[0].length;
  const { body } = buildBody(msg);
  return encodeVersion(VERSION) + encode(buildHeader(msg, nPeriods)) + encodeBodyLE(body);
}

// One column's contribution to a message: its model cost in (fractional) bits and, for adaptive
// columns, the mode picked.
export interface ColumnBreakdown { name: string; bits: number; mode: string | null }

// Per-column bit accounting for a message, for encoding experiments. Produces the identical string
// as v1MessageToString (via the same buildBody), plus the bit cost of the version prefix, packed
// header, weathercode, and every present variable column, with the adaptive mode each column chose.
export interface V1Breakdown {
  encoded: string;
  chars: number;
  versionBits: number;   // self-describing version prefix
  headerBits: number;    // packed header (code/periods/elev)
  bodyBits: number;      // actual serialized body bits (rANS state + renorm words)
  overheadBits: number;  // bodyBits − Σ columns[].bits: the coder's flush/renorm slack
  columns: ColumnBreakdown[];
}

export function v1EncodeBreakdown(msg: ForecastMessage): V1Breakdown {
  const nPeriods = msg.periods[0].length;
  const columns: ColumnBreakdown[] = [];
  const { body } = buildBody(msg, (name, bits, mode) =>
    columns.push({ name, bits, mode: mode < 0 ? null : MODE_NAMES[mode] }));
  const encoded = encodeVersion(VERSION) + encode(buildHeader(msg, nPeriods)) + encodeBodyLE(body);
  const modelBits = columns.reduce((s, c) => s + c.bits, 0);
  return {
    encoded,
    chars: encoded.length,
    versionBits: VERSION_PREFIX_CHARS * 7, // GSM-7 septet per prefix char
    headerBits: HEADER_BITS,
    bodyBits: body.length,
    overheadBits: body.length - modelBits,
    columns,
  };
}

export function v1MessageFromString(s: string, resolve: ContextResolver): ForecastMessage {
  const [version, rest] = takeVersion(s);
  if (version !== VERSION)
    throw new Error(`Version mismatch: encoded v${version}, expected v${VERSION}`);

  if (rest.length < HEADER_CHARS)
    throw new Error(`Unexpected message length: ${s.length} chars`);

  const headerBits = decode(rest.slice(0, HEADER_CHARS), HEADER_BITS);
  const hr = headerReader(headerBits);

  const code = hr.int(CODE_BITS);
  const periodsRaw = hr.int(V1_PERIODS_BITS);
  const elevation = hr.int(ELEV_BITS) * ELEV_STEP_M;

  // Recover the request-echo fields the slim header omits.
  const ctx = resolve(code);
  if (!ctx) throw new Error(`Unknown forecast code ${code}: no matching request in the store`);
  const { resolution, model, vars_mask, lat, lon, start } = ctx;
  const models_mask = 1 << model; // a response carries exactly one model

  // The start datetime is recovered from the client-supplied UTC start (month/day/hour aren't sent).
  const startDate = new Date(start);
  const month = startDate.getUTCMonth() + 1;
  const day = startDate.getUTCDate();
  const hour = startDate.getUTCHours();

  const resHours = RESOLUTION_HOURS[resolution] ?? 24;
  const periodsPerDay = resHours >= 24 ? 1 : 24 / resHours;
  const nPeriods = periodsRaw + 1;
  const nModels = 1;

  // The body has no length field: the rANS stream is self-delimiting given the known structure
  // (nPeriods, nModels, vars_mask). decodeBodyLE materializes the meaningful low bits; renorm
  // words past them read as 0 — exactly the trailing zero words encodeBodyLE dropped.
  const bodyBits = decodeBodyLE(rest.slice(HEADER_CHARS));
  const rd = reader(bodyBits);

  const periods: Period[][] = Array.from({ length: nModels }, () =>
    Array.from({ length: nPeriods }, () => ({ weathercode: 0 } as Period)));

  // Weathercode column (entropy-coded, each symbol keyed by the previously decoded symbol).
  let prevWcSym: number | null = null;
  eachCell(nPeriods, nModels, (p, m) => {
    const sym = rd.weathercode(prevWcSym);
    periods[m][p].weathercode = WMO_CODES[sym] ?? 0;
    prevWcSym = sym;
  });

  for (const [bit, field] of TEMP_DELTA_COLUMNS) {
    if (!(vars_mask & (1 << bit))) continue;
    const table = rd.int(TEMP_DELTA_TABLE_BITS);
    for (let m = 0; m < nModels; m++) {
      let quant = rd.int(TEMP_ANCHOR_BITS);
      periods[m][0][field] = quant - TEMP_OFFSET;
      for (let p = 1; p < nPeriods; p++) {
        quant += rd.tempDelta(table);
        periods[m][p][field] = quant - TEMP_OFFSET;
      }
    }
  }

  if (vars_mask & (1 << VARS_BIT.freeze)) {
    for (let m = 0; m < nModels; m++) {
      let quant = rd.int(FREEZE_ANCHOR_BITS);
      periods[m][0].freeze_m = quant * FREEZE_STEP_M;
      for (let p = 1; p < nPeriods; p++) {
        quant += rd.delta(FREEZE_DELTA);
        periods[m][p].freeze_m = quant * FREEZE_STEP_M;
      }
    }
  }

  for (const col of CLOUD_DELTA_COLUMNS) {
    if (!(vars_mask & (1 << col.bit))) continue;
    for (let m = 0; m < nModels; m++) {
      let quant = rd.int(CLOUD_ANCHOR_BITS);
      periods[m][0][col.field] = Math.round((quant * 100) / 7);
      for (let p = 1; p < nPeriods; p++) {
        quant += rd.delta(col.codec);
        periods[m][p][col.field] = Math.round((quant * 100) / 7);
      }
    }
  }

  for (const col of SCALAR_COLUMNS) {
    if (vars_mask & (1 << col.bit)) decodeScalarColumn(rd, col, periods, nPeriods, nModels);
  }
  for (const col of WIND_COLUMNS) {
    if (!(vars_mask & (1 << col.bit))) continue;

    for (let m = 0; m < nModels; m++) {
      let speed = rd.int(WIND_SPEED_BITS);
      (periods[m][0][col.kph] as number) = speed * KPH_PER_STEP;
      for (let p = 1; p < nPeriods; p++) {
        speed += rd.delta(WIND_SPEED_DELTA);
        (periods[m][p][col.kph] as number) = speed * KPH_PER_STEP;
      }
    }

    let prevDir: number | null = null;
    eachCell(nPeriods, nModels, (p, m) => {
      const d = rd.windDir(prevDir);
      (periods[m][p][col.dir] as number) = d;
      prevDir = d;
    });
  }

  // Column reads that desynced from what the encoder wrote — codebook drift or a corrupted
  // message — mean the values above are garbage; the source's end-of-stream invariant catches
  // that here (see SymSource.assertDone in entropy.ts).
  rd.assertDone();

  // `days` is retained on the common message shape for display; it's the calendar-day span
  // implied by the period count (a partial final day rounds up).
  const days = Math.ceil(nPeriods / periodsPerDay);
  return { version, code, days, resolution, models_mask, vars_mask, month, day, hour, lat, lon, elevation, periods };
}

export const v1Codec: VersionedCodec = {
  encode: v1MessageToString,
  decode: v1MessageFromString,
};

