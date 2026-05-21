import {
  VERSION,
  MODEL_BIT,
  DEFAULT_VARS_MASK,
  VARS_BIT,
  type Period,
  type ForecastMessage,
  messageToString,
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
  "cloud_cover",
  "cloud_cover_high",
  "cloud_cover_mid",
  "cloud_cover_low",
  "visibility",
];
const PRESSURE_LEVELS = [500, 600, 700];
const PRESSURE_VAR_NAMES = ["temperature", "wind_speed", "wind_direction"];

function degToDirIdx(deg: number | null | undefined): number {
  if (deg == null) return 0;
  return Math.round(deg / 45) % 8;
}

function round5(v: number | null | undefined): number {
  return Math.round((v ?? 0) / 5) * 5;
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
  cloud_cover: (number | null)[];
  cloud_cover_high: (number | null)[];
  cloud_cover_mid: (number | null)[];
  cloud_cover_low: (number | null)[];
  visibility: (number | null)[];
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
  visibility_m: number | null;
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
    wind_speed_unit: "mph",
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
  nDays: number,
  resolutionIdx: number,
  lat: number,
  lon: number,
  tz: string,
  elev_m?: number,
): Promise<[Row[], number]> {
  const [h, times, elevation] = await fetchHourly(modelKey, nDays + 1, lat, lon, tz, elev_m);
  const hoursPerPeriod = HOURS_PER_PERIOD[resolutionIdx];
  const nTotal = nDays * (24 / hoursPerPeriod);

  const nowLocal = new Date().toLocaleString("sv-SE", { timeZone: tz });
  const nowDate = nowLocal.slice(0, 10);
  const nowHour = parseInt(nowLocal.slice(11, 13));
  const nowPeriodHour = Math.floor(nowHour / hoursPerPeriod) * hoursPerPeriod;
  const currentKey = `${nowDate}T${String(nowPeriodHour).padStart(2, "0")}`;

  type Window = { indices: number[] };
  const windows: Window[] = [];
  const windowMap = new Map<string, Window>();

  for (let i = 0; i < times.length; i++) {
    const date = times[i].slice(0, 10);
    const hour = parseInt(times[i].slice(11, 13));
    const startHour = Math.floor(hour / hoursPerPeriod) * hoursPerPeriod;
    const key = `${date}T${String(startHour).padStart(2, "0")}`;
    if (key < currentKey) continue;
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
      temp_c: maxOf(pick(h.temperature_2m)),
      wind_speed_10m: maxOf(sfcSpd),
      wind_direction_10m: dominantDirDeg(sfcSpd, sfcDir),
      precip: maxOf(pick(h.precipitation_probability)),
      weathercode: maxOf(pick(h.weather_code)),
      freezing_level_m: maxOf(pickUnk("freezing_level_height")),
      snow_cm: sumOf(pick(h.snowfall)),
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
      visibility_m: minOf(pick(h.visibility)),
    };
  });
  return [rows, elevation];
}

const PRESSURE_VAR_BITS =
  (1 << VARS_BIT.freeze) | (1 << VARS_BIT.w500) | (1 << VARS_BIT.w600) | (1 << VARS_BIT.w700);

export function toFullPeriod(r: Row, varsMask: number, modelKey: string, hoursPerPeriod: number): Period {
  if (MODEL_NO_PRESSURE.has(modelKey)) varsMask &= ~PRESSURE_VAR_BITS;
  const p: Period = { weathercode: r.weathercode ?? 0 };
  if (varsMask & (1 << VARS_BIT.precip)) p.precip = r.precip ?? 0;
  if (varsMask & (1 << VARS_BIT.temp)) p.temp_f = Math.round(((r.temp_c ?? 0) * 9) / 5 + 32);
  if (varsMask & (1 << VARS_BIT.snow)) {
    const inches = (r.snow_cm ?? 0) / 2.54;
    // daily: store whole inches (0–15); sub-daily: store tenths of an inch (0–15 = 0.0–1.5 in)
    p.snow_in = hoursPerPeriod >= 24
      ? Math.min(Math.round(inches), 15)
      : Math.min(Math.round(inches * 10), 15);
  }
  if (varsMask & (1 << VARS_BIT.freeze))
    p.freeze_ft = Math.round(((r.freezing_level_m ?? 0) * 3.28084) / 1000) * 1000;
  if (varsMask & (1 << VARS_BIT.wind)) {
    p.wind_sfc_mph = round5(r.wind_speed_10m);
    p.wind_sfc_dir = degToDirIdx(r.wind_direction_10m);
  }
  if (varsMask & (1 << VARS_BIT.w500)) {
    p.wind_500_mph = round5(r.wind_speed_500hPa);
    p.wind_500_dir = degToDirIdx(r.wind_direction_500hPa);
  }
  if (varsMask & (1 << VARS_BIT.w600)) {
    p.wind_600_mph = round5(r.wind_speed_600hPa);
    p.wind_600_dir = degToDirIdx(r.wind_direction_600hPa);
  }
  if (varsMask & (1 << VARS_BIT.w700)) {
    p.wind_700_mph = round5(r.wind_speed_700hPa);
    p.wind_700_dir = degToDirIdx(r.wind_direction_700hPa);
  }
  if (varsMask & (1 << VARS_BIT.cc))  p.cloud_total = Math.round(r.cloud_cover      ?? 0);
  if (varsMask & (1 << VARS_BIT.cch)) p.cloud_high  = Math.round(r.cloud_cover_high ?? 0);
  if (varsMask & (1 << VARS_BIT.ccm)) p.cloud_mid   = Math.round(r.cloud_cover_mid  ?? 0);
  if (varsMask & (1 << VARS_BIT.ccl)) p.cloud_low   = Math.round(r.cloud_cover_low  ?? 0);
  if (varsMask & (1 << VARS_BIT.vis)) p.vis_km = Math.min(Math.round((r.visibility_m ?? 0) / 1000), 15);
  return p;
}

