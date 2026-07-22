import {
  MODEL_BIT,
  ALWAYS_VARS_MASK,
  CONFIGURABLE_VAR_GROUPS,
  VARS_BIT,
  CURRENT_VERSION,
  isValidToken,
  normalizeToken,
  layoutFor,
  type FillLayout,
  maxFillSeq,
  FILL_SLOTS,
  DEFAULT_MODE,
  MODE_DETAIL,
  MODE_AUTO,
  MODE_RANGE,
  type Period,
  type ForecastMessage,
  type VersionedCodec,
} from "@weather/protocol";

// Each forecast center resolves to a pair of Open-Meteo model ids: one for surface variables and
// one for pressure-level variables (500/600/700 hPa wind + temp). They're the same id except for
// Europe, where the 9 km HRES (ecmwf_ifs) supplies the surface fields but carries no pressure
// levels, so those are filled from the 0.25° IFS (ecmwf_ifs025) in a second request. `freeze` is
// whether the center provides freezing_level_height at all (GEM and both ECMWF models do not).
interface CenterSources {
  surface: string;
  pressure: string;
  freeze: boolean;
}
const CENTERS: Record<string, CenterSources> = {
  BEST: { surface: "best_match",   pressure: "best_match",   freeze: true },
  US:   { surface: "gfs_seamless", pressure: "gfs_seamless", freeze: true },
  CA:   { surface: "gem_seamless", pressure: "gem_seamless", freeze: false },
  EU:   { surface: "ecmwf_ifs",    pressure: "ecmwf_ifs025", freeze: false },
};

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

