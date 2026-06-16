import { WMO_CODES } from "./constants.js";
import { putInt, takeInt } from "./bits.js";

export const WMO2IDX: Record<number, number> = Object.fromEntries(
  WMO_CODES.map((c, i) => [c, i]),
);

export interface Period {
  weathercode: number;
  precip?: number;        // 0–100 %
  temp_c?: number;        // °C (max)
  temp_min_c?: number;    // °C (min)
  snow_cm?: number;       // cm
  freeze_m?: number;      // m
  wind_sfc_kph?: number;
  wind_sfc_dir?: number;
  wind_500_kph?: number;
  wind_500_dir?: number;
  wind_600_kph?: number;
  wind_600_dir?: number;
  wind_700_kph?: number;
  wind_700_dir?: number;
  cloud_total?: number;   // 0–100 %
  cloud_high?: number;    // 0–100 %
  cloud_mid?: number;     // 0–100 %
  cloud_low?: number;     // 0–100 %
  vis_km?: number;        // 0–15 km
}

// v1 wire: wind stored as 5 mph steps (0–75 mph); convert from/to km/h
const KPH_PER_STEP = 5 * 1.609344; // 5 mph in km/h

function putWind(bits: number[], kph: number, dir: number): void {
  putInt(bits, Math.min(Math.floor(kph / KPH_PER_STEP), 15), 4);
  putInt(bits, dir % 8, 3);
}

function takeWind(bits: number[], pos: number): [number, number, number] {
  const [spd, p1] = takeInt(bits, pos, 4);
  const [dir, p2] = takeInt(bits, p1, 3);
  return [spd * KPH_PER_STEP, dir, p2];
}

export function periodToBits(p: Period, varsMask: number): number[] {
  const bits: number[] = [];
  putInt(bits, WMO2IDX[p.weathercode] ?? 0, 5);
  if (varsMask & (1 << 0)) putInt(bits, Math.min(Math.round((p.precip ?? 0) * 7 / 100), 7), 3);
  if (varsMask & (1 <<  1)) putInt(bits, Math.min(Math.max(Math.round((p.temp_c     ?? 0) * 9/5 + 132), 0), 255), 8);
  if (varsMask & (1 << 13)) putInt(bits, Math.min(Math.max(Math.round((p.temp_min_c ?? 0) * 9/5 + 132), 0), 255), 8);
  if (varsMask & (1 << 2)) putInt(bits, Math.min(Math.round((p.snow_cm ?? 0) / 2.54), 15), 4);
  if (varsMask & (1 << 3)) putInt(bits, Math.min(Math.floor((p.freeze_m ?? 0) / 304.8), 15), 4);
  if (varsMask & (1 << 4)) putWind(bits, p.wind_sfc_kph ?? 0, p.wind_sfc_dir ?? 0);
  if (varsMask & (1 << 5)) putWind(bits, p.wind_500_kph ?? 0, p.wind_500_dir ?? 0);
  if (varsMask & (1 << 6)) putWind(bits, p.wind_600_kph ?? 0, p.wind_600_dir ?? 0);
  if (varsMask & (1 << 7)) putWind(bits, p.wind_700_kph ?? 0, p.wind_700_dir ?? 0);
  if (varsMask & (1 << 8))  putInt(bits, Math.min(Math.round((p.cloud_total ?? 0) * 7 / 100), 7), 3);
  if (varsMask & (1 << 9))  putInt(bits, Math.min(Math.round((p.cloud_high  ?? 0) * 7 / 100), 7), 3);
  if (varsMask & (1 << 10)) putInt(bits, Math.min(Math.round((p.cloud_mid   ?? 0) * 7 / 100), 7), 3);
  if (varsMask & (1 << 11)) putInt(bits, Math.min(Math.round((p.cloud_low   ?? 0) * 7 / 100), 7), 3);
  if (varsMask & (1 << 12)) putInt(bits, Math.min(p.vis_km ?? 0, 15), 4);
  return bits;
}

export function periodFromBits(bits: number[], pos: number, varsMask: number): [Period, number] {
  let wc: number;
  [wc, pos] = takeInt(bits, pos, 5);
  const p: Period = { weathercode: WMO_CODES[wc] ?? 0 };

  if (varsMask & (1 << 0)) { let v: number; [v, pos] = takeInt(bits, pos, 3); p.precip = Math.round(v * 100 / 7); }
  if (varsMask & (1 <<  1)) { let v: number; [v, pos] = takeInt(bits, pos, 8); p.temp_c     = (v - 132) * 5/9; }
  if (varsMask & (1 << 13)) { let v: number; [v, pos] = takeInt(bits, pos, 8); p.temp_min_c = (v - 132) * 5/9; }
  if (varsMask & (1 << 2)) { let v: number; [v, pos] = takeInt(bits, pos, 4); p.snow_cm   = v * 2.54; }
  if (varsMask & (1 << 3)) { let v: number; [v, pos] = takeInt(bits, pos, 4); p.freeze_m  = v * 304.8; }
  if (varsMask & (1 << 4)) { let kph: number, dir: number; [kph, dir, pos] = takeWind(bits, pos); p.wind_sfc_kph = kph; p.wind_sfc_dir = dir; }
  if (varsMask & (1 << 5)) { let kph: number, dir: number; [kph, dir, pos] = takeWind(bits, pos); p.wind_500_kph = kph; p.wind_500_dir = dir; }
  if (varsMask & (1 << 6)) { let kph: number, dir: number; [kph, dir, pos] = takeWind(bits, pos); p.wind_600_kph = kph; p.wind_600_dir = dir; }
  if (varsMask & (1 << 7)) { let kph: number, dir: number; [kph, dir, pos] = takeWind(bits, pos); p.wind_700_kph = kph; p.wind_700_dir = dir; }
  if (varsMask & (1 << 8))  { let v: number; [v, pos] = takeInt(bits, pos, 3); p.cloud_total = Math.round(v * 100 / 7); }
  if (varsMask & (1 << 9))  { let v: number; [v, pos] = takeInt(bits, pos, 3); p.cloud_high  = Math.round(v * 100 / 7); }
  if (varsMask & (1 << 10)) { let v: number; [v, pos] = takeInt(bits, pos, 3); p.cloud_mid   = Math.round(v * 100 / 7); }
  if (varsMask & (1 << 11)) { let v: number; [v, pos] = takeInt(bits, pos, 3); p.cloud_low = Math.round(v * 100 / 7); }
  if (varsMask & (1 << 12)) { let v: number; [v, pos] = takeInt(bits, pos, 4); p.vis_km = v; }

  return [p, pos];
}
