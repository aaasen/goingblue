import {
  RESOLUTION_HOURS, WMO_CODES, LAT_BITS, LON_BITS, ELEV_BITS,
} from "../constants.js";
import { putInt, takeInt, compandSqrt, expandSqrt } from "../bits.js";
import { encode, decode, nCharsForBits } from "../codec.js";
import { encodeVersion, takeVersion, VERSION_PREFIX_CHARS } from "../version.js";
import { WMO2IDX, type Period } from "../model.js";
import type { ForecastMessage, VersionedCodec } from "../model.js";
import { encodeWeathercode, decodeWeathercode, chooseWcTable } from "../huffman.js";

export const V1_VERSION = 1;
const VERSION = V1_VERSION;

// Locations are addressed by lat/lon only — there is no location field.
// The count is a period count (not days), so sub-daily resolutions can carry a partial
// final day. periods:8 stores (nPeriods - 1), i.e. 1..256 periods.
//
// The 7-bit version field lives in the shared, self-describing prefix (see version.ts),
// not in this packed header. Packed header layout (108 bits):
//   periods:8 resolution:3 models_mask:4 vars_mask:14 month:4 day:5 hour:5
//   lat:15 lon:16 elev:14 wc_table:3 body_bits:17
export const V1_PERIODS_BITS = 8;
export const V1_MAX_PERIODS = 1 << V1_PERIODS_BITS; // 256

// Huffman codebook selector for the weathercode column (see huffman.ts). Reserved here; the
// column is still raw WMO-index until the Huffman step lands.
const WC_TABLE_BITS = 3;
// Exact bit length of the (now variable-length) body. The body is self-delimiting once decoded,
// but the decoder needs the bit count to recover it from the base-85 chars without padding
// ambiguity. 17 bits covers the worst case (256 periods × 4 models ≈ 81k bits < 131071).
const BODY_LEN_BITS = 17;

export const V1_HEADER_BITS = 88 + WC_TABLE_BITS + BODY_LEN_BITS; // 108
// Total chars before the body: the shared version prefix plus this version's packed header.
export const V1_HEADER_CHARS = VERSION_PREFIX_CHARS + nCharsForBits(V1_HEADER_BITS); // 1 + 17 = 18
const HEADER_BITS = V1_HEADER_BITS;
const HEADER_CHARS = nCharsForBits(V1_HEADER_BITS); // packed-header chars (excludes version prefix)

