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

const LOCATION_COORDS: Record<string, [number, number, string]> = {
  upper: [63.135, -150.989, "America/Anchorage"],
  airstrip: [62.967, -151.057, "America/Anchorage"],
};

const RESOLUTION_TARGET_HOURS: Record<number, number[] | null> = {
  0: null,
  1: [0, 12],
  2: [0, 6, 12, 18],
  3: [0, 3, 6, 9, 12, 15, 18, 21],
  4: Array.from({ length: 24 }, (_, i) => i),
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
  [key: string]: unknown[];
}

interface Row {
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
}

async function fetchHourly(
  modelKey: string,
  nDays: number,
  lat: number,
  lon: number,
  tz: string,
): Promise<[HourlyData, string[]]> {
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
  const resp = await fetch(`https://api.open-meteo.com/v1/forecast?${params}`);
  if (!resp.ok) throw new Error(`Open-Meteo ${resp.status}: ${await resp.text()}`);
  const data = (await resp.json()) as { hourly: HourlyData };
  return [data.hourly, data.hourly.time];
}

function buildRow(h: HourlyData, times: string[], idx: number, snowCm: number): Row {
  const opt = (key: string): number | null =>
    ((h[key] as (number | null)[] | undefined)?.[idx] ?? null);
  return {
    time: times[idx],
    temp_c: h.temperature_2m[idx],
    wind_speed_10m: h["wind_speed_10m"][idx] as number | null,
    wind_direction_10m: h["wind_direction_10m"][idx] as number | null,
    precip: h.precipitation_probability[idx],
    weathercode: h.weather_code[idx],
    freezing_level_m: opt("freezing_level_height"),
    snow_cm: snowCm,
    wind_speed_500hPa: opt("wind_speed_500hPa"),
    wind_direction_500hPa: opt("wind_direction_500hPa"),
    wind_speed_600hPa: opt("wind_speed_600hPa"),
    wind_direction_600hPa: opt("wind_direction_600hPa"),
    wind_speed_700hPa: opt("wind_speed_700hPa"),
    wind_direction_700hPa: opt("wind_direction_700hPa"),
    cloud_cover: opt("cloud_cover"),
    cloud_cover_high: opt("cloud_cover_high"),
    cloud_cover_mid: opt("cloud_cover_mid"),
    cloud_cover_low: opt("cloud_cover_low"),
  };
}

async function noonRows(
  modelKey: string,
  nDays: number,
  lat: number,
  lon: number,
  tz: string,
): Promise<Row[]> {
  const [h, times] = await fetchHourly(modelKey, nDays, lat, lon, tz);
  const snowArr = h.snowfall;
  const dailySnow: Record<string, number> = {};
  for (let i = 0; i < times.length; i++) {
    const date = times[i].slice(0, 10);
    dailySnow[date] = (dailySnow[date] ?? 0) + ((snowArr[i] as number) || 0);
  }
  const rows: Row[] = [];
  for (let i = 0; i < times.length && rows.length < nDays; i++) {
    if (times[i].endsWith("T12:00")) {
      const date = times[i].slice(0, 10);
      rows.push(buildRow(h, times, i, Math.round((dailySnow[date] ?? 0) * 10) / 10));
    }
  }
  return rows;
}

async function hourRows(
  modelKey: string,
  nDays: number,
  targetHours: number[],
  lat: number,
  lon: number,
  tz: string,
): Promise<Row[]> {
  const [h, times] = await fetchHourly(modelKey, nDays, lat, lon, tz);
  const snowArr = h.snowfall;
  const nTotal = nDays * targetHours.length;
  const rows: Row[] = [];
  for (let i = 0; i < times.length && rows.length < nTotal; i++) {
    const hour = parseInt(times[i].slice(11, 13));
    if (targetHours.includes(hour)) {
      rows.push(buildRow(h, times, i, (snowArr[i] as number) || 0));
    }
  }
  return rows;
}

const PRESSURE_VAR_BITS =
  (1 << VARS_BIT.freeze) | (1 << VARS_BIT.w500) | (1 << VARS_BIT.w600) | (1 << VARS_BIT.w700);

function toFullPeriod(r: Row, daily: boolean, varsMask: number, modelKey: string): Period {
  if (MODEL_NO_PRESSURE.has(modelKey)) varsMask &= ~PRESSURE_VAR_BITS;
  const p: Period = { weathercode: r.weathercode ?? 0 };
  if (varsMask & (1 << VARS_BIT.precip)) p.precip = r.precip ?? 0;
  if (varsMask & (1 << VARS_BIT.temp)) p.temp_f = Math.round(((r.temp_c ?? 0) * 9) / 5 + 32);
  if (varsMask & (1 << VARS_BIT.snow)) {
    const snowIn = daily
      ? Math.round((r.snow_cm ?? 0) / 2.54)
      : Math.round((r.snow_cm ?? 0) / 0.254);
    p.snow_in = Math.min(snowIn, 15);
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
    if (word === "upper") {
      locationIdx = 0;
    } else if (word === "airstrip") {
      locationIdx = 1;
    } else if (word === "current" || word === "here") {
      locationIdx = 2;
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
  const locationNames = Object.keys(LOCATION_COORDS);
  const locationName = locationNames[params.locationIdx];
  let lat: number, lon: number, tz: string;
  if (params.locationIdx === 2) {
    if (params.lat == null || params.lon == null)
      throw new Error("current location requested but no GPS coordinates in message");
    [lat, lon, tz] = [params.lat, params.lon, "America/Anchorage"];
  } else {
    [lat, lon, tz] = LOCATION_COORDS[locationName];
  }

  const modelKeys = (["HRES", "GFS", "ICON", "IFS"] as const).filter(
    (_, bit) => params.modelsMask & (1 << bit),
  );
  const keys = modelKeys.length ? modelKeys : (["HRES"] as const);

  const targetHours = RESOLUTION_TARGET_HOURS[params.resolutionIdx];
  const daily = params.resolutionIdx === 0;

  const rowsPerModel: Row[][] = await Promise.all(
    keys.map((key) =>
      daily
        ? noonRows(key, params.days, lat, lon, tz)
        : hourRows(key, params.days, targetHours!, lat, lon, tz),
    ),
  );

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
    periods: rowsPerModel.map((rows, mi) =>
      rows.map((r) => toFullPeriod(r, daily, params.varsMask, keys[mi])),
    ),
  };

  return messageToString(msg);
}
