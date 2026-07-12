import {
  MODEL_BIT,
  DEFAULT_VARS_MASK,
  VARS_BIT,
  CURRENT_VERSION,
  isValidToken,
  normalizeToken,
  layoutFor,
  maxFillSeq,
  type Period,
  type ForecastMessage,
  type VersionedCodec,
} from "@weather/protocol";

const OPENMETEO_MODELS: Record<string, string> = {
  HRES: "ecmwf_ifs",
  GFS: "gfs_seamless",
  ICON: "icon_seamless",
  IFS: "ecmwf_ifs025",
};

// ecmwf_ifs (HRES) does not provide freezing_level_height or pressure-level wind/temp
const MODEL_NO_PRESSURE = new Set(["HRES"]);

interface NamedLocation { lat: number; lon: number; tz: string; elev_m: number }

// Indexed by locationIdx (0 = current/GPS, 1-5 = named)
const NAMED_LOCATIONS: (NamedLocation | null)[] = [
  null,                                                                  // 0: current (GPS)
  { lat: 63.067, lon: -151.172, tz: "America/Anchorage", elev_m: 3353 }, // 1: 11k  (11,000ft)
  { lat: 63.063, lon: -151.081, tz: "America/Anchorage", elev_m: 4267 }, // 2: 14k  (14,000ft)
  { lat: 63.069, lon: -151.047, tz: "America/Anchorage", elev_m: 5182 }, // 3: 17k  (17,000ft)
  { lat: 63.069, lon: -151.003, tz: "America/Anchorage", elev_m: 6096 }, // 4: summit (20,000ft)
  { lat: 62.965, lon: -151.177, tz: "America/Anchorage", elev_m: 2134 }, // 5: airstrip (7,000ft)
];

const LOCATION_NAME_TO_IDX: Record<string, number> = {
  "11k": 1, "14k": 2, "17k": 3, "summit": 4, "airstrip": 5,
};

export const HOURS_PER_PERIOD: Record<number, number> = {
  0: 24,
  1: 12,
  2: 6,
  3: 3,
  4: 1,
};

const MODEL_NAME_TO_BIT: Record<string, number> = {
  hres: MODEL_BIT["HRES"],
  ecmwf: MODEL_BIT["HRES"],
  gfs: MODEL_BIT["GFS"],
  icon: MODEL_BIT["ICON"],
  ifs: MODEL_BIT["IFS"],
  euro: MODEL_BIT["IFS"],
};

const SURFACE_VARS = [
  "temperature_2m",
  "wind_speed_10m",
  "wind_direction_10m",
  "precipitation_probability",
  "weather_code",
  "freezing_level_height",
  "snowfall",
  "rain",
  "showers",
  "cloud_cover",
  "cloud_cover_high",
  "cloud_cover_mid",
  "cloud_cover_low",
];
const PRESSURE_LEVELS = [500, 600, 700];
const PRESSURE_VAR_NAMES = ["temperature", "wind_speed", "wind_direction"];

function degToDirIdx(deg: number | null | undefined): number {
  if (deg == null) return 0;
  return Math.round(deg / 45) % 8;
}

export function maxOf(vals: (number | null)[]): number | null {
  let m: number | null = null;
  for (const v of vals) if (v != null && (m === null || v > m)) m = v;
  return m;
}

export function minOf(vals: (number | null)[]): number | null {
  let m: number | null = null;
  for (const v of vals) if (v != null && (m === null || v < m)) m = v;
  return m;
}

export function sumOf(vals: (number | null)[]): number {
  let s = 0;
  for (const v of vals) s += v ?? 0;
  return s;
}

export function dominantDirDeg(
  speeds: (number | null)[],
  directions: (number | null)[],
): number | null {
  let x = 0, y = 0;
  for (let i = 0; i < speeds.length; i++) {
    const spd = speeds[i] ?? 0;
    const rad = ((directions[i] ?? 0) * Math.PI) / 180;
    x += Math.cos(rad) * spd;
    y += Math.sin(rad) * spd;
  }
  if (x === 0 && y === 0) return null;
  let deg = (Math.atan2(y, x) * 180) / Math.PI;
  if (deg < 0) deg += 360;
  return deg;
}

