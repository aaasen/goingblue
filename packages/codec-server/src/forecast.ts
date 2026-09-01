import {
  MODEL_BIT,
  ALWAYS_VARS,
  CONFIGURABLE_VAR_GROUPS,
  VAR_GROUP_CODES,
  VAR,
  VARIABLES,
  type Variable,
  isValidToken,
  normalizeToken,
  layoutFor,
  type FillLayout,
  maxFillSeq,
  effectiveMode,
  FILL_SLOTS,
  DEFAULT_MODE,
  MODE_DETAIL,
  MODE_AUTO,
  MODE_RANGE,
  type Period,
  type ForecastMessage,
  type VersionedCodec,
  type Alphabet,
  type DeviceCode,
  DEVICE_TRANSPORT,
  MAX_MESSAGES,
  isDeviceCode,
  maxCharsFor,
  UNCAPPED_MAX_CHARS,
  partBodyChars,
  splitReply,
  WIRE_HEADER_CHARS,
  CLOUD_BAND_LEVELS_HPA,
  WIND_LEVELS_HPA, WIND_LEVEL_VARS, windLevelVar,
  CLOUD_COVER_MIN_PCT,
  quantCover,
} from "@weather/protocol";
import { fetchWeatherApi } from "openmeteo";
import { Variable as OmVariable } from "@openmeteo/sdk/variable.js";
import type { VariableWithValues } from "@openmeteo/sdk/variable-with-values.js";
import type { WeatherApiResponse } from "@openmeteo/sdk/weather-api-response.js";
import { log } from "./log.js";
import { aggregateWeathercode } from "./weathercode.js";

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
  "wind_gusts_10m",
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
// Pressure-level wind at every WIND_LEVELS_HPA level, whichever the request selected — one
// upstream call serves any selection, and the derive scripts read all eight.
const WIND_ALOFT_SPEED_VARS = WIND_LEVELS_HPA.map((l) => `wind_speed_${l}hPa`);
const WIND_ALOFT_DIR_VARS = WIND_LEVELS_HPA.map((l) => `wind_direction_${l}hPa`);
// The cloud band's levels ride the pressure-level request (for Europe that's the 0.25° IFS,
// which lacks 600/400 — those come back null and repairCloudBand interpolates them in).
//
// What the band READS and what we FETCH are deliberately not the same list. Open-Meteo's
// `cloud_cover_XhPa` is not a model field: it is Open-Meteo's own Sundqvist et al. (1989)
// diagnostic over `relative_humidity_XhPa` (see sundqvistCover below), reproduced from the
// humidity to within 0.001 percentage points over 50,400 corpus hours × 8 levels. So we fetch
// the humidity instead of the diagnostic — no information lost, and fillCloudBand can repair the
// diagnostic's blind spot before aggregation. `geopotential_height_XhPa` is the one genuinely new
// request cost (+8 variables): it places each level in a low/mid/high band per hour rather than
// by a hardcoded standard atmosphere, which matters because 700 hPa straddles the 3 km line.
const CLOUD_BAND_VARS = CLOUD_BAND_LEVELS_HPA.map((l) => `cloud_cover_${l}hPa`);
const CLOUD_BAND_RH_VARS = CLOUD_BAND_LEVELS_HPA.map((l) => `relative_humidity_${l}hPa`);
const CLOUD_BAND_HEIGHT_VARS = CLOUD_BAND_LEVELS_HPA.map((l) => `geopotential_height_${l}hPa`);
export const CLOUD_BAND_FETCH_VARS = [...CLOUD_BAND_RH_VARS, ...CLOUD_BAND_HEIGHT_VARS];

// Matches a `v:` value written as bare group codes rather than variable names. Built from the
// group table so it stays in step with it; the codes are all regex-safe single characters.
const COMPACT_VAR_CODES = new RegExp(`^[${VAR_GROUP_CODES}]+$`);

// Long-form `v:` values: the canonical variable names.
const VAR_NAMES = new Set<string>(VARIABLES);

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
  wind_gusts_10m: (number | null)[];
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
  wind_gusts_10m: number | null;
  precip: number | null;
  weathercode: number | null;
  freezing_level_m: number | null;
  snow_cm: number;
  rain_mm: number;
  // Pressure-level wind per WIND_LEVELS_HPA entry (300 hPa first): window max speed and the
  // speed-weighted dominant direction in degrees.
  wind_aloft_kph: (number | null)[];
  wind_aloft_deg: (number | null)[];
  cloud_cover: number | null;
  cloud_cover_high: number | null;
  cloud_cover_mid: number | null;
  cloud_cover_low: number | null;
  // Coverage per CLOUD_BAND_LEVELS_HPA entry (300 hPa first), aggregated from the post-fill
  // hourly stack (fillCloudBand). Null where the source served nothing for that level in the
  // window; toFullPeriod interpolates the holes.
  cloud_band: (number | null)[];
  // Air quality (CAMS, fetched from a different Open-Meteo API — see fetchAirQuality). Null both
  // where the request didn't ask for air quality and past the CAMS horizon.
  us_aqi: number | null;
  us_aqi_pm2_5: number | null;
  us_aqi_ozone: number | null;
  us_aqi_pm10: number | null;
  us_aqi_nitrogen_dioxide: number | null;
  us_aqi_sulphur_dioxide: number | null;
  // Not a wire column, but the US headline's max is taken over it, so the dominant-pollutant
  // column has to be able to name it. Fetched whenever the US headline is requested.
  us_aqi_carbon_monoxide: number | null;
  european_aqi: number | null;
  european_aqi_pm2_5: number | null;
  european_aqi_pm10: number | null;
  european_aqi_ozone: number | null;
  european_aqi_nitrogen_dioxide: number | null;
  european_aqi_sulphur_dioxide: number | null;
}

// The air-quality variables, in the order their columns encode — every constituent of both
// indices first, then the two headlines, which code as residuals against constituents that must
// therefore already be decoded. Named once here because three paths have to agree on them: the
// upstream request, the row aggregation, and the corpus derive.
// Every air-quality column: its variable, the Open-Meteo/CAMS variable it comes from (which
// is also the Row field), and the Period field it decodes into. One table so the upstream request,
// the row aggregation and the period fill cannot drift apart — a mismatch here is silent, and
// costs an all-null column rather than an error (the `pm2p5` rewrite below is the same hazard).
export const AQ_COLUMN_VARS: [variable: Variable, cams: string, period: keyof Period][] = [
  [VAR.aq_pm25, "us_aqi_pm2_5", "aqi_pm25"],
  [VAR.aq_o3, "us_aqi_ozone", "aqi_o3"],
  [VAR.aq_pm10, "us_aqi_pm10", "aqi_pm10"],
  [VAR.aq_no2, "us_aqi_nitrogen_dioxide", "aqi_no2"],
  [VAR.aq_so2, "us_aqi_sulphur_dioxide", "aqi_so2"],
  [VAR.aqi_eu_pm25, "european_aqi_pm2_5", "aqi_eu_pm25"],
  [VAR.aqi_eu_o3, "european_aqi_ozone", "aqi_eu_o3"],
  [VAR.aqi_eu_pm10, "european_aqi_pm10", "aqi_eu_pm10"],
  [VAR.aqi_eu_no2, "european_aqi_nitrogen_dioxide", "aqi_eu_no2"],
  [VAR.aqi_eu_so2, "european_aqi_sulphur_dioxide", "aqi_eu_so2"],
  [VAR.aqi, "us_aqi", "aqi"],
  [VAR.aqi_eu, "european_aqi", "aqi_eu"],
];

