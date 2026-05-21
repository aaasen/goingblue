import { WMO_CODES } from "./constants.js";
import { putInt, takeInt } from "./bits.js";

const WMO2IDX: Record<number, number> = Object.fromEntries(
  WMO_CODES.map((c, i) => [c, i]),
);

export interface Period {
  weathercode: number;
  precip?: number;        // 0–100 %
  temp_f?: number;        // °F integer
  snow_in?: number;       // 0–15 in
  freeze_ft?: number;     // 0–15 000 ft (1 000 ft steps)
  wind_sfc_mph?: number;
  wind_sfc_dir?: number;
  wind_500_mph?: number;
  wind_500_dir?: number;
  wind_600_mph?: number;
  wind_600_dir?: number;
  wind_700_mph?: number;
  wind_700_dir?: number;
  cloud_total?: number;   // 0–100 %
  cloud_high?: number;    // 0–100 %
  cloud_mid?: number;     // 0–100 %
  cloud_low?: number;     // 0–100 %
  vis_km?: number;        // 0–15 km
}

function putWind(bits: number[], mph: number, dir: number): void {
  putInt(bits, Math.min(Math.floor(mph / 5), 15), 4);
  putInt(bits, dir % 8, 3);
}

function takeWind(bits: number[], pos: number): [number, number, number] {
  const [spd, p1] = takeInt(bits, pos, 4);
  const [dir, p2] = takeInt(bits, p1, 3);
  return [spd * 5, dir, p2];
}

export function periodToBits(p: Period, varsMask: number): number[] {
  const bits: number[] = [];
  putInt(bits, WMO2IDX[p.weathercode] ?? 0, 5);
  if (varsMask & (1 << 0)) putInt(bits, Math.min(Math.round((p.precip ?? 0) * 7 / 100), 7), 3);
  if (varsMask & (1 << 1)) putInt(bits, Math.min(Math.max(Math.round((p.temp_f ?? 0) + 100), 0), 255), 8);
  if (varsMask & (1 << 2)) putInt(bits, Math.min(p.snow_in ?? 0, 15), 4);
  if (varsMask & (1 << 3)) putInt(bits, Math.min(Math.floor((p.freeze_ft ?? 0) / 1000), 15), 4);
  if (varsMask & (1 << 4)) putWind(bits, p.wind_sfc_mph ?? 0, p.wind_sfc_dir ?? 0);
  if (varsMask & (1 << 5)) putWind(bits, p.wind_500_mph ?? 0, p.wind_500_dir ?? 0);
  if (varsMask & (1 << 6)) putWind(bits, p.wind_600_mph ?? 0, p.wind_600_dir ?? 0);
  if (varsMask & (1 << 7)) putWind(bits, p.wind_700_mph ?? 0, p.wind_700_dir ?? 0);
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
  if (varsMask & (1 << 1)) { let v: number; [v, pos] = takeInt(bits, pos, 8); p.temp_f = v - 100; }
  if (varsMask & (1 << 2)) { let v: number; [v, pos] = takeInt(bits, pos, 4); p.snow_in = v; }
  if (varsMask & (1 << 3)) { let v: number; [v, pos] = takeInt(bits, pos, 4); p.freeze_ft = v * 1000; }
  if (varsMask & (1 << 4)) { let mph: number, dir: number; [mph, dir, pos] = takeWind(bits, pos); p.wind_sfc_mph = mph; p.wind_sfc_dir = dir; }
  if (varsMask & (1 << 5)) { let mph: number, dir: number; [mph, dir, pos] = takeWind(bits, pos); p.wind_500_mph = mph; p.wind_500_dir = dir; }
  if (varsMask & (1 << 6)) { let mph: number, dir: number; [mph, dir, pos] = takeWind(bits, pos); p.wind_600_mph = mph; p.wind_600_dir = dir; }
  if (varsMask & (1 << 7)) { let mph: number, dir: number; [mph, dir, pos] = takeWind(bits, pos); p.wind_700_mph = mph; p.wind_700_dir = dir; }
  if (varsMask & (1 << 8))  { let v: number; [v, pos] = takeInt(bits, pos, 3); p.cloud_total = Math.round(v * 100 / 7); }
  if (varsMask & (1 << 9))  { let v: number; [v, pos] = takeInt(bits, pos, 3); p.cloud_high  = Math.round(v * 100 / 7); }
  if (varsMask & (1 << 10)) { let v: number; [v, pos] = takeInt(bits, pos, 3); p.cloud_mid   = Math.round(v * 100 / 7); }
  if (varsMask & (1 << 11)) { let v: number; [v, pos] = takeInt(bits, pos, 3); p.cloud_low = Math.round(v * 100 / 7); }
  if (varsMask & (1 << 12)) { let v: number; [v, pos] = takeInt(bits, pos, 4); p.vis_km = v; }

  return [p, pos];
}