export interface HourlyData {
  time: string[];
  temperature_2m: (number | null)[];
  wind_speed_10m: (number | null)[];
  wind_direction_10m: (number | null)[];
  precipitation_probability: (number | null)[];
  weather_code: (number | null)[];
  freezing_level_height: (number | null)[];
  snowfall: (number | null)[];
  rain: (number | null)[];
  showers: (number | null)[];
  cloud_cover: (number | null)[];
  cloud_cover_high: (number | null)[];
  cloud_cover_mid: (number | null)[];
  cloud_cover_low: (number | null)[];
  [key: string]: unknown[];
}

export interface Row {
  time: string;
  temp_max_c: number | null;
  temp_min_c: number | null;
  wind_speed_10m: number | null;
  wind_direction_10m: number | null;
  precip: number | null;
  weathercode: number | null;
  freezing_level_m: number | null;
  snow_cm: number;
  rain_mm: number;
  wind_speed_500hPa: number | null;
  wind_direction_500hPa: number | null;
  wind_speed_600hPa: number | null;
  wind_direction_600hPa: number | null;
  wind_speed_700hPa: number | null;
  wind_direction_700hPa: number | null;
  cloud_cover: number | null;
  cloud_cover_high: number | null;
  cloud_cover_mid: number | null;
  cloud_cover_low: number | null;
}

async function fetchHourly(
  modelKey: string,
  nDays: number,
  lat: number,
  lon: number,
  tz: string,
  elev_m?: number,
  pastDays = 0,
): Promise<[HourlyData, string[], number]> {
  const hasPressure = !MODEL_NO_PRESSURE.has(modelKey);
  const pressureVars = hasPressure
    ? PRESSURE_VAR_NAMES.flatMap((v) => PRESSURE_LEVELS.map((l) => `${v}_${l}hPa`))
    : [];
  const surfaceVars = hasPressure
    ? SURFACE_VARS
    : SURFACE_VARS.filter((v) => v !== "freezing_level_height");
  const params = new URLSearchParams({
    latitude: String(lat),
    longitude: String(lon),
    hourly: [...surfaceVars, ...pressureVars].join(","),

    timezone: tz,
    forecast_days: String(nDays),
    models: OPENMETEO_MODELS[modelKey],
  });
  if (elev_m !== undefined) params.set("elevation", String(elev_m));
  if (pastDays > 0) params.set("past_days", String(pastDays));
  const url = `https://api.open-meteo.com/v1/forecast?${params}`;
  console.log("Open-Meteo request:", url);
  const resp = await fetch(url);
  if (!resp.ok) throw new Error(`Open-Meteo ${resp.status}: ${await resp.text()}`);
  const data = (await resp.json()) as { hourly: HourlyData; elevation: number };
  return [data.hourly, data.hourly.time, data.elevation ?? 0];
}


export async function aggregateRows(
  modelKey: string,
  nPeriods: number,
  resolutionIdx: number,
  lat: number,
  lon: number,
  startEpochHour: number,
  elev_m?: number,
): Promise<[Row[], number]> {
  const hoursPerPeriod = HOURS_PER_PERIOD[resolutionIdx];
  const periodsPerDay = 24 / hoursPerPeriod;
  // Fetch one extra day so the final (possibly partial) period window is fully covered.
  const nDaysToFetch = Math.ceil(nPeriods / periodsPerDay) + 1;
  // All times are UTC; the forecast is anchored to the client-requested start (aligned to the
  // period boundary), not to "now", so delivery delay can't shift which periods come back.
  const [h, times, elevation] = await fetchHourly(modelKey, nDaysToFetch, lat, lon, "UTC", elev_m);
  return [aggregateHourly(h, times, nPeriods, resolutionIdx, startEpochHour), elevation];
}

