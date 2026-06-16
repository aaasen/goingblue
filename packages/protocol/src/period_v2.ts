import { WMO_CODES } from "./constants.js";
import { putInt, takeInt } from "./bits.js";
import { WMO2IDX, type Period } from "./period.js";

// Temp: 7 bits, 1°C steps, offset +40 → stored value = round(temp_c) + 40
// Range: -40°C (value 0) to +87°C (value 127)
const TEMP_OFFSET = 40;

function putWind(bits: number[], mph: number, dir: number): void {
  putInt(bits, Math.min(Math.floor(mph / 5), 15), 4);
  putInt(bits, dir % 8, 3);
}

function takeWind(bits: number[], pos: number): [number, number, number] {
  const [spd, p1] = takeInt(bits, pos, 4);
  const [dir, p2] = takeInt(bits, p1, 3);
  return [spd * 5, dir, p2];
}

export function periodToBitsV2(p: Period, varsMask: number): number[] {
  const bits: number[] = [];
  putInt(bits, WMO2IDX[p.weathercode] ?? 0, 5);
  if (varsMask & (1 << 0))  putInt(bits, Math.min(Math.round((p.precip ?? 0) * 7 / 100), 7), 3);
  if (varsMask & (1 << 1))  putInt(bits, Math.min(Math.max(Math.round((p.temp_c     ?? 0) + TEMP_OFFSET), 0), 127), 7);
  if (varsMask & (1 << 13)) putInt(bits, Math.min(Math.max(Math.round((p.temp_min_c ?? 0) + TEMP_OFFSET), 0), 127), 7);
  if (varsMask & (1 << 2))  putInt(bits, Math.min(p.snow_in ?? 0, 15), 4);
  if (varsMask & (1 << 3))  putInt(bits, Math.min(Math.floor((p.freeze_ft ?? 0) / 1000), 15), 4);
  if (varsMask & (1 << 4))  putWind(bits, p.wind_sfc_mph ?? 0, p.wind_sfc_dir ?? 0);
  if (varsMask & (1 << 5))  putWind(bits, p.wind_500_mph ?? 0, p.wind_500_dir ?? 0);
  if (varsMask & (1 << 6))  putWind(bits, p.wind_600_mph ?? 0, p.wind_600_dir ?? 0);
  if (varsMask & (1 << 7))  putWind(bits, p.wind_700_mph ?? 0, p.wind_700_dir ?? 0);
  if (varsMask & (1 << 8))  putInt(bits, Math.min(Math.round((p.cloud_total ?? 0) * 7 / 100), 7), 3);
  if (varsMask & (1 << 9))  putInt(bits, Math.min(Math.round((p.cloud_high  ?? 0) * 7 / 100), 7), 3);
  if (varsMask & (1 << 10)) putInt(bits, Math.min(Math.round((p.cloud_mid   ?? 0) * 7 / 100), 7), 3);
  if (varsMask & (1 << 11)) putInt(bits, Math.min(Math.round((p.cloud_low   ?? 0) * 7 / 100), 7), 3);
  if (varsMask & (1 << 12)) putInt(bits, Math.min(p.vis_km ?? 0, 15), 4);
  return bits;
}

export function periodFromBitsV2(bits: number[], pos: number, varsMask: number): [Period, number] {
  let wc: number;
  [wc, pos] = takeInt(bits, pos, 5);
  const p: Period = { weathercode: WMO_CODES[wc] ?? 0 };

  if (varsMask & (1 << 0))  { let v: number; [v, pos] = takeInt(bits, pos, 3); p.precip      = Math.round(v * 100 / 7); }
  if (varsMask & (1 << 1))  { let v: number; [v, pos] = takeInt(bits, pos, 7); p.temp_c      = v - TEMP_OFFSET; }
  if (varsMask & (1 << 13)) { let v: number; [v, pos] = takeInt(bits, pos, 7); p.temp_min_c  = v - TEMP_OFFSET; }
  if (varsMask & (1 << 2))  { let v: number; [v, pos] = takeInt(bits, pos, 4); p.snow_in     = v; }
  if (varsMask & (1 << 3))  { let v: number; [v, pos] = takeInt(bits, pos, 4); p.freeze_ft   = v * 1000; }
  if (varsMask & (1 << 4))  { let mph: number, dir: number; [mph, dir, pos] = takeWind(bits, pos); p.wind_sfc_mph = mph; p.wind_sfc_dir = dir; }
  if (varsMask & (1 << 5))  { let mph: number, dir: number; [mph, dir, pos] = takeWind(bits, pos); p.wind_500_mph = mph; p.wind_500_dir = dir; }
  if (varsMask & (1 << 6))  { let mph: number, dir: number; [mph, dir, pos] = takeWind(bits, pos); p.wind_600_mph = mph; p.wind_600_dir = dir; }
  if (varsMask & (1 << 7))  { let mph: number, dir: number; [mph, dir, pos] = takeWind(bits, pos); p.wind_700_mph = mph; p.wind_700_dir = dir; }
  if (varsMask & (1 << 8))  { let v: number; [v, pos] = takeInt(bits, pos, 3); p.cloud_total = Math.round(v * 100 / 7); }
  if (varsMask & (1 << 9))  { let v: number; [v, pos] = takeInt(bits, pos, 3); p.cloud_high  = Math.round(v * 100 / 7); }
  if (varsMask & (1 << 10)) { let v: number; [v, pos] = takeInt(bits, pos, 3); p.cloud_mid   = Math.round(v * 100 / 7); }
  if (varsMask & (1 << 11)) { let v: number; [v, pos] = takeInt(bits, pos, 3); p.cloud_low   = Math.round(v * 100 / 7); }
  if (varsMask & (1 << 12)) { let v: number; [v, pos] = takeInt(bits, pos, 4); p.vis_km      = v; }

  return [p, pos];
}
