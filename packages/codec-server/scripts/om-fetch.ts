/**
 * Open-Meteo fetch path for the corpus collector, via the official SDK (FlatBuffers transport).
 * The SDK identifies variables as (enum, altitude, pressureLevel) tuples rather than names;
 * `canonicalName` maps them back to the API's request names (`wind_speed_700hPa`), which are
 * the keys the corpus DB and the encode path share.
 */
import { fetchWeatherApi } from "openmeteo";
import { Variable } from "@openmeteo/sdk/variable.js";
import { Unit } from "@openmeteo/sdk/unit.js";
import type { VariableWithValues } from "@openmeteo/sdk/variable-with-values.js";
import type { WeatherApiResponse } from "@openmeteo/sdk/weather-api-response.js";
import { WINDOW_HOURS } from "./corpus-db.ts";

// With OPEN_METEO_API_KEY set, requests go to Open-Meteo's dedicated customer servers. The
// customer hosts are per-API `customer-` prefixes: this is the Historical Forecast API, so its
// dedicated host is customer-historical-forecast-api (the standard forecast API's equivalent,
// customer-api.open-meteo.com, is not used here — and the production path deliberately stays on
// the standard host, see src/forecast.ts).
const FREE_ENDPOINT = "https://historical-forecast-api.open-meteo.com/v1/forecast";
const CUSTOMER_ENDPOINT = "https://customer-historical-forecast-api.open-meteo.com/v1/forecast";
export const API_KEY = process.env.OPEN_METEO_API_KEY;
export const ENDPOINT = API_KEY ? CUSTOMER_ENDPOINT : FREE_ENDPOINT;

// A rate-limited API call. The SDK client throws 429s as bare `Error(reason)` ("…limit
// exceeded…"); fetchApi tags them with the status so the collector's workers can
// pause-and-retry on `status === 429` instead of matching message text.
export class ApiError extends Error {
  readonly status: number;
  constructor(message: string, status: number) {
    super(message);
    this.status = status;
  }
}

async function fetchApi(url: string, params: Record<string, unknown>): Promise<WeatherApiResponse> {
  let results: WeatherApiResponse[];
  try {
    results = await fetchWeatherApi(url, params);
  } catch (err) {
    const msg = (err as Error).message ?? String(err);
    throw /limit exceeded|too many/i.test(msg) ? new ApiError(msg, 429) : err;
  }
  if (!results[0]?.hourly()) throw new Error("response has no hourly block");
  return results[0];
}

export function canonicalName(v: VariableWithValues): string {
  const base = Variable[v.variable()];
  if (v.pressureLevel() !== 0) return `${base}_${v.pressureLevel()}hPa`;
  if (v.altitude() !== 0) return `${base}_${v.altitude()}m`;
  return base;
}

export interface FetchedWindow {
  resolvedLat: number;           // grid-snapped coordinates + model elevation (location_meta)
  resolvedLon: number;
  modelElevation: number;
  series: Map<string, { values: (number | null)[]; unit: string | null }>; // keyed by REQUESTED name
}

// Float32 values come back with representation noise (23.700000762939453); round to 2 dp — well
// beyond wire quantization — so stored JSON stays compact.
const round2 = (x: number) => Math.round(x * 100) / 100;

/**
 * Fetch one (model, location, window) cell's hourly variables. Every *requested* variable gets
 * an entry in the result: one the model lacks comes back all-null (recorded, so the planner
 * doesn't refetch it forever and the capability matrix sees 0% non-null).
 */
export async function fetchWindow(opts: {
  apiModel: string;
  lat: number;
  lon: number;
  elevM?: number;        // pin model elevation (curated peaks)
  windowStart: string;   // ISO minutes UTC, 00:00-anchored
  variables: string[];
}): Promise<FetchedWindow> {
  const startMs = Date.parse(opts.windowStart + ":00Z");
  const params: Record<string, unknown> = {
    latitude: opts.lat,
    longitude: opts.lon,
    start_date: new Date(startMs).toISOString().slice(0, 10),
    end_date: new Date(startMs + (WINDOW_HOURS - 1) * 3600_000).toISOString().slice(0, 10),
    hourly: opts.variables,
    models: opts.apiModel,
  };
  if (opts.elevM !== undefined) params.elevation = opts.elevM;
  if (API_KEY) params.apikey = API_KEY;

  const resp = await fetchApi(ENDPOINT, params);
  const hourly = resp.hourly()!; // fetchApi guarantees it
  if (Number(hourly.time()) !== startMs / 1000 || hourly.interval() !== 3600) {
    throw new Error(`${opts.apiModel}: response grid mismatch (start ${hourly.time()}, interval ${hourly.interval()})`);
  }

  // Decode by (name → entry) rather than trusting index order, so a variable the model lacks
  // (dropped or reordered by the API) can never silently misalign its neighbours.
  const decoded = new Map<string, VariableWithValues>();
  for (let i = 0; i < hourly.variablesLength(); i++) {
    const v = hourly.variables(i);
    if (v) decoded.set(canonicalName(v), v);
  }

  const series: FetchedWindow["series"] = new Map();
  for (const name of opts.variables) {
    const v = decoded.get(name);
    const raw = v?.valuesArray() ?? null;
    const values: (number | null)[] = Array.from({ length: WINDOW_HOURS }, (_, i) => {
      const x = raw?.[i];
      return x == null || Number.isNaN(x) ? null : round2(x);
    });
    series.set(name, { values, unit: v ? Unit[v.unit()] ?? null : null });
  }

  return {
    resolvedLat: resp.latitude(),
    resolvedLon: resp.longitude(),
    modelElevation: resp.elevation(),
    series,
  };
}