// Window + aggregate already-fetched hourly data into period Rows. Pure (no I/O), so the same
// aggregation serves both the live fetch path (aggregateRows) and offline corpus analysis over
// cached single-run responses.
export function aggregateHourly(
  h: HourlyData,
  times: string[],
  nPeriods: number,
  resolutionIdx: number,
  startEpochHour: number,
): Row[] {
  const hoursPerPeriod = HOURS_PER_PERIOD[resolutionIdx];
  const nTotal = nPeriods;

  const anchorKey = new Date(startEpochHour * 3600000).toISOString().slice(0, 13); // "YYYY-MM-DDTHH"

  const windows: number[][] = [];
  const windowMap = new Map<string, number[]>();

  for (let i = 0; i < times.length; i++) {
    const date = times[i].slice(0, 10);
    const hour = parseInt(times[i].slice(11, 13));
    const startHour = Math.floor(hour / hoursPerPeriod) * hoursPerPeriod;
    const key = `${date}T${String(startHour).padStart(2, "0")}`;
    if (key < anchorKey) continue;
    if (!windowMap.has(key)) {
      if (windows.length >= nTotal) break;
      const w: number[] = [];
      windowMap.set(key, w);
      windows.push(w);
    }
    windowMap.get(key)!.push(i);
  }

  return rowsFromWindows(h, times, windows);
}

// Aggregate hourly samples into one Row per window (a window is the hourly indices it covers).
// Shared by the uniform-resolution keying above and the layout-driven windows (v2) below.
function rowsFromWindows(h: HourlyData, times: string[], windows: number[][]): Row[] {
  const rows = windows.map((idx) => {
    // Null-safe: a series may be entirely absent when aggregating injected data (e.g. an offline
    // corpus that omits precipitation_probability); production always supplies these arrays.
    const pick = (arr: (number | null)[] | undefined): (number | null)[] =>
      idx.map((i) => arr?.[i] ?? null);
    const pickUnk = (key: string): (number | null)[] =>
      idx.map((i) => ((h[key] as (number | null)[] | undefined)?.[i] ?? null));

    const sfcSpd = pick(h.wind_speed_10m);
    const sfcDir = pick(h.wind_direction_10m);
    const spd500 = pickUnk("wind_speed_500hPa");
    const dir500 = pickUnk("wind_direction_500hPa");
    const spd600 = pickUnk("wind_speed_600hPa");
    const dir600 = pickUnk("wind_direction_600hPa");
    const spd700 = pickUnk("wind_speed_700hPa");
    const dir700 = pickUnk("wind_direction_700hPa");

    return {
      time: times[idx[0]],
      temp_max_c: maxOf(pick(h.temperature_2m)),
      temp_min_c: minOf(pick(h.temperature_2m)),
      wind_speed_10m: maxOf(sfcSpd),
      wind_direction_10m: dominantDirDeg(sfcSpd, sfcDir),
      precip: maxOf(pick(h.precipitation_probability)),
      weathercode: maxOf(pick(h.weather_code)),
      freezing_level_m: maxOf(pickUnk("freezing_level_height")),
      snow_cm: sumOf(pick(h.snowfall)),
      // Liquid precipitation: open-meteo splits convective showers from stratiform rain.
      // Some models omit one series (returns null), so sum both treating null as 0.
      rain_mm: sumOf(pickUnk("rain")) + sumOf(pickUnk("showers")),
      wind_speed_500hPa: maxOf(spd500),
      wind_direction_500hPa: dominantDirDeg(spd500, dir500),
      wind_speed_600hPa: maxOf(spd600),
      wind_direction_600hPa: dominantDirDeg(spd600, dir600),
      wind_speed_700hPa: maxOf(spd700),
      wind_direction_700hPa: dominantDirDeg(spd700, dir700),
      cloud_cover: maxOf(pick(h.cloud_cover)),
      cloud_cover_high: maxOf(pick(h.cloud_cover_high)),
      cloud_cover_mid: maxOf(pick(h.cloud_cover_mid)),
      cloud_cover_low: maxOf(pick(h.cloud_cover_low)),
    };
  });
  return rows;
}

const PRESSURE_VAR_BITS =
  (1 << VARS_BIT.freeze) | (1 << VARS_BIT.w500) | (1 << VARS_BIT.w600) | (1 << VARS_BIT.w700);

