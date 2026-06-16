import { WMO_CODES } from "./constants.js";

export const WMO2IDX: Record<number, number> = Object.fromEntries(
  WMO_CODES.map((c, i) => [c, i]),
);

export interface Period {
  // WMO Weather code.
  weathercode: number;

  // Probability of precipitation.
  precip?: number;

  // Maximum and minimum air temperature in Celsius.
  temp_c?: number;
  temp_min_c?: number;

  // Snow accumulation in centimeters.
  snow_cm?: number;

  // Freezing altitude in meters.
  freeze_m?: number;

  // Wind speeds in kilometers per hour and direction.
  // Surface level as well as 500, 600, 700 hPa pressure levels.
  wind_sfc_kph?: number;
  wind_sfc_dir?: number;
  wind_500_kph?: number;
  wind_500_dir?: number;
  wind_600_kph?: number;
  wind_600_dir?: number;
  wind_700_kph?: number;
  wind_700_dir?: number;

  // Cloud cover percentages.
  cloud_total?: number;
  cloud_high?: number;    // 8km+
  cloud_mid?: number;     // 3-8km
  cloud_low?: number;     // <3km

  // Visibility in kilometers.
  vis_km?: number;        // 0–15 km
}
