import {
  RESOLUTION_HOURS, WMO_CODES, LAT_BITS, LON_BITS, ELEV_BITS,
} from "../constants.js";
import { putInt, takeInt } from "../bits.js";
import { encode, decode, periodBitsForMask, nCharsForBits } from "../codec.js";
import { encodeVersion, takeVersion, VERSION_PREFIX_CHARS } from "../version.js";
import { WMO2IDX, type Period } from "../model.js";
import type { ForecastMessage, VersionedCodec } from "../model.js";

export const V1_VERSION = 1;
const VERSION = V1_VERSION;

// Locations are addressed by lat/lon only — there is no location field.
// The count is a period count (not days), so sub-daily resolutions can carry a partial
// final day. periods:8 stores (nPeriods - 1), i.e. 1..256 periods.
//
// The 7-bit version field lives in the shared, self-describing prefix (see version.ts),
// not in this packed header. Packed header layout (88 bits):
//   periods:8 resolution:3 models_mask:4 vars_mask:14 month:4 day:5 hour:5 lat:15 lon:16 elev:14
export const V1_HEADER_BITS = 88;
export const V1_PERIODS_BITS = 8;
export const V1_MAX_PERIODS = 1 << V1_PERIODS_BITS; // 256
// Total chars before the body: the shared version prefix plus this version's packed header.
export const V1_HEADER_CHARS = VERSION_PREFIX_CHARS + nCharsForBits(V1_HEADER_BITS); // 1 + 14 = 15
const HEADER_BITS = V1_HEADER_BITS;
const HEADER_CHARS = nCharsForBits(V1_HEADER_BITS); // packed-header chars (excludes version prefix)

// temp/tmin: 7 bits, 1°C steps, offset -40°C → -40°C to +87°C
export const VAR_BITS_V1 = [3, 7, 4, 4, 7, 7, 7, 7, 3, 3, 3, 3, 0, 7];
//                          ^p ^t ^s ^f ^w ^5 ^6 ^7 ^cc ^cch ^ccm ^ccl  -  ^tmin

const TEMP_OFFSET = 40;
const KPH_PER_STEP = 5 * 1.609344;

function putWind(bits: number[], kph: number, dir: number): void {
  putInt(bits, Math.min(Math.floor(kph / KPH_PER_STEP), 15), 4);
  putInt(bits, dir % 8, 3);
}

function takeWind(bits: number[], pos: number): [number, number, number] {
  const [spd, p1] = takeInt(bits, pos, 4);
  const [dir, p2] = takeInt(bits, p1, 3);
  return [spd * KPH_PER_STEP, dir, p2];
}

function periodToBits(p: Period, varsMask: number): number[] {
  const bits: number[] = [];
  putInt(bits, WMO2IDX[p.weathercode] ?? 0, 5);
  if (varsMask & (1 << 0))  putInt(bits, Math.min(Math.round((p.precip ?? 0) * 7 / 100), 7), 3);
  if (varsMask & (1 << 1))  putInt(bits, Math.min(Math.max(Math.round((p.temp_c     ?? 0) + TEMP_OFFSET), 0), 127), 7);
  if (varsMask & (1 << 13)) putInt(bits, Math.min(Math.max(Math.round((p.temp_min_c ?? 0) + TEMP_OFFSET), 0), 127), 7);
  if (varsMask & (1 << 2))  putInt(bits, Math.min(Math.round((p.snow_cm ?? 0) / 2.54), 15), 4);
  if (varsMask & (1 << 3))  putInt(bits, Math.min(Math.floor((p.freeze_m ?? 0) / 304.8), 15), 4);
  if (varsMask & (1 << 4))  putWind(bits, p.wind_sfc_kph ?? 0, p.wind_sfc_dir ?? 0);
  if (varsMask & (1 << 5))  putWind(bits, p.wind_500_kph ?? 0, p.wind_500_dir ?? 0);
  if (varsMask & (1 << 6))  putWind(bits, p.wind_600_kph ?? 0, p.wind_600_dir ?? 0);
  if (varsMask & (1 << 7))  putWind(bits, p.wind_700_kph ?? 0, p.wind_700_dir ?? 0);
  if (varsMask & (1 << 8))  putInt(bits, Math.min(Math.round((p.cloud_total ?? 0) * 7 / 100), 7), 3);
  if (varsMask & (1 << 9))  putInt(bits, Math.min(Math.round((p.cloud_high  ?? 0) * 7 / 100), 7), 3);
  if (varsMask & (1 << 10)) putInt(bits, Math.min(Math.round((p.cloud_mid   ?? 0) * 7 / 100), 7), 3);
  if (varsMask & (1 << 11)) putInt(bits, Math.min(Math.round((p.cloud_low   ?? 0) * 7 / 100), 7), 3);
  return bits;
}