// Each headline: the variable that selects it, the Period field naming its dominant constituent,
// and that scale's constituents IN WIRE ORDER (AQ_DOMINANT_US/_EU). The order is wire format —
// the column transmits a position in this list. Selecting a headline fetches all of them,
// including US carbon monoxide, which has no column of its own: the index maxes over it, so a
// truthful answer to "which pollutant is this" has to be able to say so.
export const AQ_DOMINANT_SOURCES: [variable: Variable, field: keyof Period, cams: string[]][] = [
  [VAR.aqi, "aqi_dominant", [
    "us_aqi_pm2_5", "us_aqi_ozone", "us_aqi_pm10",
    "us_aqi_nitrogen_dioxide", "us_aqi_sulphur_dioxide", "us_aqi_carbon_monoxide",
  ]],
  [VAR.aqi_eu, "aqi_eu_dominant", [
    "european_aqi_pm2_5", "european_aqi_ozone", "european_aqi_pm10",
    "european_aqi_nitrogen_dioxide", "european_aqi_sulphur_dioxide",
  ]],
];

// Every air-quality series the server may fetch: the columns, plus any constituent that only
// the dominant-pollutant argmax needs (US carbon monoxide). Constituents first, headlines
// last, matching the order the columns encode in.
export const AIR_QUALITY_VARS: string[] = (() => {
  const names = AQ_COLUMN_VARS.map(([, cams]) => cams);
  const extra = AQ_DOMINANT_SOURCES.flatMap(([, , cams]) => cams)
    .filter((v) => !names.includes(v));
  // Headlines encode last, so keep them at the tail when splicing the extras in.
  const heads = names.slice(-2);
  return [...names.slice(0, -2), ...extra, ...heads];
})();

// Map an SDK variable — identified by (enum, altitude, pressureLevel) — back to the Open-Meteo
// request name the rest of the pipeline keys on (`temperature_2m`, `wind_speed_500hPa`). Mirrors
// the corpus collector's canonicalName (scripts/om-fetch.ts) so both fetch paths agree on names.
// The `pm2p5` → `pm2_5` rewrite is load-bearing for the air-quality columns: the FlatBuffers
// Variable enum spells the PM2.5 fraction `pm2p5` (a valid identifier) while the API's request
// names — the keys decodeResponse looks up by — spell it `pm2_5`. Without it `us_aqi_pm2_5` and
// `european_aqi_pm2_5` miss the by-name lookup and come back as all-null columns, which would
// encode as "no data" for every period rather than as an error. (The enum's
// `pm2_5_total_organic_matter` already uses the API spelling; the `pm2p5` token can't match
// inside it.) Mirrors the corpus collector's canonicalName in scripts/om-fetch.ts.
function canonicalName(v: VariableWithValues): string {
  const base = OmVariable[v.variable()].replace("pm2p5", "pm2_5");
  if (v.pressureLevel() !== 0) return `${base}_${v.pressureLevel()}hPa`;
  if (v.altitude() !== 0) return `${base}_${v.altitude()}m`;
  return base;
}

