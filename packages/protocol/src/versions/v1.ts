import {
  RESOLUTION_HOURS, WMO_CODES, VARS_BIT,
} from "../constants.js";
import { putInt, takeInt, compandSqrt, expandSqrt } from "../bits.js";
import { encode, decode, encodeBodyLE, decodeBodyLE, nCharsForBits } from "../codec.js";
import { encodeVersion, takeVersion, VERSION_PREFIX_CHARS } from "../version.js";
import { WMO2IDX, type Period } from "../model.js";
import type { ForecastMessage, VersionedCodec, ContextResolver } from "../model.js";
import { encodeWeathercode, decodeWeathercode, chooseWcTable } from "../huffman.js";

export const V1_VERSION = 1;
const VERSION = V1_VERSION;

// The response is slim: lat/lon/models/vars/resolution AND the start datetime are NOT on the wire.
// The client stores the request under `code` and recovers them via a ContextResolver at decode time
// (see RequestContext). The count is a period count (not days), so sub-daily resolutions can carry
// a partial final day. periods:7 stores (nPeriods - 1), i.e. 1..128 periods.
//
// The 7-bit version field lives in the shared, self-describing prefix (see version.ts), not in this
// packed header. Packed header layout (24 bits):
//   code:7 periods:7 elev:7 wc_table:3
// The body carries no length field — it is packed little-endian and self-delimiting (the decoder
// knows the structure and reads exactly the bits it needs; see encodeBodyLE/decodeBodyLE).
export const V1_PERIODS_BITS = 7;
export const V1_MAX_PERIODS = 1 << V1_PERIODS_BITS; // 128

// Message code: client-assigned key the response echoes; see RequestContext / model.ts.
const CODE_BITS = 7;
// Huffman codebook selector for the weathercode column (see huffman.ts).
const WC_TABLE_BITS = 3;
// Elevation: 7 bits in 100 m steps → 0..12700 m. It's a coarse sanity check (summit vs. valley),
// so metre precision isn't needed.
const ELEV_BITS = 7;
const ELEV_STEP_M = 100;

export const V1_HEADER_BITS =
  CODE_BITS + V1_PERIODS_BITS + ELEV_BITS + WC_TABLE_BITS; // 24
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

// temp/tmin: 7 bits, 1°C steps, offset -40°C → -40°C to +87°C
// snow/rain: 6 bits each, sqrt-companded (see ACCUM_* below). rain is bit 12, the slot
// formerly reserved for the removed `vis`.
export const VAR_BITS_V1 = [3, 7, 6, 4, 7, 7, 7, 7, 3, 3, 3, 3, 6, 7];
//                          ^p ^t ^s ^f ^w ^5 ^6 ^7 ^cc ^cch ^ccm ^ccl ^rain ^tmin

const TEMP_OFFSET = 40;

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

// A scalar column: one non-negative integer per cell, in a fixed quantized domain. `adaptive`
// columns carry a 2-bit mode selector and can use the FOR / SPARSE / EMPTY strategies; the rest
// are always raw fixed-width. Width is sourced from VAR_BITS_V1 so there is a single source of truth.
interface ScalarColumn {
  bit: number;
  adaptive: boolean;
  get(p: Period): number;          // quantized integer (clamped to the field width)
  set(p: Period, v: number): void; // dequantize the integer back onto the period
}

function clampInt(v: number, width: number): number {
  return Math.min(Math.max(v, 0), (1 << width) - 1);
}