// Per-column encoding modes (2-bit selector on adaptive columns). The encoder emits whichever is
// cheapest for the column.
const MODE_RAW = 0;
const MODE_FOR = 1;     // baseline + W-bit offsets
const MODE_SPARSE = 2;  // presence bit + magnitude only when nonzero
const MODE_EMPTY = 3;   // every cell is zero — no preamble, no data
const MODE_BITS = 2;
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
  { bit: 0, adaptive: false,
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

function encodeScalarColumn(
  body: number[], col: ScalarColumn, periods: Period[][], nPeriods: number, nModels: number,
): void {
  const width = VAR_BITS_V1[col.bit];
  const vals: number[] = [];
  eachCell(nPeriods, nModels, (p, m) => vals.push(col.get(periods[m][p])));

  if (!col.adaptive) {
    for (const v of vals) putInt(body, v, width);
    return;
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

export function v1MessageToString(msg: ForecastMessage): string {
  const nModels = msg.periods.length;
  const nPeriods = msg.periods[0].length;

  // Body is built first (column-major) so its exact bit length is known for the header.
  const body: number[] = [];

  // Weathercode column (always present, Huffman-coded). Gather the indices first so we can pick
  // the cheapest codebook, then emit them under it.
  const wcIdx: number[] = [];
  eachCell(nPeriods, nModels, (p, m) => wcIdx.push(WMO2IDX[msg.periods[m][p].weathercode] ?? 0));
  const wcTable = chooseWcTable(wcIdx);
  for (const idx of wcIdx) encodeWeathercode(body, wcTable, idx);

  for (const col of SCALAR_COLUMNS) {
    if (msg.vars_mask & (1 << col.bit)) encodeScalarColumn(body, col, msg.periods, nPeriods, nModels);
  }
  for (const col of WIND_COLUMNS) {
    if (!(msg.vars_mask & (1 << col.bit))) continue;
    eachCell(nPeriods, nModels, (p, m) => {
      const c = msg.periods[m][p];
      putInt(body, Math.min(Math.floor(((c[col.kph] as number) ?? 0) / KPH_PER_STEP), 15), 4);
      putInt(body, ((c[col.dir] as number) ?? 0) % 8, 3);
    });
  }

  const headerBits: number[] = [];
  putInt(headerBits, nPeriods - 1, V1_PERIODS_BITS);
  putInt(headerBits, msg.resolution, 3);
  putInt(headerBits, msg.models_mask, 4);
  putInt(headerBits, msg.vars_mask, 14);
  putInt(headerBits, msg.month, 4);
  putInt(headerBits, msg.day, 5);
  putInt(headerBits, msg.hour, 5);
  putInt(headerBits, Math.round((msg.lat + 90) * ((1 << LAT_BITS) - 1) / 180), LAT_BITS);
  putInt(headerBits, Math.round((msg.lon + 180) * ((1 << LON_BITS) - 1) / 360), LON_BITS);
  putInt(headerBits, Math.min(Math.max(Math.round(msg.elevation), 0), (1 << ELEV_BITS) - 1), ELEV_BITS);
  putInt(headerBits, wcTable, WC_TABLE_BITS);
  putInt(headerBits, body.length, BODY_LEN_BITS);

  return encodeVersion(VERSION) + encode(headerBits) + encode(body);
}

export function v1MessageFromString(s: string): ForecastMessage {
  const [version, rest] = takeVersion(s);
  if (version !== VERSION)
    throw new Error(`Version mismatch: encoded v${version}, expected v${VERSION}`);

  if (rest.length < HEADER_CHARS)
    throw new Error(`Unexpected message length: ${s.length} chars`);

  const headerBits = decode(rest.slice(0, HEADER_CHARS), HEADER_BITS);
  const hr = reader(headerBits);

  const periodsRaw = hr.int(V1_PERIODS_BITS);
  const resolution = hr.int(3);
  const models_mask = hr.int(4);
  const vars_mask = hr.int(14);
  const month = hr.int(4);
  const day = hr.int(5);
  const hour = hr.int(5);
  const lat_raw = hr.int(LAT_BITS);
  const lon_raw = hr.int(LON_BITS);
  const elevation = hr.int(ELEV_BITS);
  const wcTable = hr.int(WC_TABLE_BITS);
  const bodyBits = hr.int(BODY_LEN_BITS);

  const lat = lat_raw * 180 / ((1 << LAT_BITS) - 1) - 90;
  const lon = lon_raw * 360 / ((1 << LON_BITS) - 1) - 180;

  const resHours = RESOLUTION_HOURS[resolution] ?? 24;
  const periodsPerDay = resHours >= 24 ? 1 : 24 / resHours;
  const nPeriods = periodsRaw + 1;
  const nModels = popcount(models_mask);

  const expectedBodyChars = nCharsForBits(bodyBits);
  const actualBodyChars = rest.length - HEADER_CHARS;
  if (actualBodyChars !== expectedBodyChars)
    throw new Error(`Unexpected message length: ${s.length} chars`);

  const body = decode(rest.slice(HEADER_CHARS), bodyBits);
  const rd = reader(body);

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
  return { version, days, resolution, models_mask, vars_mask, month, day, hour, lat, lon, elevation, periods };
}

function popcount(n: number): number {
  let c = 0;
  while (n) { c += n & 1; n >>>= 1; }
  return c;
}

export const v1Codec: VersionedCodec = {
  encode: v1MessageToString,
  decode: v1MessageFromString,
};