// Decode a FlatBuffers response into the same column-per-variable HourlyData the JSON API used to
// yield. The wire carries a UTC unix grid (start/end/interval) rather than ISO strings, so we
// reconstruct the naive local-time labels ("YYYY-MM-DDTHH:MM") the aggregator's date/hour slicing
// expects — production requests timezone=UTC (offset 0); the response's utcOffset covers any other
// tz a caller passes. Every requested var gets a column: one the model lacks comes back all-null
// (matching the old JSON path, where downstream reads coalesce missing fields to null).
function decodeResponse(
  resp: WeatherApiResponse,
  hourlyVars: string[],
): { hourly: HourlyData; elevation: number } {
  const h = resp.hourly();
  if (!h) throw new Error("Open-Meteo response has no hourly block");
  const start = Number(h.time());
  const end = Number(h.timeEnd());
  const interval = h.interval();
  const utcOffset = resp.utcOffsetSeconds();
  const time: string[] = [];
  for (let t = start; t < end; t += interval) {
    time.push(new Date((t + utcOffset) * 1000).toISOString().slice(0, 16));
  }

  // Key by canonical name rather than trusting index order, so a variable the model drops or
  // reorders can never silently misalign its neighbours.
  const byName = new Map<string, VariableWithValues>();
  for (let i = 0; i < h.variablesLength(); i++) {
    const v = h.variables(i);
    if (v) byName.set(canonicalName(v), v);
  }
  // Float32 values carry representation noise (0.2800000011920929); round to 2 dp — well beyond
  // wire quantization — so the live path feeds the encoder the same precision the corpus/benchmark
  // path does (scripts/om-fetch.ts uses the identical round2), keeping tuning and runtime aligned.
  const round2 = (x: number) => Math.round(x * 100) / 100;
  const hourly: Record<string, (number | null)[] | string[]> = { time };
  for (const name of hourlyVars) {
    const raw = byName.get(name)?.valuesArray();
    hourly[name] = raw
      ? Array.from(raw, (x) => (x == null || Number.isNaN(x) ? null : round2(x)))
      : time.map(() => null);
  }
  return { hourly: hourly as unknown as HourlyData, elevation: resp.elevation() };
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
  const params: Record<string, unknown> = {
    latitude: lat,
    longitude: lon,
    hourly: hourlyVars,
    timezone: tz,
    forecast_days: nDays,
    models: source,
  };
  if (elev_m !== undefined) params.elevation = elev_m;
  if (pastDays > 0) params.past_days = pastDays;
  // Overridable so golden-corpus tests and verify-container can replay recorded responses
  // from a local fixture server instead of hitting the live API.
  const base = process.env["OPEN_METEO_BASE_URL"] ?? "https://api.open-meteo.com";
  const url = `${base}/v1/forecast`;
  log.info("openmeteo.request", { url, ...params });
  const results = await fetchWeatherApi(url, params);
  const resp = results[0];
  if (!resp) throw new Error("Open-Meteo returned no result");
  return decodeResponse(resp, hourlyVars);
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

// ── Elevation correction for precipitation type (README "Elevation Correction") ──────────────
//
// Open-Meteo's elevation downscaling lapse-corrects temperature only; weathercode and the
// rain/showers/snowfall split pass through from the model's grid-cell surface (2818 m for GFS
// at Denali). A summit request can therefore pair -20 °C with a drizzle code and liquid rain
// decided ~3 km below the site. Fix: remap liquid → snow for hours where the site sits above
// the model's freezing level, or where the (downscaled) temperature is at or below -2 °C — the
// temperature catch covers cold-air inversions and the centers with no freezing-level product
// (GEM, ECMWF). One-directional by design: snow is never remapped to rain (snow survives well
// below the freezing level), and freezing drizzle/rain (56/57/66/67) is the model explicitly
// asserting supercooled liquid, so those hours are left alone entirely.
//
// Applied per-hour BEFORE aggregation (fetchHourly here; derive-lib/benchmark for the corpus),
// so a window straddling a frontal passage aggregates mixed rather than winner-take-all — and
// codebook derivation sees exactly the distributions production encodes.
const PHASE_TEMP_MAX_C = -2;
// Open-Meteo's own snow:liquid convention (1 mm water equivalent = 0.7 cm snow, 7:1 by depth),
// so converted snow is consistent with natively-reported snowfall in the same series.
const SNOW_CM_PER_MM = 0.7;
const WC_LIQUID_TO_SNOW: Record<number, number> = {
  51: 71, 53: 73, 55: 75, // drizzle       → snow
  61: 71, 63: 73, 65: 75, // rain          → snow
  80: 85, 81: 85, 82: 86, // rain showers  → snow showers
};
const WC_SUPERCOOLED = new Set([56, 57, 66, 67]);

// Pure: returns a new HourlyData sharing every untouched column. `siteElevM` is the elevation
// the temperature was downscaled to (the API response's `elevation` field; location_meta's
// model_elevation for corpus cells) — null skips the freezing-level test, leaving the
// temperature catch. A freezing level of 0 is Open-Meteo's "whole column below freezing"
// sentinel, a real value the >= comparison handles — only null/missing disables the test.
export function adjustPrecipPhase(h: HourlyData, siteElevM: number | null): HourlyData {
  const temp = h.temperature_2m;
  const fz = h.freezing_level_height as (number | null)[] | undefined;
  const wc = h.weather_code as (number | null)[] | undefined;
  const rain = h.rain as (number | null)[] | undefined;
  const showers = h.showers as (number | null)[] | undefined;
  const snow = h.snowfall as (number | null)[] | undefined;

  const n = h.time.length;
  const outRain = rain && [...rain];
  const outShowers = showers && [...showers];
  const outWc = wc && [...wc];
  // Snowfall may be absent from an offline cell even when rain is present; materialize it as
  // soon as liquid needs somewhere to go so the amount isn't dropped.
  let outSnow = snow && [...snow];

  for (let i = 0; i < n; i++) {
    const t = temp?.[i] ?? null;
    const f = fz?.[i] ?? null;
    const snowy =
      (siteElevM != null && f != null && siteElevM >= f) ||
      (t != null && t <= PHASE_TEMP_MAX_C);
    if (!snowy) continue;
    const code = outWc?.[i] ?? null;
    if (code != null && WC_SUPERCOOLED.has(code)) continue;
    const liquid = (outRain?.[i] ?? 0) + (outShowers?.[i] ?? 0);
    if (liquid > 0) {
      outSnow ??= new Array<number | null>(n).fill(null);
      outSnow[i] = (outSnow[i] ?? 0) + liquid * SNOW_CM_PER_MM;
      if (outRain) outRain[i] = 0;
      if (outShowers) outShowers[i] = 0;
    }
    const mapped = code != null ? WC_LIQUID_TO_SNOW[code] : undefined;
    if (mapped !== undefined && outWc) outWc[i] = mapped;
  }

  const out = { ...h };
  if (outRain) out.rain = outRain;
  if (outShowers) out.showers = outShowers;
  if (outSnow) out.snowfall = outSnow;
  if (outWc) out.weather_code = outWc;
  return out as HourlyData;
}

// ── Cloud band: rebuild from humidity, and fill what the humidity can't see ───────────────────
//
// The band's eight `cloud_cover_XhPa` levels are not model cloud. They are Open-Meteo's own
// Sundqvist diagnostic over gridbox-mean relative humidity, and it has a hard floor: below the
// level's critical humidity it returns exactly 0. Stack the encoder's own 3-bit deadband on top
// and near the surface you need 90.5% RH before a single pixel lights. Measured over the corpus
// eval split, 17.5% of all hours — 24.5% of hours whose weathercode says cloudy — quantize to an
// all-zero band; 73% of those have every level at exactly 0.0%, so it is the diagnostic's floor,
// not rounding.
//
// The trio (`cloud_cover_low/mid/high`) does not have this problem: it is native model output
// (GRIB2 LCDC/MCDC/HCDC), computed by the model's own cloud scheme on its own vertical grid, and
// it disagrees with the isobaric stack on 0.75% of cloudy hours rather than 24.5%. Nor can the
// diagnostic be recalibrated into agreement — the ceiling for ANY function of the in-band RH
// profile is R² 0.459/0.403/0.358 for low/mid/high, because the model's scheme uses subgrid
// humidity variance and convective detrainment a mean RH profile does not contain.
//
// So: do not try to predict the trio. We already have it exactly. Take MAGNITUDE from the trio
// and use humidity only for vertical PLACEMENT. See docs/private/Cloud Band Correction.md for
// the measurements behind every constant here.

// Open-Meteo's critical relative humidity, ported from `relativeHumidityThreshold` in
// open-meteo/Sources/App/Helper/Meteorology.swift. Falls from 0.890 at 1000 hPa to 0.700 aloft:
// the same humidity means more cloud higher up.
export function rhCritical(pressureHPa: number): number {
  const a1 = 0.7, a2 = 0.9, a3 = 4.0;
  return a1 + (a2 - a1) * Math.exp(1 - Math.pow(1013.25 / pressureHPa, a3));
}

// Sundqvist et al. (1989) cloud fraction, ported from `cloudCover` in the same file. The outer
// max(…, 0) is the floor described above — it is what makes the fill necessary, so it is
// reproduced faithfully rather than softened.
export function sundqvistCover(rhPct: number, rhCrit: number): number {
  return Math.max(1 - Math.sqrt(Math.max(1 - rhPct / 100, 0) / (1 - rhCrit)), 0) * 100;
}

// The documented low/mid/high boundaries (ASL), the same ones the trio is defined on. An
// empirical refit was tried and came back degenerate — extending the sweep collapsed "mid" to a
// 500 m sliver, compensating for the near-always-zero 300 hPa diagnostic rather than locating a
// boundary — while the un-confounded low band scores best at exactly 3000 m.
const CLOUD_BAND_LOW_TOP_M = 3000;
const CLOUD_BAND_MID_TOP_M = 8000;
// Placement window: light every in-band level whose humidity-above-critical is within this many
// percentage points of the band's best. Deliberately untuned — within-band vertical placement has
// no independent ground truth (the isobaric values are a function of the same humidity used to
// place them), and 5 pt vs 15 pt moved neither recovery nor false cloud.
const CLOUD_BAND_SCORE_WINDOW_PP = 5;
// Trio field per band index, low → high. Index doubles as the band id used below.
const CLOUD_BAND_TRIO = ["cloud_cover_low", "cloud_cover_mid", "cloud_cover_high"] as const;

/**
 * Recompute the eight cloud-band levels from pressure-level humidity, then fill any low/mid band
 * the humidity diagnostic reports as empty while the model's own layer cloud says otherwise, and
 * fold the model's high-cloud integral into the top slot.
 *
 * Runs per hour, BEFORE the maxOf period aggregation and therefore before repairCloudBand:
 * per-hour is the only granularity at which humidity and geopotential exist without inventing
 * period aggregates for them, and interpolation should bridge holes in filled data, not raw. The
 * output keeps the `cloud_cover_XhPa` column names, so everything downstream is unchanged.
 */
export function fillCloudBand(h: HourlyData): HourlyData {
  const levels = CLOUD_BAND_LEVELS_HPA;
  const rh = CLOUD_BAND_RH_VARS.map((v) => h[v] as (number | null)[] | undefined);
  // No humidity anywhere in the stack: nothing to recompute or place with. Leave the band exactly
  // as it arrived, so an offline cell carrying only `cloud_cover_XhPa` still encodes what it has.
  if (rh.every((c) => c == null)) return h;

  const n = h.time.length;
  const rhCrit = levels.map(rhCritical);
  const height = CLOUD_BAND_HEIGHT_VARS.map((v) => h[v] as (number | null)[] | undefined);
  const prior = CLOUD_BAND_VARS.map((v) => h[v] as (number | null)[] | undefined);
  const trio = CLOUD_BAND_TRIO.map((v) => h[v] as (number | null)[] | undefined);
  const out = levels.map(() => new Array<number | null>(n).fill(null));

  for (let i = 0; i < n; i++) {
    // Per-level cover, and which band each level falls in this hour. Nulls are structural, not
    // incidental: ECMWF's pressure product has no 600/400, and cover, humidity and height all ride
    // the same request, so they go null together. A level with no height belongs to no band — it
    // is never lit, never scored, and never blocks a fill; repairCloudBand bridges it afterwards.
    const cover: (number | null)[] = [];
    const band: (number | null)[] = [];
    for (let li = 0; li < levels.length; li++) {
      const r = rh[li]?.[i] ?? null;
      cover.push(r != null ? sundqvistCover(r, rhCrit[li]) : (prior[li]?.[i] ?? null));
      const z = height[li]?.[i] ?? null;
      band.push(z == null ? null
        : z < CLOUD_BAND_LOW_TOP_M ? 0 : z <= CLOUD_BAND_MID_TOP_M ? 1 : 2);
    }

    for (let b = 0; b < CLOUD_BAND_TRIO.length; b++) {
      const members: number[] = [];
      for (let li = 0; li < levels.length; li++)
        if (band[li] === b && cover[li] != null) members.push(li);
      if (members.length === 0) continue; // whole band absent from this source — leave it to repair
      // Clamped because the normalization below takes a fractional power of (1 − C/100): an
      // out-of-range value from upstream would come back NaN rather than merely wrong.
      const raw = trio[b]?.[i] ?? null;
      if (raw == null) continue;
      const C = Math.min(100, Math.max(0, raw));

      if (b === 2) {
        // The fold. The top slot stops being a point diagnostic at 300 hPa and becomes the
        // model's own layer integral for everything at or above 8 km — unconditional, not a
        // repair, because up here the diagnostic is worse than a constant (R² −0.497 against the
        // model's high cloud, where predicting the mean scores 0.000). On the rare hour where a
        // second level also clears 8 km, both carry the integral: a slab, which is what the
        // renderer should be drawing for this band anyway.
        for (const li of members) cover[li] = C;
        continue;
      }

      // Low/mid: synthesize only where the diagnostic sees nothing AND the trio's own magnitude
      // can survive the encoder. The second half is a survival condition, not a semantic one —
      // the synthesized values go through quantCover like any other, so a fill that cannot clear
      // the deadband ships an empty band regardless and only adds noise below it.
      if (members.some((li) => quantCover(cover[li] as number) > 0)) continue;
      if (quantCover(C) === 0) continue;

      // Placement by humidity ABOVE the level's critical threshold, not raw humidity. rhCrit
      // falls with height, so raw RH is biased toward the surface — it puts roughly twice as much
      // cloud on the deck at 364 ft, which for a mountain app is the worst place to be wrong
      // (valley fog vs cloud at ridge height). It also still discriminates when every in-band
      // cover has been clipped to exactly 0.0%, which is 77% of real conflicts.
      const score = (li: number) => (rh[li]![i] as number) - rhCrit[li] * 100;
      const lit = members.filter((li) => rh[li]?.[i] != null).sort((x, y) => score(y) - score(x));
      if (lit.length === 0) continue;
      const best = score(lit[0]);
      let k = lit.filter((li) => score(li) >= best - CLOUD_BAND_SCORE_WINDOW_PP).length;

      // Magnitude: split the layer value across the lit levels so their random-overlap
      // combination reproduces it — random overlap beat max as a levels→layer aggregator. The
      // split LOWERS each level (10% over four levels is 2.6% each, all of which re-quantize to
      // 0), so shed the weakest lit level until what remains survives. This terminates: at k = 1
      // the level value is the band value, which the gate above guarantees clears the deadband.
      const spread = (m: number) => (m === 1 ? C : (1 - Math.pow(1 - C / 100, 1 / m)) * 100);
      let v = spread(k);
      while (k > 1 && quantCover(v) === 0) v = spread(--k);
      for (let j = 0; j < k; j++) cover[lit[j]] = v;
    }

    for (let li = 0; li < levels.length; li++) out[li][i] = cover[li];
  }

  const filled = { ...h } as Record<string, unknown>;
  CLOUD_BAND_VARS.forEach((v, li) => { filled[v] = out[li]; });
  return filled as HourlyData;
}

// The air-quality variables a request needs, given its selection — empty when it asked for
// none, which is the common case and skips the upstream call entirely.
export function airQualityVarsFor(vars: ReadonlySet<Variable>): string[] {
  const want = new Set(
    AQ_COLUMN_VARS.filter(([variable]) => vars.has(variable)).map(([, name]) => name));
  // A headline needs every constituent of its scale, not just the ones with columns — the
  // dominant-pollutant column is an argmax over all of them.
  for (const [variable, , cams] of AQ_DOMINANT_SOURCES)
    if (vars.has(variable)) for (const v of cams) want.add(v);
  // Emitted in AIR_QUALITY_VARS order so the upstream request is stable across selections.
  return AIR_QUALITY_VARS.filter((v) => want.has(v));
}

// Air quality comes from a DIFFERENT Open-Meteo API (its own host and path), so it can't ride the
// weather request. `domains=auto` is pinned, not a default: it resolves to CAMS European (0.1°,
// hourly) inside Europe and CAMS global (0.4°, 3-hourly) elsewhere, and that is the exact mixture
// the codebooks were trained on. The two domains disagree sharply — Zurich reads 6.3 µg/m³ PM2.5
// on europe against 37.6 on global — so changing this silently re-means every AQ symbol.
// No `elevation`: terrain downscaling is a forecast-API knob and the AQ API rejects it.
// 5 forecast days is what CAMS runs; the wire clamps to 4 anyway (AQ_HORIZON_HOURS in wire.ts).
const AIR_QUALITY_FORECAST_DAYS = 5;
async function fetchAirQuality(
  hourlyVars: string[], lat: number, lon: number, tz: string, pastDays: number,
): Promise<HourlyData | null> {
  const params: Record<string, unknown> = {
    latitude: lat,
    longitude: lon,
    hourly: hourlyVars,
    timezone: tz,
    forecast_days: AIR_QUALITY_FORECAST_DAYS,
    domains: "auto",
  };
  if (pastDays > 0) params.past_days = pastDays;
  const base = process.env["AIR_QUALITY_BASE_URL"] ?? "https://air-quality-api.open-meteo.com";
  const url = `${base}/v1/air-quality`;
  log.info("openmeteo.airquality.request", { url, ...params });
  try {
    const results = await fetchWeatherApi(url, params);
    const resp = results[0];
    if (!resp) throw new Error("Open-Meteo air quality returned no result");
    return decodeResponse(resp, hourlyVars).hourly;
  } catch (err) {
    // Soft failure: air quality is an extra column, not the forecast. The weather still goes out;
    // the AQ columns encode their no-data symbol, which the app draws as an empty cell. Logged at
    // ERROR even so — the reader asked for air quality and didn't get it, which is worth seeing in
    // Error Reporting rather than burying at INFO because the request itself survived.
    log.error("openmeteo.airquality.failed", { err });
    return null;
  }
}

async function fetchHourly(
  modelKey: string,
  nDays: number,
  lat: number,
  lon: number,
  tz: string,
  elev_m?: number,
  pastDays = 0,
  airQualityVars: string[] = [],
): Promise<[HourlyData, string[], number]> {
  const center = CENTERS[modelKey];
  const pressureVars = [
    ...WIND_ALOFT_SPEED_VARS, ...WIND_ALOFT_DIR_VARS,
    ...CLOUD_BAND_FETCH_VARS,
  ];
  // Drop freezing_level_height from the request for centers that don't provide it (GEM, ECMWF);
  // toFullPeriod also drops freeze from the vars set so it never reaches the wire.
  const surfaceVars = center.freeze
    ? SURFACE_VARS
    : SURFACE_VARS.filter((v) => v !== "freezing_level_height");

  // Air quality is a separate API, so it goes out alongside the weather rather than with it, and
  // only when the request asked for it. Its horizon is shorter than the weather's, so the merge
  // below leaves the tail hours null — which is exactly what the wire's 4-day clamp expects.
  const aqPromise = airQualityVars.length
    ? fetchAirQuality(airQualityVars, lat, lon, tz, pastDays)
    : Promise.resolve(null);
  const withAirQuality = (h: HourlyData, aq: HourlyData | null): HourlyData =>
    aq ? mergeHourly(h, aq, airQualityVars) : h;

  if (center.surface === center.pressure) {
    const [{ hourly, elevation }, aq] = await Promise.all([
      fetchOpenMeteo(center.surface, [...surfaceVars, ...pressureVars], nDays, lat, lon, tz, elev_m, pastDays),
      aqPromise,
    ]);
    const adjusted = fillCloudBand(adjustPrecipPhase(withAirQuality(hourly, aq), elevation));
    return [adjusted, adjusted.time, elevation];
  }

  // Split sources (Europe): surface fields from the 9 km HRES, pressure levels from IFS 0.25°.
  // Elevation comes from the surface source (its finer grid is the better terrain match).
  const [surf, pres, aq] = await Promise.all([
    fetchOpenMeteo(center.surface, surfaceVars, nDays, lat, lon, tz, elev_m, pastDays),
    fetchOpenMeteo(center.pressure, pressureVars, nDays, lat, lon, tz, elev_m, pastDays),
    aqPromise,
  ]);
  const merged = withAirQuality(mergeHourly(surf.hourly, pres.hourly, pressureVars), aq);
  const adjusted = fillCloudBand(adjustPrecipPhase(merged, surf.elevation));
  return [adjusted, adjusted.time, surf.elevation];
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
// Shared by the uniform-resolution keying above and the layout-driven windows below.
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
    const aloftSpd = WIND_ALOFT_SPEED_VARS.map(pickUnk);
    const aloftDir = WIND_ALOFT_DIR_VARS.map(pickUnk);

    // The accumulations feed the weathercode below — the summary's intensity comes from how much
    // actually fell, so the code agrees with the numbers shipped beside it instead of reporting
    // the peak hour's own code (which could say "heavy snow" over a period totalling 0.7 cm).
    const snowCm = sumOf(pick(h.snowfall));
    // Liquid precipitation: open-meteo splits convective showers from stratiform rain.
    // Some models omit one series (returns null), so sum both treating null as 0.
    const rainMm = sumOf(pickUnk("rain")) + sumOf(pickUnk("showers"));
    const hourlyCodes = pick(h.weather_code).filter((c): c is number => c != null);

    return {
      time: times[idx[0]],
      temp_c: repTemps[w],
      wind_speed_10m: maxOf(sfcSpd),
      wind_direction_10m: dominantDirDeg(sfcSpd, sfcDir),
      wind_gusts_10m: maxOf(pick(h.wind_gusts_10m)),
      precip: maxOf(pick(h.precipitation_probability)),
      // Not maxOf: form comes from how much of the window was wet, intensity from accumulation.
      // See aggregateWeathercode in weathercode.ts. A window with no codes at all aggregates to
      // null, as it did under maxOf, so toFullPeriod's own no-data substitution still applies.
      weathercode: hourlyCodes.length > 0 ? aggregateWeathercode(hourlyCodes, snowCm, rainMm) : null,
      freezing_level_m: maxOf(pickUnk("freezing_level_height")),
      snow_cm: snowCm,
      rain_mm: rainMm,
      // Same worst-hour semantics as the surface wind, per pressure level.
      wind_aloft_kph: aloftSpd.map(maxOf),
      wind_aloft_deg: aloftSpd.map((spd, li) => dominantDirDeg(spd, aloftDir[li])),
      cloud_cover: maxOf(pick(h.cloud_cover)),
      cloud_cover_high: maxOf(pick(h.cloud_cover_high)),
      cloud_cover_mid: maxOf(pick(h.cloud_cover_mid)),
      cloud_cover_low: maxOf(pick(h.cloud_cover_low)),
      // Same worst-hour semantics as the three bands above, per pressure level.
      cloud_band: CLOUD_BAND_VARS.map((v) => maxOf(pickUnk(v))),
      // Worst air in the window, the same semantics gusts get: a period that contains an hour of
      // unhealthy smoke is an unhealthy period, however clean its other hours were.
      ...Object.fromEntries(AIR_QUALITY_VARS.map((cams) => [cams, maxOf(pickUnk(cams))])),
    } as Row;
  });
  return rows;
}