export interface ForecastParams {
  locationIdx: number;
  lat?: number;
  lon?: number;
  days: number;
  resolutionIdx: number;
  modelsMask: number;
  varsMask: number;
}

export function parseRequest(body: string): ForecastParams {
  const words = body.toLowerCase().trim().split(/\s+/);
  let locationIdx = 0;
  let lat: number | undefined;
  let lon: number | undefined;
  let days = 10;
  let resolutionIdx = 0;
  let modelsMask = 1; // ECMWF default
  let varsMask = 0;

  // Compact "X,Y" (message body) takes priority over "Lat X Lon Y" (Garmin email footer)
  const gpsMatch =
    body.match(/(-?\d+\.\d{4,}),(-?\d+\.\d{4,})/) ??
    body.match(/Lat\s+([-\d.]+)\s+Lon\s+([-\d.]+)/i);
  if (gpsMatch) {
    lat = parseFloat(gpsMatch[1]);
    lon = parseFloat(gpsMatch[2]);
    locationIdx = 2;
  }

  for (const word of words) {
    if (word in LOCATION_NAME_TO_IDX) {
      locationIdx = LOCATION_NAME_TO_IDX[word];
    } else if (word === "current" || word === "here") {
      locationIdx = 0;
    } else if (/^\d+d$/.test(word)) {
      days = Math.max(1, Math.min(10, parseInt(word)));
    } else if (word in RESOLUTION_LABEL_TO_IDX) {
      resolutionIdx = RESOLUTION_LABEL_TO_IDX[word];
    } else if (word in VARS_BIT) {
      varsMask |= 1 << VARS_BIT[word];
    } else {
      const parts = word.split(",");
      if (parts.some((m) => m in MODEL_NAME_TO_BIT)) {
        let mask = 0;
        for (const m of parts) {
          if (m in MODEL_NAME_TO_BIT) mask |= 1 << MODEL_NAME_TO_BIT[m];
        }
        if (mask) modelsMask = mask;
      }
    }
  }

  if (varsMask === 0) varsMask = DEFAULT_VARS_MASK;

  return { locationIdx, lat, lon, days, resolutionIdx, modelsMask, varsMask };
}

export async function fetchForecast(params: ForecastParams): Promise<string> {
  let lat: number, lon: number, tz: string, elev_m: number | undefined;
  if (params.locationIdx === 0) {
    if (params.lat == null || params.lon == null)
      throw new Error("current location requested but no GPS coordinates in message");
    [lat, lon, tz] = [params.lat, params.lon, "America/Anchorage"];
    elev_m = undefined;
  } else {
    const loc = NAMED_LOCATIONS[params.locationIdx];
    if (!loc) throw new Error(`Unknown location index: ${params.locationIdx}`);
    ({ lat, lon, tz, elev_m } = loc);
  }

  const modelKeys = (["HRES", "GFS", "ICON", "IFS"] as const).filter(
    (_, bit) => params.modelsMask & (1 << bit),
  );
  const keys = modelKeys.length ? modelKeys : (["HRES"] as const);

  const results = await Promise.all(
    keys.map((key) => aggregateRows(key, params.days, params.resolutionIdx, lat, lon, tz, elev_m)),
  );
  const rowsPerModel = results.map(([rows]) => rows);
  const elevation = results[0][1];

  const firstTime = rowsPerModel[0][0].time;
  const month = parseInt(firstTime.slice(5, 7));
  const day = parseInt(firstTime.slice(8, 10));
  const hour = parseInt(firstTime.slice(11, 13));

  const msg: ForecastMessage = {
    version: VERSION,
    location: params.locationIdx,
    days: params.days,
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
      rows.map((r) => toFullPeriod(r, params.varsMask, keys[mi], HOURS_PER_PERIOD[params.resolutionIdx])),
    ),
  };

  return messageToString(msg);
}