// User-facing `m:` request-token → center bit. One canonical token per center.
const MODEL_NAME_TO_BIT: Record<string, number> = {
  best: MODEL_BIT["BEST"],
  us: MODEL_BIT["US"],
  ca: MODEL_BIT["CA"],
  eu: MODEL_BIT["EU"],
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
  temp_c: number | null;
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

async function fetchOpenMeteo(
  source: string,
  hourlyVars: string[],
  nDays: number,
  lat: number,
  lon: number,
  tz: string,
  elev_m?: number,
  pastDays = 0,
): Promise<{ hourly: HourlyData; elevation: number }> {
  const params = new URLSearchParams({
    latitude: String(lat),
    longitude: String(lon),
    hourly: hourlyVars.join(","),
    timezone: tz,
    forecast_days: String(nDays),
    models: source,
  });
  if (elev_m !== undefined) params.set("elevation", String(elev_m));
  if (pastDays > 0) params.set("past_days", String(pastDays));
  const url = `https://api.open-meteo.com/v1/forecast?${params}`;
  console.log("Open-Meteo request:", url);
  const resp = await fetch(url);
  if (!resp.ok) throw new Error(`Open-Meteo ${resp.status}: ${await resp.text()}`);
  const data = (await resp.json()) as { hourly: HourlyData; elevation: number };
  return { hourly: data.hourly, elevation: data.elevation ?? 0 };
}

// Merge pressure-level columns from `pres` onto the surface response `surf`, aligning by the
// shared hourly time grid. Both requests use identical lat/lon/forecast_days/timezone, so their
// time arrays should match exactly; we index `pres` by timestamp and fill any unmatched hour
// with null, in case the pressure source returns a shorter horizon than the surface source.
function mergeHourly(surf: HourlyData, pres: HourlyData, pressureVars: string[]): HourlyData {
  const presIdx = new Map<string, number>();
  pres.time.forEach((t, i) => presIdx.set(t, i));
  for (const v of pressureVars) {
    const src = pres[v] as (number | null)[] | undefined;
    surf[v] = surf.time.map((t) => {
      const i = presIdx.get(t);
      return i !== undefined && src ? src[i] ?? null : null;
    });
  }
  return surf;
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
  const center = CENTERS[modelKey];
  const pressureVars = PRESSURE_VAR_NAMES.flatMap((v) =>
    PRESSURE_LEVELS.map((l) => `${v}_${l}hPa`),
  );
  // Drop freezing_level_height from the request for centers that don't provide it (GEM, ECMWF);
  // toFullPeriod also clears the freeze vars_mask bit so it never reaches the wire.
  const surfaceVars = center.freeze
    ? SURFACE_VARS
    : SURFACE_VARS.filter((v) => v !== "freezing_level_height");

  if (center.surface === center.pressure) {
    const { hourly, elevation } = await fetchOpenMeteo(
      center.surface, [...surfaceVars, ...pressureVars], nDays, lat, lon, tz, elev_m, pastDays,
    );
    return [hourly, hourly.time, elevation];
  }

  // Split sources (Europe): surface fields from the 9 km HRES, pressure levels from IFS 0.25°.
  // Elevation comes from the surface source (its finer grid is the better terrain match).
  const [surf, pres] = await Promise.all([
    fetchOpenMeteo(center.surface, surfaceVars, nDays, lat, lon, tz, elev_m, pastDays),
    fetchOpenMeteo(center.pressure, pressureVars, nDays, lat, lon, tz, elev_m, pastDays),
  ]);
  const merged = mergeHourly(surf.hourly, pres.hourly, pressureVars);
  return [merged, merged.time, surf.elevation];
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
  utcOffsetHours = 0,
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

  return rowsFromWindows(h, times, windows, utcOffsetHours);
}

// One representative temperature per window: a real sample of the hourly curve, chosen so that
// min/max over a local day's reported values recover the daily extremes:
//   - the window containing the local day's min reports that min; likewise the max;
//   - every other window reports its midpoint sample;
//   - when both extremes fall in one window (~11% of days at 12h, mostly evening declines),
//     that window keeps whichever extreme the day's other windows patch worse, and the best
//     patching window reports its own min/max instead of its midpoint.
// Extremes are identified at wire precision (1°C), so quantization ties leave room to separate
// them; the reported values are raw hourly samples. This selection is encoder policy, not wire
// format — the wire only promises one real sample per period (see Period.temp_c in the protocol).
export function representativeTemps(
  temps: (number | null)[] | undefined,
  times: string[],
  windows: number[][],
  utcOffsetHours: number,
): (number | null)[] {
  // Default: the window's midpoint sample (nearest non-null hour to the middle).
  const midSample = (idx: number[]): number | null => {
    const mid = idx.length >> 1;
    for (let d = 0; d < idx.length; d++) {
      for (const j of d === 0 ? [mid] : [mid - d, mid + d]) {
        const t = j >= 0 && j < idx.length ? temps?.[idx[j]] : null;
        if (t != null) return t;
      }
    }
    return null;
  };
  const out = windows.map(midSample);

  // Group windows by the local day of their first hour (windows never straddle local days —
  // the layout is local-midnight-justified with this same offset).
  const byDay = new Map<number, number[]>();
  windows.forEach((idx, p) => {
    if (idx.length === 0) return;
    const utcHour = Math.floor(Date.parse(`${times[idx[0]]}:00Z`) / 3600000);
    const day = Math.floor((utcHour + utcOffsetHours) / 24);
    const wins = byDay.get(day);
    if (wins) wins.push(p); else byDay.set(day, [p]);
  });

  for (const wins of byDay.values()) {
    // Per-window raw extremes over non-null hours.
    const lo = new Map<number, number>();
    const hi = new Map<number, number>();
    for (const p of wins) {
      for (const i of windows[p]) {
        const t = temps?.[i];
        if (t == null) continue;
        if (!lo.has(p) || t < lo.get(p)!) lo.set(p, t);
        if (!hi.has(p) || t > hi.get(p)!) hi.set(p, t);
      }
    }
    const withData = wins.filter((p) => lo.has(p));
    if (withData.length === 0) continue;

    const dayMin = Math.min(...withData.map((p) => Math.round(lo.get(p)!)));
    const dayMax = Math.max(...withData.map((p) => Math.round(hi.get(p)!)));
    if (dayMin === dayMax) continue; // flat day: every sample already recovers both extremes

    const pMin = withData.filter((p) => Math.round(lo.get(p)!) === dayMin);
    const pMax = withData.filter((p) => Math.round(hi.get(p)!) === dayMax);

    if (pMin.length > 1 || pMax.length > 1 || pMin[0] !== pMax[0]) {
      // Separable: report each extreme from a distinct window.
      const pm = pMin.find((p) => !pMax.includes(p)) ?? pMin[0];
      const px = pMax.find((p) => p !== pm)!;
      out[pm] = lo.get(pm)!;
      out[px] = hi.get(px)!;
    } else {
      // Collision: both extremes confined to one window.
      const pc = pMin[0];
      const others = withData.filter((p) => p !== pc);
      if (others.length === 0) {
        // Single-window (partial) day: keep the max — partial day-0 windows start at the
        // request period and usually contain the remaining day's high.
        out[pc] = hi.get(pc)!;
        continue;
      }
      let poMin = others[0], poMax = others[0];
      for (const p of others) {
        if (lo.get(p)! < lo.get(poMin)!) poMin = p;
        if (hi.get(p)! > hi.get(poMax)!) poMax = p;
      }
      const errKeepMax = Math.round(lo.get(poMin)!) - dayMin;
      const errKeepMin = dayMax - Math.round(hi.get(poMax)!);
      if (errKeepMax <= errKeepMin) {
        out[pc] = hi.get(pc)!;
        out[poMin] = lo.get(poMin)!;
      } else {
        out[pc] = lo.get(pc)!;
        out[poMax] = hi.get(poMax)!;
      }
    }
  }
  return out;
}

// Aggregate hourly samples into one Row per window (a window is the hourly indices it covers).
// Shared by the uniform-resolution keying above and the layout-driven windows (v2) below.
// `utcOffsetHours` defines the local days the representative temp selection works over; the
// UTC-keyed aggregation paths (scripts/corpus) pass 0, matching their UTC-aligned windows.
export function rowsFromWindows(
  h: HourlyData, times: string[], windows: number[][], utcOffsetHours = 0,
): Row[] {
  const repTemps = representativeTemps(h.temperature_2m, times, windows, utcOffsetHours);
  const rows = windows.map((idx, w) => {
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
      temp_c: repTemps[w],
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

export function toFullPeriod(r: Row, varsMask: number, modelKey: string): Period {
  // Centers without a freezing-level product never carry that variable on the wire.
  if (!CENTERS[modelKey].freeze) varsMask &= ~(1 << VARS_BIT.freeze);
  const p: Period = { weathercode: r.weathercode ?? 0 };
  if (varsMask & (1 << VARS_BIT.precip)) p.precip     = r.precip ?? 0;
  if (varsMask & (1 << VARS_BIT.temp))   p.temp_c     = r.temp_c ?? 0;
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
  if (varsMask & (1 << VARS_BIT.cch)) p.cloud_high  = Math.round(r.cloud_cover_high ?? 0);
  if (varsMask & (1 << VARS_BIT.ccm)) p.cloud_mid   = Math.round(r.cloud_cover_mid  ?? 0);
  if (varsMask & (1 << VARS_BIT.ccl)) p.cloud_low   = Math.round(r.cloud_cover_low  ?? 0);
  return p;
}

export interface ForecastParams {
  locationIdx: number;
  lat?: number;
  lon?: number;
  // The requested priority mode (`p:` — MODE_DETAIL/MODE_AUTO/MODE_RANGE) and the location's
  // fixed UTC offset in whole hours (`z:`). The mode orders the fill path; the window is
  // always the rest of the request day plus up to FILL_HORIZON_DAYS whole local days (see
  // layoutFor).
  mode: number;
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
// `p:` token values → priority modes; a missing or unknown token means Auto.
const MODE_TOKENS: Record<string, number> = {
  d: MODE_DETAIL, a: MODE_AUTO, r: MODE_RANGE,
};

export function parseRequest(body: string): ForecastParams {
  const words = body.toLowerCase().trim().split(/\s+/);
  let locationIdx = 0;
  let lat: number | undefined;
  let lon: number | undefined;
  let mode = DEFAULT_MODE; // priority mode, override with `p:` (d/a/r)
  let utcOffsetHours = 0; // local-midnight offset, override with `z:` (whole hours east of UTC)
  let modelsMask = 1; // Best Match default (bit 0)
  // Core variables are implicit; `v:` carries only user-configurable additions.
  let varsMask = ALWAYS_VARS_MASK;
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
      } else if (key === "p") {
        // Priority mode: p:d (Detail), p:a (Auto), p:r (Range). Unknown values keep Auto.
        if (val in MODE_TOKENS) mode = MODE_TOKENS[val];
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
        // Compact group codes need no delimiter (`v:cwf`). Keep accepting comma-separated and
        // long-form protocol variable names for requests produced by older clients.
        const requestedVars = /^[cwf]+$/.test(val) ? [...val] : val.split(",");
        for (const v of requestedVars) {
          const group = CONFIGURABLE_VAR_GROUPS[
            v as keyof typeof CONFIGURABLE_VAR_GROUPS
          ];
          for (const variable of group ?? [v]) {
            if (variable in VARS_BIT) varsMask |= 1 << VARS_BIT[variable];
          }
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

  // Default the request time to "now", aligned down to the hour. The client normally supplies
  // `t:` so the forecast window is fixed against delivery delay, but a missing one is safe.
  if (isNaN(startEpochHour)) {
    startEpochHour = Math.floor(Date.now() / 3600000);
  }

  return { locationIdx, lat, lon, mode, utcOffsetHours, modelsMask, varsMask, maxChars, decoderVersion, userToken, code, startEpochHour };
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
function firstModelKey(modelsMask: number): "BEST" | "US" | "CA" | "EU" {
  const modelKeys = (["BEST", "US", "CA", "EU"] as const).filter(
    (_, bit) => modelsMask & (1 << bit),
  );
  return modelKeys[0] ?? "BEST";
}

// ── Duration-first fill ─────────────────────────────────────────────────────────

// Builds the message for one fill-sequence number from already-fetched hourly data, or returns
// null when the upstream data doesn't cover some period (a data gap — treat the layout as
// unservable). See layoutFor in the protocol package for the sequence definition.
export function buildFillMessage(
  h: HourlyData,
  times: string[],
  params: ForecastParams,
  seq: number,
  lat: number,
  lon: number,
  elevation: number,
  modelKey: string,
): ForecastMessage | null {
  const layout = layoutFor(params.mode, params.startEpochHour, params.utcOffsetHours, seq);
  return buildLayoutMessage(h, times, params, layout, lat, lon, elevation, modelKey);
}

// buildFillMessage with the layout supplied directly instead of derived from a seq. The request
// path never calls this; it exists so offline probes (and future layout schemes) can encode
// hand-built layouts through the identical aggregation path.
export function buildLayoutMessage(
  h: HourlyData,
  times: string[],
  params: ForecastParams,
  layout: FillLayout,
  lat: number,
  lon: number,
  elevation: number,
  modelKey: string,
): ForecastMessage | null {
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

  // A period whose hours exist on the time axis but carry no data at all is an upstream
  // horizon gap — Open-Meteo returns nulls past a model's last forecast day (GEM ends at 10;
  // the fill horizon is 12). Treat the layout as unservable, exactly like a missing hour:
  // coverage only grows along the fill path, so the seq search naturally clamps to the data
  // the model actually has, with zero wire bits. Temperature is the sentinel (always fetched);
  // scattered single-hour nulls inside an otherwise-populated period still aggregate fine.
  if (windows.some((w) => w.every((i) => h.temperature_2m[i] == null))) return null;

  const rows = rowsFromWindows(h, times, windows, params.utcOffsetHours);
  const firstStart = new Date(layout.periodStartUtcHour[0] * 3600000);

  return {
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
    seq: layout.seq,
    mode: params.mode,
    periodHours: layout.periodHours,
    utcOffsetHours: params.utcOffsetHours,
  };
}

// buildFillMessage + encode, for the request path (see fetchForecast).
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
  const msg = buildFillMessage(h, times, params, seq, lat, lon, elevation, modelKey);
  return msg === null ? null : codec.encode(msg);
}

// Duration-first fill: one upstream fetch covers every candidate layout, then a binary search
// finds the largest fill-sequence number whose encoding fits the budget (encoded size grows
// along the sequence — see layout.ts). Always returns at least the seq=1 layout (one day at 12h),
// even if it exceeds the budget.
export async function fetchForecast(params: ForecastParams, codec: VersionedCodec): Promise<string> {
  const { lat, lon, elev_m } = resolveLocation(params);
  const modelKey = firstModelKey(params.modelsMask);

  // The window runs from local midnight of the request day (≤ 24h in the past for any UTC
  // offset — hence past_days=1) through the rest of that day plus up to FILL_HORIZON_DAYS full
  // local days (FILL_SLOTS covers both); +2 forecast days cover the offset shift past the last
  // UTC day boundary. Models whose horizon ends earlier (GEM: 10 days) return nulls for the
  // tail hours, which buildLayoutMessage treats as unservable — the seq search clamps to them.
  const [h, times, elevation] = await fetchHourly(
    modelKey, FILL_SLOTS + 2, lat, lon, "UTC", elev_m, 1,
  );

  const best = fitFillToBudget(
    (seq) => encodeFillSeq(h, times, params, seq, lat, lon, elevation, modelKey, codec),
    (encoded) => encoded.length,
    maxFillSeq(params.mode),
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
//
// Generic in what `encodeSeq` yields so callers that need more than the string (the benchmark
// wants each candidate's bit breakdown) can search over the identical sequence: `charsOf`
// measures a candidate against the budget.
export function fitFillToBudget<T>(
  encodeSeq: (seq: number) => T | null,
  charsOf: (encoded: T) => number,
  maxSeq: number,
  maxChars: number,
): T | null {
  let lo = 1;
  let hi = maxSeq;
  let best = encodeSeq(1);
  if (best === null) return null;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const encoded = encodeSeq(mid);
    if (encoded !== null && charsOf(encoded) <= maxChars) {
      best = encoded;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  return best;
}