// The wire always carries the full CLOUD_BAND_LEVELS_HPA stack, so holes a center leaves
// (ECMWF's 600/400, ragged model horizons) are bridged here by linear interpolation in pressure
// between the nearest served levels, clamped at the ends. A window with no level data at all
// encodes as clear — the same ?? 0 coalescing every non-AQ variable gets.
//
// One accepted semantic mush, post-fold: interpolating a null 400 puts it between the 300 slot,
// which now carries the model's layer integral for everything above 8 km (fillCloudBand), and
// 500, which is still a point diagnostic. Deliberate — the alternative is a hole.
export function repairCloudBand(vals: (number | null)[]): number[] {
  // Always the full stack, whatever the caller had — a short or empty array pads with nulls.
  const out: (number | null)[] = CLOUD_BAND_LEVELS_HPA.map((_, i) => vals[i] ?? null);
  for (let i = 0; i < out.length; i++) {
    if (out[i] != null) continue;
    let lo = i - 1; while (lo >= 0 && out[lo] == null) lo--;
    let hi = i + 1; while (hi < out.length && out[hi] == null) hi++;
    const above = lo >= 0 ? out[lo] as number : null;
    const below = hi < out.length ? out[hi] as number : null;
    if (above != null && below != null) {
      const t = (CLOUD_BAND_LEVELS_HPA[i] - CLOUD_BAND_LEVELS_HPA[lo])
        / (CLOUD_BAND_LEVELS_HPA[hi] - CLOUD_BAND_LEVELS_HPA[lo]);
      out[i] = above * (1 - t) + below * t;
    } else out[i] = above ?? below ?? 0;
  }
  return (out as number[]).map((v) => Math.round(v));
}