// tmin is kept even for 1h periods (where it equals temp — the delta columns encode the
// duplication away) so a mixed-resolution message has uniform columns.
export function toFullPeriod(r: Row, varsMask: number, modelKey: string): Period {
  if (MODEL_NO_PRESSURE.has(modelKey)) varsMask &= ~PRESSURE_VAR_BITS;
  const p: Period = { weathercode: r.weathercode ?? 0 };
  if (varsMask & (1 << VARS_BIT.precip)) p.precip     = r.precip ?? 0;
  if (varsMask & (1 << VARS_BIT.temp))   p.temp_c     = r.temp_max_c ?? 0;
  if (varsMask & (1 << VARS_BIT.tmin))   p.temp_min_c = r.temp_min_c ?? 0;
  if (varsMask & (1 << VARS_BIT.snow))   p.snow_cm    = r.snow_cm ?? 0;
  if (varsMask & (1 << VARS_BIT.rain))   p.rain_mm    = r.rain_mm ?? 0;
  if (varsMask & (1 << VARS_BIT.freeze)) p.freeze_m   = r.freezing_level_m ?? 0;
  if (varsMask & (1 << VARS_BIT.wind)) {
    p.wind_sfc_kph = r.wind_speed_10m ?? 0;
    p.wind_sfc_dir = degToDirIdx(r.wind_direction_10m);
  }
  if (varsMask & (1 << VARS_BIT.w500)) {
    p.wind_500_kph = r.wind_speed_500hPa ?? 0;
    p.wind_500_dir = degToDirIdx(r.wind_direction_500hPa);
  }
  if (varsMask & (1 << VARS_BIT.w600)) {
    p.wind_600_kph = r.wind_speed_600hPa ?? 0;
    p.wind_600_dir = degToDirIdx(r.wind_direction_600hPa);
  }
  if (varsMask & (1 << VARS_BIT.w700)) {
    p.wind_700_kph = r.wind_speed_700hPa ?? 0;
    p.wind_700_dir = degToDirIdx(r.wind_direction_700hPa);
  }
  if (varsMask & (1 << VARS_BIT.cc))  p.cloud_total = Math.round(r.cloud_cover      ?? 0);
  if (varsMask & (1 << VARS_BIT.cch)) p.cloud_high  = Math.round(r.cloud_cover_high ?? 0);
  if (varsMask & (1 << VARS_BIT.ccm)) p.cloud_mid   = Math.round(r.cloud_cover_mid  ?? 0);
  if (varsMask & (1 << VARS_BIT.ccl)) p.cloud_low   = Math.round(r.cloud_cover_low  ?? 0);
  return p;
}

export interface ForecastParams {
  locationIdx: number;
  lat?: number;
  lon?: number;
  // The requested duration in days (`d:`) and the location's fixed UTC offset in whole
  // hours (`z:`).
  durationDays: number;
  utcOffsetHours: number;
  modelsMask: number;
  varsMask: number;
  maxChars: number;
  decoderVersion: number;
  // 7-bit message code from a `k:` request word, echoed in the response (default 0).
  code: number;
  // Request time as UTC hours since the epoch (`t:`), aligned to the hour.
  startEpochHour: number;
  // Normalized account token from a `u:` request word, or null when absent/malformed.
  // Phase 1 only records it; it does not yet gate the response.
  userToken: string | null;
}

const DEFAULT_MAX_CHARS = 160; // default response length cap (Garmin inReach reply limit)
const DEFAULT_DURATION_DAYS = 7; // default when the request has no `d:` token
const MAX_DURATION_DAYS = 10;