// Scalar columns, in body (column-major) order. Wind is handled separately (two ints per cell).
const SCALAR_COLUMNS: ScalarColumn[] = [
  // precip chance: adaptive — sparse/empty when mostly dry (often 0%), FOR when clustered, raw otherwise.
  { bit: 0, adaptive: true,
    get: (p) => clampInt(Math.round((p.precip ?? 0) * 7 / 100), 3),
    set: (p, v) => { p.precip = Math.round(v * 100 / 7); } },
  { bit: 1, adaptive: true,
    get: (p) => clampInt(Math.round((p.temp_c ?? 0) + TEMP_OFFSET), 7),
    set: (p, v) => { p.temp_c = v - TEMP_OFFSET; } },
  { bit: 13, adaptive: true,
    get: (p) => clampInt(Math.round((p.temp_min_c ?? 0) + TEMP_OFFSET), 7),
    set: (p, v) => { p.temp_min_c = v - TEMP_OFFSET; } },
  { bit: 2, adaptive: true,
    get: (p) => compandSqrt(p.snow_cm ?? 0, SNOW_K, ACCUM_BITS),
    set: (p, v) => { p.snow_cm = expandSqrt(v, SNOW_K); } },
  { bit: 12, adaptive: true,
    get: (p) => compandSqrt(p.rain_mm ?? 0, RAIN_K, ACCUM_BITS),
    set: (p, v) => { p.rain_mm = expandSqrt(v, RAIN_K); } },
  { bit: 3, adaptive: true,
    get: (p) => clampInt(Math.floor((p.freeze_m ?? 0) / 304.8), 4),
    set: (p, v) => { p.freeze_m = v * 304.8; } },
  { bit: 8, adaptive: false,
    get: (p) => clampInt(Math.round((p.cloud_total ?? 0) * 7 / 100), 3),
    set: (p, v) => { p.cloud_total = Math.round(v * 100 / 7); } },
  { bit: 9, adaptive: false,
    get: (p) => clampInt(Math.round((p.cloud_high ?? 0) * 7 / 100), 3),
    set: (p, v) => { p.cloud_high = Math.round(v * 100 / 7); } },
  { bit: 10, adaptive: false,
    get: (p) => clampInt(Math.round((p.cloud_mid ?? 0) * 7 / 100), 3),
    set: (p, v) => { p.cloud_mid = Math.round(v * 100 / 7); } },
  { bit: 11, adaptive: false,
    get: (p) => clampInt(Math.round((p.cloud_low ?? 0) * 7 / 100), 3),
    set: (p, v) => { p.cloud_low = Math.round(v * 100 / 7); } },
];

// Wind columns (surface + 500/600/700 hPa): 4-bit speed + 3-bit direction per cell, always raw.
const WIND_COLUMNS: { bit: number; kph: keyof Period; dir: keyof Period }[] = [
  { bit: 4, kph: "wind_sfc_kph", dir: "wind_sfc_dir" },
  { bit: 5, kph: "wind_500_kph", dir: "wind_500_dir" },
  { bit: 6, kph: "wind_600_kph", dir: "wind_600_dir" },
  { bit: 7, kph: "wind_700_kph", dir: "wind_700_dir" },
];