export function toFullPeriod(r: Row, vars: ReadonlySet<Variable>, modelKey: string): Period {
  // Centers without a freezing-level product never carry that variable on the wire.
  if (!CENTERS[modelKey].freeze && vars.has(VAR.freeze)) {
    const copy = new Set(vars);
    copy.delete(VAR.freeze);
    vars = copy;
  }
  const p: Period = { weathercode: r.weathercode ?? 0 };
  if (vars.has(VAR.precip)) p.precip     = r.precip ?? 0;
  if (vars.has(VAR.temp))   p.temp_c     = r.temp_c ?? 0;
  if (vars.has(VAR.snow))   p.snow_cm    = r.snow_cm ?? 0;
  if (vars.has(VAR.rain))   p.rain_mm    = r.rain_mm ?? 0;
  if (vars.has(VAR.freeze)) p.freeze_m   = r.freezing_level_m ?? 0;
  if (vars.has(VAR.wind)) {
    p.wind_sfc_kph = r.wind_speed_10m ?? 0;
    p.wind_sfc_dir = degToDirIdx(r.wind_direction_10m);
  }
  if (vars.has(VAR.gust)) p.wind_gust_kph = r.wind_gusts_10m ?? 0;
  if (WIND_LEVEL_VARS.some((v) => vars.has(v))) {
    p.wind_aloft = WIND_LEVEL_VARS.map((v, li) => vars.has(v)
      ? { kph: r.wind_aloft_kph?.[li] ?? 0, dir: degToDirIdx(r.wind_aloft_deg?.[li]) }
      : null);
  }
  // The wire reads cloud_band; the low/mid/high fields stay filled because the derive
  // scripts (and any v2-era tooling) read Periods through this same function.
  if (vars.has(VAR.clouds)) {
    p.cloud_high = Math.round(r.cloud_cover_high ?? 0);
    p.cloud_mid  = Math.round(r.cloud_cover_mid  ?? 0);
    p.cloud_low  = Math.round(r.cloud_cover_low  ?? 0);
    p.cloud_band = repairCloudBand(r.cloud_band ?? []);
  }
  // Air quality, left UNDEFINED rather than coalesced to 0 where the value is missing: 0 is the
  // cleanest air on either scale, so claiming it for an hour CAMS never forecast would be a lie.
  // The codec encodes an absent value as its no-data symbol (see the AQ columns in wire.ts).
  const aq = r as unknown as Record<string, number | null>;
  for (const [variable, cams, field] of AQ_COLUMN_VARS) {
    const v = aq[cams];
    if (vars.has(variable) && v != null) (p[field] as number) = v;
  }
  // Which constituent each selected headline is reporting: the argmax over RAW concentrations,
  // not the banded sub-indices. At ladder resolution two pollutants share the top band ~8% of the
  // time, and raw values essentially never tie, so picking here means the wire never has to carry
  // a tiebreak rule. Left absent if any constituent is missing — there is then no honest answer,
  // and the codec skips the symbol for periods whose headline has no reading.
  for (const [variable, field, cams] of AQ_DOMINANT_SOURCES) {
    if (!vars.has(variable)) continue;
    let best = -Infinity, bi = -1;
    for (let i = 0; i < cams.length; i++) {
      const v = aq[cams[i]];
      if (v == null) { bi = -1; break; }
      if (v > best) { best = v; bi = i; }
    }
    if (bi >= 0) (p[field] as number) = bi;
  }
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
  vars: ReadonlySet<Variable>;
  maxChars: number;
  // Character set for the response body, from the request's `d:` device token. Absent means
  // base-85, which is what every device but iPhone uses (see DEVICE_TRANSPORT).
  alphabet?: Alphabet;
  // The route itself (`d:`), for the routes whose reply is split into labelled messages —
  // see splitReplyFor. Absent when the request named none.
  device?: DeviceCode;
  // How many messages the reply may be spread over (`n:`, default 1). Only a route that splits
  // (iPhone, inReach, ZOLEO) sends more than one; SMS spends it as one longer concatenated
  // reply. See splitReplyFor.
  messages: number;
  // Protocol version from the request's `vN` token, or null when the token is absent. A version
  // is required — there is no default: each deployed codec server serves the version(s) baked
  // into its image, and defaulting would silently bind old hand-typed requests to whatever
  // happens to be current (see VERSIONING.md).
  decoderVersion: number | null;
  // 7-bit message code from a `k:` request word, echoed in the response (default 0).
  code: number;
  // Request time as UTC hours since the epoch (`t:`), aligned to the hour.
  startEpochHour: number;
  // Normalized account token from a `u:` request word, or null when absent/malformed.
  // Phase 1 only records it; it does not yet gate the response.
  userToken: string | null;
  // Validation problems found while parsing. Every request comes from the app, so a missing or
  // invalid component means the message is not a well-formed request; a non-empty list rejects
  // it (400) before any forecast work. The parsed values above still carry their defaults so
  // callers that ignore errors (tests, tooling) keep working.
  errors: string[];
}

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
  const vars = new Set<Variable>(ALWAYS_VARS);
  let device: DeviceCode | null = null; // from `d:`; null keeps the base-85 SMS defaults
  let messages = 1; // from `n:`: how many messages the reply may be spread over
  let decoderVersion: number | null = null; // set from a `vN` token; required, no default
  let userToken: string | null = null; // set from a `u:` token in the request
  const errors: string[] = []; // validation problems; non-empty rejects the request
  const seen = new Set<string>(); // request keys encountered, for the required-key check
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

  // Known keys are validated strictly: every request comes from the app, so an unrecognized
  // value is a malformed request, not a preference to default. Unknown BARE words stay ignored —
  // gateways append text around the request body (Garmin's "Lat X Lon Y" footer) — as do unknown
  // keys, which URLs in that appended text can produce ("https://...").
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
        } else {
          errors.push(`unknown location "${val}"`);
        }
      } else if (key === "p") {
        // Priority mode: p:d (Detail), p:a (Auto), p:r (Range).
        seen.add(key);
        if (val in MODE_TOKENS) mode = MODE_TOKENS[val];
        else errors.push(`invalid priority "p:${val}"`);
      } else if (key === "z") {
        // The location's UTC offset in whole hours.
        seen.add(key);
        const n = parseInt(val);
        if (!isNaN(n) && n >= -12 && n <= 14) utcOffsetHours = n;
        else errors.push(`invalid utc offset "z:${val}"`);
      } else if (key === "d") {
        // The sending device picks the response alphabet and, with `n:`, how much of it fits
        // (see DEVICE_TRANSPORT).
        seen.add(key);
        if (isDeviceCode(val)) device = val;
        else errors.push(`invalid device "d:${val}"`);
      } else if (key === "n") {
        // How many messages the reply may be spread over. Optional: omitted at one message.
        const n = parseInt(val);
        if (!isNaN(n) && n >= 1 && n <= MAX_MESSAGES) messages = n;
        else errors.push(`invalid message count "n:${val}"`);
      } else if (key === "m") {
        seen.add(key);
        let mask = 0;
        for (const m of val.split(",")) {
          if (m in MODEL_NAME_TO_BIT) mask |= 1 << MODEL_NAME_TO_BIT[m];
          else errors.push(`unknown model "${m}"`);
        }
        if (mask) modelsMask = mask;
      } else if (key === "w") {
        // Pressure-level wind: the WIND_LEVELS_HPA ladder indices to carry (`w:234` = 500/600/
        // 700 hPa). Optional: nothing is on without this token.
        if (val === "") errors.push('invalid wind levels "w:"');
        for (const ch of val) {
          const level = windLevelVar(ch);
          if (level) vars.add(level);
          else errors.push(`unknown wind level "${ch}"`);
        }
      } else if (key === "v") {
        // Compact group codes need no delimiter (`v:pcf`, `v:aso`). The character class comes
        // from the group table itself, so a group added there can't be silently unparseable here.
        // Comma-separated and long-form protocol variable names stay accepted for requests
        // produced by older clients.
        const requestedVars = COMPACT_VAR_CODES.test(val) ? [...val] : val.split(",");
        for (const v of requestedVars) {
          const group = CONFIGURABLE_VAR_GROUPS[
            v as keyof typeof CONFIGURABLE_VAR_GROUPS
          ];
          if (group) {
            for (const variable of group) vars.add(variable);
          } else if (VAR_NAMES.has(v)) {
            vars.add(v as Variable);
          } else {
            errors.push(`unknown variable "${v}"`);
          }
        }
      } else if (key === "u") {
        // The body was lowercased above; normalizeToken restores canonical casing.
        seen.add(key);
        if (isValidToken(val)) userToken = normalizeToken(val);
        else errors.push("invalid account token");
      } else if (key === "k") {
        seen.add(key);
        const n = parseInt(val);
        if (!isNaN(n) && n >= 0 && n <= 127) code = n; // 7-bit message code, 0..127
        else errors.push(`invalid message code "k:${val}"`);
      } else if (key === "t") {
        seen.add(key);
        const n = parseInt(val);
        if (!isNaN(n) && n >= 0) startEpochHour = n; // UTC forecast start, hours since epoch
        else errors.push(`invalid request time "t:${val}"`);
      }
    } else if (/^v\d+$/.test(word)) {
      decoderVersion = parseInt(word.slice(1));
    }
  }

  // Required components: everything the app always sends (HomeScreen's buildMsg). A location is
  // either coordinates or a named `l:`; the rest must each be present.
  for (const key of ["p", "z", "m", "d", "u", "k", "t"]) {
    if (!seen.has(key)) errors.push(`missing ${key}:`);
  }
  if (locationIdx === 0 && (lat === undefined || lon === undefined)) {
    errors.push("missing coordinates");
  }

  // Default the request time to "now", aligned down to the hour. A missing `t:` rejects the
  // request above; the default keeps callers that ignore errors on a usable window.
  if (isNaN(startEpochHour)) {
    startEpochHour = Math.floor(Date.now() / 3600000);
  }

  // Resolve the mode against the center before anything downstream sees it: Range collapses to
  // Auto for a center that can't fill the window (see effectiveMode). Requests carry the mode
  // that was asked for — clients don't apply this rule — so it belongs here, where params.mode
  // becomes the mode the message is encoded under, and again in the decoder, which redoes it
  // from the stored request to reach the same layout.
  mode = effectiveMode(mode, MODEL_BIT[firstModelKey(modelsMask)]);

  // The reply budget, resolved last because it depends on three tokens at once. It is DERIVED,
  // never stated: `d:` and `n:` name the route and how many messages it may spend, and the length
  // follows from the one table both ends read. A multi-message wide reply repeats the header in
  // every part, so its budget needs the header's width, a constant: this image serves a single
  // protocol version, and a request naming any other is rejected before the budget is ever spent.
  const alphabet = device ? DEVICE_TRANSPORT[device].alphabet : undefined;
  // A request that names no device is budgeted as SMS: one 160-character segment, the narrowest
  // route's limit and so the safe reading of an unidentified sender.
  const maxChars = maxCharsFor(device ?? "s", messages, WIRE_HEADER_CHARS);

  return { locationIdx, lat, lon, mode, utcOffsetHours, modelsMask, vars, maxChars, alphabet, device: device ?? undefined, messages, decoderVersion, userToken, code, startEpochHour, errors };
}

