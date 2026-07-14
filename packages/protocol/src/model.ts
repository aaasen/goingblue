import { WMO_CODES } from "./constants.js";

export const WMO2IDX: Record<number, number> = Object.fromEntries(
  WMO_CODES.map((c, i) => [c, i]),
);

export interface Period {
  // WMO Weather code.
  weathercode: number;

  // Probability of precipitation.
  precip?: number;

  // Air temperature in Celsius: one representative sample of the hourly curve per period —
  // the daily-extreme value for the period containing the local day's min (or max), the
  // period's midpoint sample otherwise. Daily min/max are therefore recoverable client-side
  // as min/max over a local day's periods; which sample the encoder picks is server policy,
  // not wire format.
  temp_c?: number;

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
  // request (lat/lon/models/vars/duration) under this code; the encoded response omits those
  // fields and the decoder recovers them via a ContextResolver. See RequestContext.
  code: number;
  // Calendar days covered (< durationDays when the budget forced truncation).
  days: number;
  models_mask: number;
  vars_mask: number;
  // The FIRST PERIOD's start datetime (UTC) — at local midnight or earlier than the request
  // time, since the first period is the one containing it (see layout.ts).
  month: number;
  day: number;
  hour: number;
  lat: number;
  lon: number;
  elevation: number;
  periods: Period[][];
  // Fill-sequence number carried in the header; the period layout — count and per-period
  // resolution — is derived from it (see layout.ts).
  seq: number;
  // Requested forecast duration in days (from the request context).
  durationDays: number;
  // Span of each period in hours (periodHours.length === periods[m].length). Periods within
  // one message can span different resolutions.
  periodHours: number[];
  // The location's fixed UTC offset in whole hours (from the request context; the decoder
  // recovers it via ContextResolver). Never on the wire, but the encoder needs it too: the
  // temp-delta codebooks are keyed by each period's local time-of-day (see tempTodBucket).
  utcOffsetHours: number;
}

// The request fields the client recovers from its own storage by message code, rather than
// receiving them in the (slim) response. The encoder still needs them to lay out the body, so
// they remain on ForecastMessage; the wire just doesn't carry them.
export interface RequestContext {
  // A response carries exactly one model, identified by index (0..3 → MODEL_NAMES). The decoded
  // message exposes it as a single-bit models_mask for display.
  model: number;
  vars_mask: number;
  lat: number;
  lon: number;
  // Request time as UTC epoch milliseconds, aligned to the hour. The client chooses it (so
  // delivery delay can't shift it) and stores it; the slim header omits month/day/hour.
  start: number;
  // The requested duration in days and the location's fixed UTC offset in whole hours,
  // captured at request time (the `d:`/`z:` tokens). Both feed layoutFor(), which recovers
  // the period layout the slim header omits — see layout.ts.
  durationDays: number;
  utcOffsetHours: number;
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