export function parseRequest(body: string): ForecastParams {
  const words = body.toLowerCase().trim().split(/\s+/);
  let locationIdx = 0;
  let lat: number | undefined;
  let lon: number | undefined;
  let durationDays = DEFAULT_DURATION_DAYS; // forecast duration, override with `d:` (days)
  let utcOffsetHours = 0; // local-midnight offset, override with `z:` (whole hours east of UTC)
  let modelsMask = 1; // ECMWF default
  let varsMask = 0;
  let maxChars = DEFAULT_MAX_CHARS; // override with a `c:` token in the request
  let decoderVersion = CURRENT_VERSION; // override with a `vN` token in the request
  let userToken: string | null = null; // set from a `u:` token in the request
  let code = 0; // client message code (`k:` token); echoed in the response so the client can
                // match it to the stored request and recover lat/lon/models/vars/duration
  let startEpochHour = NaN; // request time (`t:`, UTC hours since epoch); see below

  // Compact "X,Y" (message body) takes priority over "Lat X Lon Y" (Garmin email footer)
  const gpsMatch =
    body.match(/(-?\d+\.\d{4,}),(-?\d+\.\d{4,})/) ??
    body.match(/Lat\s+([-\d.]+)\s+Lon\s+([-\d.]+)/i);
  if (gpsMatch) {
    lat = parseFloat(gpsMatch[1]);
    lon = parseFloat(gpsMatch[2]);
    locationIdx = 0;
  }

  for (const word of words) {
    const colonIdx = word.indexOf(":");
    if (colonIdx !== -1) {
      const key = word.slice(0, colonIdx);
      const val = word.slice(colonIdx + 1);
      if (key === "l") {
        if (val === "current" || val === "here") {
          locationIdx = 0;
        } else if (val in LOCATION_NAME_TO_IDX) {
          locationIdx = LOCATION_NAME_TO_IDX[val];
        }
      } else if (key === "d") {
        // Duration in days, with or without a trailing "d" (d:7 or d:7d).
        const n = parseInt(val);
        if (!isNaN(n)) durationDays = Math.min(Math.max(n, 1), MAX_DURATION_DAYS);
      } else if (key === "z") {
        // The location's UTC offset in whole hours; out-of-range values are ignored.
        const n = parseInt(val);
        if (!isNaN(n) && n >= -12 && n <= 14) utcOffsetHours = n;
      } else if (key === "c") {
        const n = parseInt(val);
        if (!isNaN(n)) maxChars = Math.max(1, n);
      } else if (key === "m") {
        let mask = 0;
        for (const m of val.split(",")) {
          if (m in MODEL_NAME_TO_BIT) mask |= 1 << MODEL_NAME_TO_BIT[m];
        }
        if (mask) modelsMask = mask;
      } else if (key === "v") {
        for (const v of val.split(",")) {
          if (v in VARS_BIT) varsMask |= 1 << VARS_BIT[v];
        }
      } else if (key === "u") {
        // The body was lowercased above; normalizeToken restores canonical casing. Keep a
        // valid token (check symbol matches), drop a malformed one as if absent.
        if (isValidToken(val)) userToken = normalizeToken(val);
      } else if (key === "k") {
        const n = parseInt(val);
        if (!isNaN(n) && n >= 0 && n <= 127) code = n; // 7-bit message code, 0..127
      } else if (key === "t") {
        const n = parseInt(val);
        if (!isNaN(n) && n >= 0) startEpochHour = n; // UTC forecast start, hours since epoch
      }
    } else if (/^v\d+$/.test(word)) {
      decoderVersion = parseInt(word.slice(1));
    }
  }

  if (varsMask === 0) varsMask = DEFAULT_VARS_MASK;

  // Default the request time to "now", aligned down to the hour. The client normally supplies
  // `t:` so the forecast window is fixed against delivery delay, but a missing one is safe.
  if (isNaN(startEpochHour)) {
    startEpochHour = Math.floor(Date.now() / 3600000);
  }

  return { locationIdx, lat, lon, durationDays, utcOffsetHours, modelsMask, varsMask, maxChars, decoderVersion, userToken, code, startEpochHour };
}

function resolveLocation(params: ForecastParams): { lat: number; lon: number; elev_m?: number } {
  if (params.locationIdx === 0) {
    if (params.lat == null || params.lon == null)
      throw new Error("current location requested but no GPS coordinates in message");
    return { lat: params.lat, lon: params.lon };
  }
  const loc = NAMED_LOCATIONS[params.locationIdx];
  if (!loc) throw new Error(`Unknown location index: ${params.locationIdx}`);
  return { lat: loc.lat, lon: loc.lon, elev_m: loc.elev_m };
}

// A response carries exactly one model (the decoder assumes nModels=1), so take the first
// requested model bit only.
function firstModelKey(modelsMask: number): "HRES" | "GFS" | "ICON" | "IFS" {
  const modelKeys = (["HRES", "GFS", "ICON", "IFS"] as const).filter(
    (_, bit) => modelsMask & (1 << bit),
  );
  return modelKeys[0] ?? "HRES";
}