// What a request asked for, in names, for the gateway to record (see `X-Request-Shape` in
// index.ts). This is the only description of the message grammar that leaves a codec container,
// and it exists because the gateway must not learn the grammar: the variable and model
// vocabularies belong to one protocol version, so anything version-specific recorded today
// would be silently misread after the next version bump. Names survive that.
export interface RequestShape {
  lat?: number;
  lon?: number;
  loc: string;
  mode: string;
  models: string[];
  vars: string[];
  // Cap on the encoded reply, absent on routes without one (internet, d:d): "no cap" is the
  // absence of a number, and the UNCAPPED_MAX_CHARS sentinel would overflow the gateway's
  // integer column.
  maxChars?: number;
  messages: number;
  // The `d:` route code, absent when the request named none. Reported here rather than parsed
  // by the gateway: the codes are part of this version's grammar, and the gateway's frozen
  // sliver stays vN + u:.
  device?: string;
}

const IDX_TO_LOCATION_NAME: Record<number, string> = Object.fromEntries(
  Object.entries(LOCATION_NAME_TO_IDX).map(([name, idx]) => [idx, name]),
);
const BIT_TO_MODEL_NAME: Record<number, string> = Object.fromEntries(
  Object.entries(MODEL_NAME_TO_BIT).map(([name, bit]) => [bit, name]),
);
const MODE_NAMES: Record<number, string> = {
  [MODE_DETAIL]: "detail", [MODE_AUTO]: "auto", [MODE_RANGE]: "range",
};

