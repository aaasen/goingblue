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

  // Liquid precipitation (rain + showers) accumulation in millimeters.
  rain_mm?: number;

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
// `ForecastMessage` is the common shape shared by every version. A version that needs
// extra header fields extends this interface and parameterizes its codec with the
// extended type (see `VersionedCodec`).
export interface ForecastMessage {
  version: number;
  // Message code (0..127): a client-assigned key that the response echoes. The client stores the
  // request (lat/lon/models/vars/resolution) under this code; the encoded response omits those
  // fields and the decoder recovers them via a ContextResolver. See RequestContext.
  code: number;
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

// The request fields the client recovers from its own storage by message code, rather than
// receiving them in the (slim) response. The encoder still needs them to lay out the body, so
// they remain on ForecastMessage; the wire just doesn't carry them.
export interface RequestContext {
  resolution: number;
  // A response carries exactly one model, identified by index (0..3 → MODEL_NAMES). The decoded
  // message exposes it as a single-bit models_mask for display.
  model: number;
  vars_mask: number;
  lat: number;
  lon: number;
  // Forecast start as UTC epoch milliseconds, aligned to the resolution. The client chooses it
  // (so delivery delay can't shift it) and stores it; the slim header omits month/day/hour.
  start: number;
}

// Resolves a message code to the originating request's context. Returns undefined when the code
// is unknown (e.g. cycled out of the client's store), in which case decode throws.
export type ContextResolver = (code: number) => RequestContext | undefined;

// A codec for a single protocol version. The header format is version-specific, so the
// codec is parameterized by its message type (defaulting to the common `ForecastMessage`).
// `decode` takes a ContextResolver because the slim response omits the request-echo fields.
export interface VersionedCodec<M extends ForecastMessage = ForecastMessage> {
  encode(msg: M): string;
  decode(str: string, resolve: ContextResolver): M;
}

// The forecast start as an absolute instant. month/day/hour are stored in UTC (the year is omitted
// from the wire and inferred: a date more than ~180 days in the past is taken to be next year).
export function startDatetime(msg: ForecastMessage): Date {
  const now = new Date();
  let d = new Date(Date.UTC(now.getUTCFullYear(), msg.month - 1, msg.day, msg.hour));
  if (now.getTime() - d.getTime() > 180 * 86400000)
    d = new Date(Date.UTC(now.getUTCFullYear() + 1, msg.month - 1, msg.day, msg.hour));
  return d;
}