function periodFromBits(bits: number[], pos: number, varsMask: number): [Period, number] {
  let wc: number;
  [wc, pos] = takeInt(bits, pos, 5);
  const p: Period = { weathercode: WMO_CODES[wc] ?? 0 };

  if (varsMask & (1 << 0))  { let v: number; [v, pos] = takeInt(bits, pos, 3); p.precip      = Math.round(v * 100 / 7); }
  if (varsMask & (1 << 1))  { let v: number; [v, pos] = takeInt(bits, pos, 7); p.temp_c      = v - TEMP_OFFSET; }
  if (varsMask & (1 << 13)) { let v: number; [v, pos] = takeInt(bits, pos, 7); p.temp_min_c  = v - TEMP_OFFSET; }
  if (varsMask & (1 << 2))  { let v: number; [v, pos] = takeInt(bits, pos, 4); p.snow_cm     = v * 2.54; }
  if (varsMask & (1 << 3))  { let v: number; [v, pos] = takeInt(bits, pos, 4); p.freeze_m    = v * 304.8; }
  if (varsMask & (1 << 4))  { let kph: number, dir: number; [kph, dir, pos] = takeWind(bits, pos); p.wind_sfc_kph = kph; p.wind_sfc_dir = dir; }
  if (varsMask & (1 << 5))  { let kph: number, dir: number; [kph, dir, pos] = takeWind(bits, pos); p.wind_500_kph = kph; p.wind_500_dir = dir; }
  if (varsMask & (1 << 6))  { let kph: number, dir: number; [kph, dir, pos] = takeWind(bits, pos); p.wind_600_kph = kph; p.wind_600_dir = dir; }
  if (varsMask & (1 << 7))  { let kph: number, dir: number; [kph, dir, pos] = takeWind(bits, pos); p.wind_700_kph = kph; p.wind_700_dir = dir; }
  if (varsMask & (1 << 8))  { let v: number; [v, pos] = takeInt(bits, pos, 3); p.cloud_total = Math.round(v * 100 / 7); }
  if (varsMask & (1 << 9))  { let v: number; [v, pos] = takeInt(bits, pos, 3); p.cloud_high  = Math.round(v * 100 / 7); }
  if (varsMask & (1 << 10)) { let v: number; [v, pos] = takeInt(bits, pos, 3); p.cloud_mid   = Math.round(v * 100 / 7); }
  if (varsMask & (1 << 11)) { let v: number; [v, pos] = takeInt(bits, pos, 3); p.cloud_low   = Math.round(v * 100 / 7); }

  return [p, pos];
}

export function v1MessageToString(msg: ForecastMessage): string {
  const headerBits: number[] = [];
  const nPeriods = msg.periods[0].length;
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

  const bodyBits: number[] = [];
  for (let i = 0; i < nPeriods; i++) {
    for (const modelPeriods of msg.periods) {
      bodyBits.push(...periodToBits(modelPeriods[i], msg.vars_mask));
    }
  }

  return encodeVersion(VERSION) + encode(headerBits) + encode(bodyBits);
}

export function v1MessageFromString(s: string): ForecastMessage {
  const [version, rest] = takeVersion(s);
  if (version !== VERSION)
    throw new Error(`Version mismatch: encoded v${version}, expected v${VERSION}`);

  if (rest.length < HEADER_CHARS)
    throw new Error(`Unexpected message length: ${s.length} chars`);

  const headerBits = decode(rest.slice(0, HEADER_CHARS), HEADER_BITS);
  let pos = 0;

  let periodsRaw: number, resolution: number,
      models_mask: number, vars_mask: number, month: number, day: number, hour: number;
  [periodsRaw,  pos] = takeInt(headerBits, pos, V1_PERIODS_BITS);
  [resolution,  pos] = takeInt(headerBits, pos, 3);
  [models_mask, pos] = takeInt(headerBits, pos, 4);
  [vars_mask,   pos] = takeInt(headerBits, pos, 14);
  [month,       pos] = takeInt(headerBits, pos, 4);
  [day,         pos] = takeInt(headerBits, pos, 5);
  [hour,        pos] = takeInt(headerBits, pos, 5);
  let lat_raw: number, lon_raw: number, elevation: number;
  [lat_raw,   pos] = takeInt(headerBits, pos, LAT_BITS);
  [lon_raw,   pos] = takeInt(headerBits, pos, LON_BITS);
  [elevation, pos] = takeInt(headerBits, pos, ELEV_BITS);
  const lat = lat_raw * 180 / ((1 << LAT_BITS) - 1) - 90;
  const lon = lon_raw * 360 / ((1 << LON_BITS) - 1) - 180;

  const resHours = RESOLUTION_HOURS[resolution] ?? 24;
  const periodsPerDay = resHours >= 24 ? 1 : 24 / resHours;
  const nPeriods = periodsRaw + 1;
  const nModels = popcount(models_mask);
  const periodBits = periodBitsForMask(vars_mask, VAR_BITS_V1);
  const totalBodyBits = nPeriods * nModels * periodBits;

  const expectedBodyChars = nCharsForBits(totalBodyBits);
  const actualBodyChars = rest.length - HEADER_CHARS;
  if (actualBodyChars !== expectedBodyChars)
    throw new Error(`Unexpected message length: ${s.length} chars`);

  const bodyBits = decode(rest.slice(HEADER_CHARS), totalBodyBits);
  pos = 0;

  const allPeriods: Period[][] = Array.from({ length: nModels }, () => []);
  for (let i = 0; i < nPeriods; i++) {
    for (let m = 0; m < nModels; m++) {
      const [p, nextPos] = periodFromBits(bodyBits, pos, vars_mask);
      pos = nextPos;
      allPeriods[m].push(p);
    }
  }

  // `days` is retained on the common message shape for display; it's the calendar-day span
  // implied by the period count (a partial final day rounds up).
  const days = Math.ceil(nPeriods / periodsPerDay);
  return { version, days, resolution, models_mask, vars_mask, month, day, hour, lat, lon, elevation, periods: allPeriods };
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
