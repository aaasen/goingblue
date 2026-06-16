import { WMO_CODES } from "./constants.js";

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