// A sequential bit-cursor reader over a decoded bit array.
function reader(bits: number[]) {
  let pos = 0;
  return {
    int(n: number): number { const [v, p] = takeInt(bits, pos, n); pos = p; return v; },
    weathercode(table: number): number {
      const [sym, p] = decodeWeathercode(bits, pos, table); pos = p; return sym;
    },
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
interface Candidate { mode: number; cost: number; emit: (body: number[]) => void; }

function rawCandidate(vals: number[], width: number): Candidate {
  return {
    mode: MODE_RAW,
    cost: vals.length * width,
    emit: (body) => { for (const v of vals) putInt(body, v, width); },
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
    emit: (body) => {
      putInt(body, min, width);
      putInt(body, W, SUBWIDTH_BITS);
      if (W > 0) for (const v of vals) putInt(body, v - min, W);
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
    emit: (body) => {
      putInt(body, magW, SUBWIDTH_BITS);
      for (const v of vals) {
        putInt(body, v > 0 ? 1 : 0, 1);
        if (v > 0) putInt(body, v, magW);
      }
    },
  };
}

// Empty: every cell is zero. No preamble, no data — the column is just its 2-bit mode selector.
const EMPTY_CANDIDATE: Candidate = { mode: MODE_EMPTY, cost: 0, emit: () => {} };

// Encodes one scalar column into `body`, returning the chosen adaptive mode (MODE_*), or -1 for a
// non-adaptive (always-raw) column that carries no mode selector.
function encodeScalarColumn(
  body: number[], col: ScalarColumn, periods: Period[][], nPeriods: number, nModels: number,
): number {
  const width = VAR_BITS_V1[col.bit];
  const vals: number[] = [];
  eachCell(nPeriods, nModels, (p, m) => vals.push(col.get(periods[m][p])));

  if (!col.adaptive) {
    for (const v of vals) putInt(body, v, width);
    return -1;
  }

  let maxV = 0, nonzero = 0;
  for (const v of vals) { if (v > 0) { nonzero++; if (v > maxV) maxV = v; } }

  const candidates: Candidate[] = maxV === 0
    ? [EMPTY_CANDIDATE]
    : [rawCandidate(vals, width), forCandidate(vals, width), sparseCandidate(vals, maxV, nonzero)];
  let best = candidates[0];
  for (const c of candidates) if (c.cost < best.cost) best = c;
  putInt(body, best.mode, MODE_BITS);
  best.emit(body);
  return best.mode;
}

function decodeScalarColumn(
  rd: ReturnType<typeof reader>, col: ScalarColumn, periods: Period[][],
  nPeriods: number, nModels: number,
): void {
  const width = VAR_BITS_V1[col.bit];
  if (!col.adaptive) {
    eachCell(nPeriods, nModels, (p, m) => col.set(periods[m][p], rd.int(width)));
    return;
  }
  const mode = rd.int(MODE_BITS);
  switch (mode) {
    case MODE_RAW:
      eachCell(nPeriods, nModels, (p, m) => col.set(periods[m][p], rd.int(width)));
      return;
    case MODE_FOR: {
      const baseline = rd.int(width);
      const W = rd.int(SUBWIDTH_BITS);
      eachCell(nPeriods, nModels, (p, m) =>
        col.set(periods[m][p], baseline + (W > 0 ? rd.int(W) : 0)));
      return;
    }
    case MODE_SPARSE: {
      const magW = rd.int(SUBWIDTH_BITS);
      eachCell(nPeriods, nModels, (p, m) =>
        col.set(periods[m][p], rd.int(1) ? rd.int(magW) : 0));
      return;
    }
    case MODE_EMPTY:
      eachCell(nPeriods, nModels, (p, m) => col.set(periods[m][p], 0));
      return;
    default:
      throw new Error(`v1: unsupported column mode ${mode}`);
  }
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
function buildBody(msg: ForecastMessage, sink?: ColumnSink): { body: number[]; wcTable: number } {
  const nModels = msg.periods.length;
  const nPeriods = msg.periods[0].length;
  const body: number[] = [];
  const mark = (name: string, before: number, mode: number) => sink?.(name, body.length - before, mode);

  // Weathercode column (always present, Huffman-coded). Gather the indices first so we can pick
  // the cheapest codebook, then emit them under it.
  let before = body.length;
  const wcIdx: number[] = [];
  eachCell(nPeriods, nModels, (p, m) => wcIdx.push(WMO2IDX[msg.periods[m][p].weathercode] ?? 0));
  const wcTable = chooseWcTable(wcIdx);
  for (const idx of wcIdx) encodeWeathercode(body, wcTable, idx);
  mark("weathercode", before, -1);

  for (const col of SCALAR_COLUMNS) {
    if (!(msg.vars_mask & (1 << col.bit))) continue;
    before = body.length;
    const mode = encodeScalarColumn(body, col, msg.periods, nPeriods, nModels);
    mark(BIT_NAME[col.bit], before, mode);
  }
  for (const col of WIND_COLUMNS) {
    if (!(msg.vars_mask & (1 << col.bit))) continue;
    before = body.length;
    eachCell(nPeriods, nModels, (p, m) => {
      const c = msg.periods[m][p];
      putInt(body, Math.min(Math.floor(((c[col.kph] as number) ?? 0) / KPH_PER_STEP), 15), 4);
      putInt(body, ((c[col.dir] as number) ?? 0) % 8, 3);
    });
    mark(BIT_NAME[col.bit], before, -1);
  }

  return { body, wcTable };
}

// lat/lon/models/vars/resolution and the start datetime are recovered client-side via `code`
// (RequestContext), so they are intentionally absent from the header.
function buildHeader(msg: ForecastMessage, nPeriods: number, wcTable: number): number[] {
  const headerBits: number[] = [];
  putInt(headerBits, msg.code, CODE_BITS);
  putInt(headerBits, nPeriods - 1, V1_PERIODS_BITS);
  putInt(headerBits, Math.min(Math.max(Math.round(msg.elevation / ELEV_STEP_M), 0), (1 << ELEV_BITS) - 1), ELEV_BITS);
  putInt(headerBits, wcTable, WC_TABLE_BITS);
  return headerBits;
}

export function v1MessageToString(msg: ForecastMessage): string {
  const nPeriods = msg.periods[0].length;
  const { body, wcTable } = buildBody(msg);
  return encodeVersion(VERSION) + encode(buildHeader(msg, nPeriods, wcTable)) + encodeBodyLE(body);
}

// One column's contribution to a message: its bit cost and, for adaptive columns, the mode picked.
export interface ColumnBreakdown { name: string; bits: number; mode: string | null }

// Per-column bit accounting for a message, for encoding experiments. Produces the identical string
// as v1MessageToString (via the same buildBody), plus the bit cost of the version prefix, packed
// header, weathercode, and every present variable column, with the adaptive mode each column chose.
export interface V1Breakdown {
  encoded: string;
  chars: number;
  versionBits: number;  // self-describing version prefix
  headerBits: number;   // packed header (code/periods/elev/wc_table)
  bodyBits: number;     // total meaningful body bits (sum of column bits)
  columns: ColumnBreakdown[];
}

export function v1EncodeBreakdown(msg: ForecastMessage): V1Breakdown {
  const nPeriods = msg.periods[0].length;
  const columns: ColumnBreakdown[] = [];
  const { body, wcTable } = buildBody(msg, (name, bits, mode) =>
    columns.push({ name, bits, mode: mode < 0 ? null : MODE_NAMES[mode] }));
  const encoded = encodeVersion(VERSION) + encode(buildHeader(msg, nPeriods, wcTable)) + encodeBodyLE(body);
  return {
    encoded,
    chars: encoded.length,
    versionBits: VERSION_PREFIX_CHARS * 7, // GSM-7 septet per prefix char
    headerBits: HEADER_BITS,
    bodyBits: body.length,
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
  const hr = reader(headerBits);

  const code = hr.int(CODE_BITS);
  const periodsRaw = hr.int(V1_PERIODS_BITS);
  const elevation = hr.int(ELEV_BITS) * ELEV_STEP_M;
  const wcTable = hr.int(WC_TABLE_BITS);

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

  // The body has no length field: it's self-delimiting given the known structure (nPeriods,
  // nModels, vars_mask). decodeBodyLE materializes the meaningful low bits; reads past them
  // return 0 (the implicit high-order padding) via takeInt's `?? 0`.
  const rd = reader(decodeBodyLE(rest.slice(HEADER_CHARS)));

  const periods: Period[][] = Array.from({ length: nModels }, () =>
    Array.from({ length: nPeriods }, () => ({ weathercode: 0 } as Period)));

  // Weathercode column (Huffman-coded under wcTable).
  eachCell(nPeriods, nModels, (p, m) => {
    periods[m][p].weathercode = WMO_CODES[rd.weathercode(wcTable)] ?? 0;
  });

  for (const col of SCALAR_COLUMNS) {
    if (vars_mask & (1 << col.bit)) decodeScalarColumn(rd, col, periods, nPeriods, nModels);
  }
  for (const col of WIND_COLUMNS) {
    if (!(vars_mask & (1 << col.bit))) continue;
    eachCell(nPeriods, nModels, (p, m) => {
      const spd = rd.int(4);
      const dir = rd.int(3);
      (periods[m][p][col.kph] as number) = spd * KPH_PER_STEP;
      (periods[m][p][col.dir] as number) = dir;
    });
  }

  // `days` is retained on the common message shape for display; it's the calendar-day span
  // implied by the period count (a partial final day rounds up).
  const days = Math.ceil(nPeriods / periodsPerDay);
  return { version, code, days, resolution, models_mask, vars_mask, month, day, hour, lat, lon, elevation, periods };
}

export const v1Codec: VersionedCodec = {
  encode: v1MessageToString,
  decode: v1MessageFromString,
};