// ── Duration-first fill ─────────────────────────────────────────────────────────

// Builds and encodes the layout for one fill-sequence number from already-fetched hourly data,
// or returns null when the upstream data doesn't cover some period (a data gap — treat the
// layout as unservable). See layoutFor in the protocol package for the sequence definition.
export function encodeFillSeq(
  h: HourlyData,
  times: string[],
  params: ForecastParams,
  seq: number,
  lat: number,
  lon: number,
  elevation: number,
  modelKey: string,
  codec: VersionedCodec,
): string | null {
  const layout = layoutFor(params.durationDays, params.startEpochHour, params.utcOffsetHours, seq);

  // Hourly samples are keyed by UTC epoch hour; each period's window is just its hour range.
  const idxByHour = new Map<number, number>();
  for (let i = 0; i < times.length; i++) {
    idxByHour.set(Math.floor(Date.parse(`${times[i]}:00Z`) / 3600000), i);
  }
  const windows: number[][] = layout.periodStartUtcHour.map((start, p) => {
    const idx: number[] = [];
    for (let eh = start; eh < start + layout.periodHours[p]; eh++) {
      const i = idxByHour.get(eh);
      if (i !== undefined) idx.push(i);
    }
    return idx;
  });
  if (windows.some((w) => w.length === 0)) return null;

  const rows = rowsFromWindows(h, times, windows);
  const firstStart = new Date(layout.periodStartUtcHour[0] * 3600000);

  const msg: ForecastMessage = {
    version: params.decoderVersion,
    code: params.code,
    days: layout.days,
    models_mask: params.modelsMask,
    vars_mask: params.varsMask,
    month: firstStart.getUTCMonth() + 1,
    day: firstStart.getUTCDate(),
    hour: firstStart.getUTCHours(),
    lat,
    lon,
    elevation,
    periods: [rows.map((r) => toFullPeriod(r, params.varsMask, modelKey))],
    seq,
    durationDays: params.durationDays,
    periodHours: layout.periodHours,
  };
  return codec.encode(msg);
}

// Duration-first fill: one upstream fetch covers every candidate layout, then a binary search
// finds the largest fill-sequence number whose encoding fits the budget (encoded size grows
// along the sequence — see layout.ts). Always returns at least the seq=1 layout (a single 24h
// period), even if it exceeds the budget.
export async function fetchForecast(params: ForecastParams, codec: VersionedCodec): Promise<string> {
  const { lat, lon, elev_m } = resolveLocation(params);
  const modelKey = firstModelKey(params.modelsMask);

  // The window runs from local midnight of the request day (≤ 24h in the past for any UTC
  // offset — hence past_days=1) through durationDays full local days; +2 forecast days cover
  // the offset shift past the last UTC day boundary.
  const [h, times, elevation] = await fetchHourly(
    modelKey, params.durationDays + 2, lat, lon, "UTC", elev_m, 1,
  );

  const best = fitFillToBudget(
    (seq) => encodeFillSeq(h, times, params, seq, lat, lon, elevation, modelKey, codec),
    maxFillSeq(params.durationDays),
    params.maxChars,
  );
  if (best === null) throw new Error("upstream data does not cover the requested window");
  return best;
}

// Binary-searches the largest fill-sequence number whose encoding fits `maxChars`, keeping the
// largest candidate KNOWN to fit (encoded size can dip non-monotonically at a stage boundary
// when the request lands late in the day, so a fitting result is guaranteed, strict optimality
// is not). A null encoding (upstream data gap) is treated as not fitting. Returns the seq=1
// layout even when it exceeds the budget, and null only if even that is unservable.
export function fitFillToBudget(
  encodeSeq: (seq: number) => string | null,
  maxSeq: number,
  maxChars: number,
): string | null {
  let lo = 1;
  let hi = maxSeq;
  let best = encodeSeq(1);
  if (best === null) return null;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const encoded = encodeSeq(mid);
    if (encoded !== null && encoded.length <= maxChars) {
      best = encoded;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  return best;
}
