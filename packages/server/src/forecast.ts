import {
  MODEL_BIT,
  DEFAULT_VARS_MASK,
  VARS_BIT,
  CURRENT_VERSION,
  isValidToken,
  normalizeToken,
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

const RESOLUTION_LABEL_TO_IDX: Record<string, number> = {
  daily: 0,
  "24h": 0,
  "12h": 1,
  "6h": 2,
  "3h": 3,
  "1h": 4,
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

interface HourlyData {
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
  const nTotal = nPeriods;

  const anchorKey = new Date(startEpochHour * 3600000).toISOString().slice(0, 13); // "YYYY-MM-DDTHH"

  type Window = { indices: number[] };
  const windows: Window[] = [];
  const windowMap = new Map<string, Window>();

  for (let i = 0; i < times.length; i++) {
    const date = times[i].slice(0, 10);
    const hour = parseInt(times[i].slice(11, 13));
    const startHour = Math.floor(hour / hoursPerPeriod) * hoursPerPeriod;
    const key = `${date}T${String(startHour).padStart(2, "0")}`;
    if (key < anchorKey) continue;
    if (!windowMap.has(key)) {
      if (windows.length >= nTotal) break;
      const w: Window = { indices: [] };
      windowMap.set(key, w);
      windows.push(w);
    }
    windowMap.get(key)!.indices.push(i);
  }

  const rows = windows.map((w) => {
    const idx = w.indices;
    const pick = (arr: (number | null)[]): (number | null)[] => idx.map((i) => arr[i]);
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
  return [rows, elevation];
}

const PRESSURE_VAR_BITS =
  (1 << VARS_BIT.freeze) | (1 << VARS_BIT.w500) | (1 << VARS_BIT.w600) | (1 << VARS_BIT.w700);

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
  nPeriods: number;
  resolutionIdx: number;
  modelsMask: number;
  varsMask: number;
  maxChars: number;
  decoderVersion: number;
  // 7-bit message code from a `k:` request word, echoed in the response (default 0).
  code: number;
  // Requested UTC forecast start as hours since the epoch (`t:`), aligned to the resolution.
  startEpochHour: number;
  // Normalized account token from a `u:` request word, or null when absent/malformed.
  // Phase 1 only records it; it does not yet gate the response.
  userToken: string | null;
}

// 7-bit period count in the protocol header → 1..128 periods.
const MAX_PERIODS = 128;
const DEFAULT_MAX_CHARS = 160; // default response length cap (Garmin inReach reply limit)
const HORIZON_DAYS = 15;       // upstream forecast horizon

function popcount(n: number): number {
  let c = 0;
  while (n) { c += n & 1; n >>>= 1; }
  return c;
}

// How many periods to fetch from upstream: the full forecast horizon for the resolution, capped
// by the protocol's 7-bit period field. The adaptive encoding is variable-length, so we no longer
// size the response analytically — instead we over-fetch the horizon and trim the encoded message
// to the budget afterwards (see fitEncodedToBudget). The client may receive fewer periods than
// fetched; that's expected.
function horizonPeriods(resolutionIdx: number): number {
  const periodsPerDay = 24 / HOURS_PER_PERIOD[resolutionIdx];
  return Math.min(MAX_PERIODS, Math.floor(HORIZON_DAYS * periodsPerDay));
}

export function parseRequest(body: string): ForecastParams {
  const words = body.toLowerCase().trim().split(/\s+/);
  let locationIdx = 0;
  let lat: number | undefined;
  let lon: number | undefined;
  let resolutionIdx = 0;
  let modelsMask = 1; // ECMWF default
  let varsMask = 0;
  let maxChars = DEFAULT_MAX_CHARS; // override with a `c:` token in the request
  let decoderVersion = CURRENT_VERSION; // override with a `vN` token in the request
  let userToken: string | null = null; // set from a `u:` token in the request
  let code = 0; // client message code (`k:` token); echoed in the response so the client can
                // match it to the stored request and recover lat/lon/models/vars/resolution
  let startEpochHour = NaN; // requested UTC forecast start (`t:`, hours since epoch); see below

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
      } else if (key === "r") {
        if (val in RESOLUTION_LABEL_TO_IDX) resolutionIdx = RESOLUTION_LABEL_TO_IDX[val];
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

  // Default the forecast start to "now", aligned down to the resolution boundary in UTC. The client
  // normally supplies `t:` so the start is fixed against delivery delay, but a missing one is safe.
  const hoursPerPeriod = HOURS_PER_PERIOD[resolutionIdx];
  if (isNaN(startEpochHour)) {
    startEpochHour = Math.floor(Math.floor(Date.now() / 3600000) / hoursPerPeriod) * hoursPerPeriod;
  }

  // The request carries no period count: fetch the full horizon and trim the encoded reply to
  // the requested max length afterwards (the encoding is variable-length, so the fit can't be
  // computed up front).
  const nPeriods = horizonPeriods(resolutionIdx);

  return { locationIdx, lat, lon, nPeriods, resolutionIdx, modelsMask, varsMask, maxChars, decoderVersion, userToken, code, startEpochHour };
}

export async function fetchForecast(params: ForecastParams, codec: VersionedCodec): Promise<string> {
  let lat: number, lon: number, elev_m: number | undefined;
  if (params.locationIdx === 0) {
    if (params.lat == null || params.lon == null)
      throw new Error("current location requested but no GPS coordinates in message");
    [lat, lon] = [params.lat, params.lon];
    elev_m = undefined;
  } else {
    const loc = NAMED_LOCATIONS[params.locationIdx];
    if (!loc) throw new Error(`Unknown location index: ${params.locationIdx}`);
    ({ lat, lon, elev_m } = loc);
  }

  // A response carries exactly one model (the decoder assumes nModels=1), so take the first
  // requested model bit only.
  const modelKeys = (["HRES", "GFS", "ICON", "IFS"] as const).filter(
    (_, bit) => params.modelsMask & (1 << bit),
  );
  const keys = [modelKeys[0] ?? "HRES"] as const;

  const results = await Promise.all(
    keys.map((key) => aggregateRows(key, params.nPeriods, params.resolutionIdx, lat, lon, params.startEpochHour, elev_m)),
  );
  const rowsPerModel = results.map(([rows]) => rows);
  const elevation = results[0][1];

  // The protocol encodes the period count directly; `days` is the calendar-day span (for
  // display) implied by however many period rows the upstream API actually returned.
  const periodsPerDay = 24 / HOURS_PER_PERIOD[params.resolutionIdx];
  const days = Math.max(1, Math.ceil(rowsPerModel[0].length / periodsPerDay));

  // month/day/hour are carried on the message for display but not on the wire (the client recovers
  // the start from its stored request). Derive them from the requested UTC start.
  const startDate = new Date(params.startEpochHour * 3600000);
  const month = startDate.getUTCMonth() + 1;
  const day = startDate.getUTCDate();
  const hour = startDate.getUTCHours();

  const msg: ForecastMessage = {
    version: params.decoderVersion,
    code: params.code,
    days,
    resolution: params.resolutionIdx,
    models_mask: params.modelsMask,
    vars_mask: params.varsMask,
    month,
    day,
    hour,
    lat,
    lon,
    elevation,
    periods: rowsPerModel.map((rows, mi) =>
      rows.map((r) => toFullPeriod(r, params.varsMask, keys[mi])),
    ),
  };

  return fitEncodedToBudget(msg, params.maxChars, codec);
}

// Encodes the largest leading prefix of periods whose encoded form fits `maxChars`. Encoded length
// is monotonic non-decreasing in the period count, so we binary-search the cutoff. Always returns
// at least one period, even if a single period exceeds the budget.
function fitEncodedToBudget(msg: ForecastMessage, maxChars: number, codec: VersionedCodec): string {
  const encodeFirst = (n: number): string =>
    codec.encode({ ...msg, periods: msg.periods.map((rows) => rows.slice(0, n)) });

  let lo = 1;
  let hi = msg.periods[0].length;
  let best = encodeFirst(1);
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const encoded = encodeFirst(mid);
    if (encoded.length <= maxChars) {
      best = encoded;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  return best;
}
