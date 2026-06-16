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

// Decoded forecast message. Each protocol version defines its own header format;
// `ForecastMessage` is the common shape shared by every version, and individual
// versions extend it with their own extra header fields (see `V1ForecastMessage`).
export interface ForecastMessage {
  version: number;
  days: number;
  resolution: number;
  models_mask: number;
  vars_mask: number;
  month: number;
  day: number;
  hour: number;
  lat: number;
  lon: number;
  elevation: number;
  periods: Period[][];
}

// v1 header additionally carries a legacy location index (0 = current/GPS, 1-5 = named).
// Dropped in v2, where locations are addressed by lat/lon only.
export interface V1ForecastMessage extends ForecastMessage {
  location: number;
}

// A codec for a single protocol version. The header format is version-specific, so the
// codec is parameterized by its message type (defaulting to the common `ForecastMessage`).
export interface VersionedCodec<M extends ForecastMessage = ForecastMessage> {
  encode(msg: M): string;
  decode(str: string): M;
}

export function startDatetime(msg: ForecastMessage): Date {
  const now = new Date();
  const d = new Date(now.getFullYear(), msg.month - 1, msg.day, msg.hour);
  if (now.getTime() - d.getTime() > 180 * 86400000) d.setFullYear(d.getFullYear() + 1);
  return d;
}