// Coordinates are reported at 0.01° (~1 km), and rounded here rather than by the caller so a
// position precise enough to identify a campsite never leaves this stateless process — the
// gateway, which is the part with a database, is never told one.
const coarse = (v: number): number => Math.round(v * 100) / 100;

export function describeRequest(params: ForecastParams): RequestShape {
  const named = NAMED_LOCATIONS[params.locationIdx];
  const lat = params.locationIdx === 0 ? params.lat : named?.lat;
  const lon = params.locationIdx === 0 ? params.lon : named?.lon;
  return {
    ...(lat != null ? { lat: coarse(lat) } : {}),
    ...(lon != null ? { lon: coarse(lon) } : {}),
    loc: IDX_TO_LOCATION_NAME[params.locationIdx] ?? "current",
    mode: MODE_NAMES[params.mode] ?? "auto",
    models: Object.keys(BIT_TO_MODEL_NAME)
      .map(Number)
      .filter((bit) => params.modelsMask & (1 << bit))
      .map((bit) => BIT_TO_MODEL_NAME[bit]),
    vars: VARIABLES.filter((v) => params.vars.has(v)),
    ...(params.maxChars !== UNCAPPED_MAX_CHARS ? { maxChars: params.maxChars } : {}),
    messages: params.messages,
    ...(params.device ? { device: params.device } : {}),
  };
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
  // The /encode route resolves the codec (and therefore the version) before building anything,
  // so a null here means a caller skipped that validation.
  if (params.decoderVersion === null) throw new Error("decoderVersion is required to build a message");

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
    vars: params.vars,
    month: firstStart.getUTCMonth() + 1,
    day: firstStart.getUTCDate(),
    hour: firstStart.getUTCHours(),
    lat,
    lon,
    elevation,
    periods: [rows.map((r) => toFullPeriod(r, params.vars, modelKey))],
    seq: layout.seq,
    mode: params.mode,
    periodHours: layout.periodHours,
    utcOffsetHours: params.utcOffsetHours,
  };
}

