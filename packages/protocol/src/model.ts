import { WMO_CODES } from "./constants.js";
import type { Alphabet } from "./codec.js";

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
  // Peak surface (10m) wind gust in kilometers per hour. No direction.
  wind_gust_kph?: number;
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

  // Air quality indices, worst value over the period. Two scales that share no arithmetic: the
  // US EPA index runs 0–500 with 50/100/150/200/300 category edges, the European index runs
  // 0–100+ with edges every 20. A 40 is "good" on one and "moderate" on the other, so they must
  // never share a palette or a threshold. Each is present only when its own vars_mask bit is set
  // AND the period falls inside the CAMS horizon (AQ_HORIZON_HOURS in v2.ts) — periods past it
  // carry no air-quality data at all, so `undefined` here means "not forecast", not "clean".
  // Each headline is EXACTLY the max over its own scale's sub-indices — measured over 52M corpus
  // periods, it exceeds that max in 0.00% of them — which is what lets it code as a residual.
  // Which constituent the headline is reporting — an index into AQ_DOMINANT_US/_EU (entropy.ts),
  // present whenever its headline is. Carried rather than derived: the reader who asks for the
  // headline alone has no sub-index columns to take an argmax over, and even one who has them all
  // only has BANDED values, which tie ~8% of the time. The encoder picks by raw concentration.
  aqi_dominant?: number;
  aqi_eu_dominant?: number;
  aqi?: number;          // US AQI, headline (the max over its sub-indices)
  aqi_pm25?: number;     // US AQI PM2.5 sub-index — smoke
  aqi_o3?: number;       // US AQI ozone sub-index
  aqi_pm10?: number;     // US AQI PM10 sub-index — dust and coarse particulates
  aqi_no2?: number;      // US AQI nitrogen dioxide sub-index — traffic and combustion
  aqi_so2?: number;      // US AQI sulphur dioxide sub-index — industry and volcanic plumes
  aqi_eu?: number;       // European AQI, headline
  aqi_eu_pm25?: number;  // European AQI PM2.5 sub-index
  aqi_eu_pm10?: number;  // European AQI PM10 sub-index
  aqi_eu_o3?: number;    // European AQI ozone sub-index — this scale's leading pollutant
  aqi_eu_no2?: number;   // European AQI nitrogen dioxide sub-index
  aqi_eu_so2?: number;   // European AQI sulphur dioxide sub-index
}

// Decoded forecast message. Each protocol version defines its own header format;
// `ForecastMessage` is the common shape shared by every version. A version that needs
// extra header fields extends this interface and parameterizes its codec with the
// extended type (see `VersionedCodec`).
export interface ForecastMessage {
  version: number;
  // Message code (0..127): a client-assigned key that the response echoes. The client stores the
  // request (lat/lon/models/vars/mode) under this code; the encoded response omits those
  // fields and the decoder recovers them via a ContextResolver. See RequestContext.
  code: number;
  // Calendar days covered (< FILL_SLOTS early in the fill path, before the mode's extend-moves
  // have run).
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
  // Requested priority mode (MODE_DETAIL/MODE_AUTO/MODE_RANGE, from the request context) — what
  // the reader asked for, which is what display should call it. Not necessarily the mode the
  // layout was built along: against a center that can't fill the window, Range is served as Auto
  // (see effectiveMode). Read periodHours for the shape; this field is for labelling.
  mode: number;
  // Span of each period in hours (periodHours.length === periods[m].length). Periods within
  // one message can span different resolutions.
  periodHours: number[];
  // The location's fixed UTC offset in whole hours (from the request context; the decoder
  // recovers it via ContextResolver). Never on the wire, but the encoder needs it too: the
  // temp-delta codebooks are keyed by each period's local time-of-day (see tempTodBucket).
  utcOffsetHours: number;
  // Codebook class the body decoded under (set by decode; informational). The encoder always
  // re-derives the cheapest class itself — deterministically, so re-encoding a decoded message
  // reproduces the same string — and ignores this field.
  codebookClass?: number;
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
  // The requested priority mode and the location's fixed UTC offset in whole hours,
  // captured at request time (the `p:`/`z:` tokens). Both feed layoutFor(), which recovers
  // the period layout the slim header omits — see layout.ts.
  mode: number;
  utcOffsetHours: number;
}

// Resolves a message code to the originating request's context. Returns undefined when the code
// is unknown (e.g. cycled out of the client's store), in which case decode throws.
export type ContextResolver = (code: number) => RequestContext | undefined;

// A codec for a single protocol version. The header format is version-specific, so the
// codec is parameterized by its message type (defaulting to the common `ForecastMessage`).
// `decode` takes a ContextResolver because the slim response omits the request-echo fields.
// `alphabet` selects the body's character set (default base-85); decode needs no such argument
// because a body says which alphabet it is in — see bodyAlphabet.
export interface VersionedCodec<M extends ForecastMessage = ForecastMessage> {
  encode(msg: M, alphabet?: Alphabet): string;
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