// The reply as the messages it will be sent in. Only the routes that split (partBodyChars: iPhone,
// whose relay won't reassemble what it breaks, and inReach, whose device isn't trusted to) send
// labelled, self-identifying parts (see parts.ts). Everything else stays a single string, and its
// transport concatenates its own segments as it always has.
export function splitReplyFor(params: ForecastParams, encoded: string, headerChars: number): string[] {
  const partBody = params.device && partBodyChars(params.device, headerChars);
  if (!partBody) return [encoded];
  // Whole-reply test first, against the MESSAGE's cap rather than a part's: an unlabelled single
  // message fits more body than a labelled part (45 vs 43 on iPhone, 155 vs 151 on inReach), and
  // the single-message fill targets exactly that — split at the part size alone and every such
  // reply goes out as a full part plus a one-or-two-character tail (seen in the field
  // 2026-08-17). This is also what lets a multi-message request whose content ran short collapse
  // back to one plain message.
  if (encoded.length <= DEVICE_TRANSPORT[params.device!].maxChars) return [encoded];
  return splitReply(encoded, headerChars, partBody);
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
  return msg === null ? null : codec.encode(msg, params.alphabet);
}

// A served forecast, alongside what producing it cost: the winning layout's periods bucketed
// by resolution (hours-per-period → count, so the sum is the reply's total period count), and
// the wall time the two halves of the work took. These ride to the gateway on the shape header
// (index.ts) and answer what quality of forecast users actually see.
export interface ForecastResult {
  encoded: string;
  periods: Record<number, number>;
  fetchMs: number;
  encodeMs: number;
}

// Duration-first fill: one upstream fetch covers every candidate layout, then a binary search
// finds the largest fill-sequence number whose encoding fits the budget (encoded size grows
// along the sequence — see layout.ts). Always returns at least the seq=1 layout (one day at 12h),
// even if it exceeds the budget.
export async function fetchForecast(params: ForecastParams, codec: VersionedCodec): Promise<ForecastResult> {
  const { lat, lon, elev_m } = resolveLocation(params);
  const modelKey = firstModelKey(params.modelsMask);

  // The window runs from local midnight of the request day (≤ 24h in the past for any UTC
  // offset — hence past_days=1) through the rest of that day plus up to FILL_HORIZON_DAYS full
  // local days (FILL_SLOTS covers both); +2 forecast days cover the offset shift past the last
  // UTC day boundary. Models whose horizon ends earlier (GEM: 10 days) return nulls for the
  // tail hours, which buildLayoutMessage treats as unservable — the seq search clamps to them.
  const fetchStart = Date.now();
  const [h, times, elevation] = await fetchHourly(
    modelKey, FILL_SLOTS + 2, lat, lon, "UTC", elev_m, 1, airQualityVarsFor(params.vars),
  );
  const fetchMs = Date.now() - fetchStart;

  // The search carries each candidate's periodHours along with its encoding so the winner's
  // layout survives — the encoded string alone can't say what resolutions it holds.
  const encodeStart = Date.now();
  const best = fitFillToBudget(
    (seq) => {
      const msg = buildFillMessage(h, times, params, seq, lat, lon, elevation, modelKey);
      return msg === null
        ? null
        : { encoded: codec.encode(msg, params.alphabet), periodHours: msg.periodHours };
    },
    (c) => c.encoded.length,
    maxFillSeq(params.mode),
    params.maxChars,
  );
  const encodeMs = Date.now() - encodeStart;
  if (best === null) throw new Error("upstream data does not cover the requested window");

  const periods: Record<number, number> = {};
  for (const hours of best.periodHours) periods[hours] = (periods[hours] ?? 0) + 1;
  return { encoded: best.encoded, periods, fetchMs, encodeMs };
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
