import { writeFileSync, mkdirSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, join } from "path";
// Imports the built codec, so build the protocol first: `pnpm --filter @weather/protocol build`.
import { wireCodec, WIRE_VERSION, layoutFor, VARIABLES, type ForecastMessage } from "../dist/index.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

// Every variable, so the fixture exercises — and freezes — every column's encoding
// (precip, temp, snow, rain, freeze, surface wind + every pressure level, gust, the cloud band,
// and all twelve air-quality indices). With every sub-index present, BOTH headlines encode under
// their all-three residual mask, which is the mode a real request most wants frozen.
const vars = new Set(VARIABLES);

// Priority-mode fill: Detail mode requested at 13:00 local (UTC-9). seq 5 on the Detail path
// is |3h|12h|12h| — slot 0 at 3h (partial: four periods from 12:00), two whole days at 12h — a
// mixed layout, so the fixture freezes the path tables and layout arithmetic (which are wire
// format, see layout.ts) alongside the byte format. The 3h/12h split also freezes the cloud
// band's resolution clamp (band symbols on the four fine periods only), and the 14k-camp
// elevation freezes its level clamp (4267 m → six levels, 200..600 hPa); the seven requested
// wind levels are all carried, clamp-free — see cloudBandPeriodCount / pressureLevelCount in
// wire.ts. The request datetime, mode, and offset
// live in `request` so the test can rebuild the context the decoder needs (the year floats:
// it is not on the wire, and the layout only depends on the hour-of-day).
const request = { month: 6, day: 15, hour: 22, mode: 0 /* MODE_DETAIL */, utcOffsetHours: -9 };
const startMs = Date.UTC(new Date().getUTCFullYear(), request.month - 1, request.day, request.hour);
const seq = 5;
const layout = layoutFor(request.mode, startMs / 3600000, request.utcOffsetHours, seq);
const firstStart = new Date(layout.periodStartUtcHour[0] * 3600000);

const input: ForecastMessage = {
  version: WIRE_VERSION,
  code: 0,
  days: layout.days,
  models_mask: 0b0001, // Best Match only (bit 0)
  vars,
  month: firstStart.getUTCMonth() + 1,
  day: firstStart.getUTCDate(),
  hour: firstStart.getUTCHours(),
  lat: 63.063,
  lon: -151.081,
  elevation: 4267,
  seq,
  mode: request.mode,
  periodHours: layout.periodHours,
  utcOffsetHours: request.utcOffsetHours,
  // Air quality: each headline sits at or above every sub-index on its own scale — the
  // relationship its residual coding assumes. The US headline is led by PM2.5 in the smoky periods
  // and by ozone in the clean ones, and the European headline by ozone in most, so both sides of
  // each max get exercised. The European values are on their own scale; the same number would mean
  // a different category there.
  periods: [[
    { weathercode: 3,  precip: 57, temp_c: -8,  snow_cm: 0, rain_mm: 0,   freeze_m: 3048,   wind_sfc_kph: 16, wind_sfc_dir: 5, wind_gust_kph: 30, wind_aloft: [{ kph: 72, dir: 4 }, { kph: 60, dir: 4 }, { kph: 48, dir: 4 }, { kph: 40, dir: 3 }, { kph: 24, dir: 2 }, { kph: 16, dir: 2 }, { kph: 12, dir: 3 }], cloud_band: [70, 65, 60, 55, 40, 35, 30, 20, 15, 10], aqi: 118, aqi_pm25: 96,  aqi_o3: 42, aqi_eu: 55,  aqi_eu_pm25: 31, aqi_eu_o3: 50, aqi_eu_pm10: 24, aqi_eu_no2: 15, aqi_eu_so2: 7, aqi_pm10: 61, aqi_no2: 19, aqi_so2: 10, aqi_dominant: 0, aqi_eu_dominant: 1 },
    { weathercode: 61, precip: 86, temp_c: -4,  snow_cm: 5, rain_mm: 3.5, freeze_m: 2438.4, wind_sfc_kph: 24, wind_sfc_dir: 5, wind_gust_kph: 45, wind_aloft: [{ kph: 80, dir: 3 }, { kph: 68, dir: 3 }, { kph: 56, dir: 3 }, { kph: 48, dir: 3 }, { kph: 32, dir: 3 }, { kph: 24, dir: 3 }, { kph: 20, dir: 4 }], cloud_band: [95, 92, 90, 85, 75, 70, 65, 60, 55, 45], aqi: 165, aqi_pm25: 160, aqi_o3: 38, aqi_eu: 72,  aqi_eu_pm25: 44, aqi_eu_o3: 41, aqi_eu_pm10: 33, aqi_eu_no2: 18, aqi_eu_so2: 8, aqi_pm10: 74, aqi_no2: 22, aqi_so2: 11, aqi_dominant: 0, aqi_eu_dominant: 0 },
    { weathercode: 63, precip: 92, temp_c: -3,  snow_cm: 7, rain_mm: 5.2, freeze_m: 2286,   wind_sfc_kph: 30, wind_sfc_dir: 4, wind_gust_kph: 52, wind_aloft: [{ kph: 84, dir: 3 }, { kph: 72, dir: 3 }, { kph: 60, dir: 3 }, { kph: 52, dir: 2 }, { kph: 36, dir: 3 }, { kph: 28, dir: 3 }, { kph: 24, dir: 4 }], cloud_band: [100, 97, 95, 90, 85, 80, 75, 70, 60, 50], aqi: 172, aqi_pm25: 168, aqi_o3: 35, aqi_eu: 78,  aqi_eu_pm25: 48, aqi_eu_o3: 38, aqi_eu_pm10: 36, aqi_eu_no2: 19, aqi_eu_so2: 8, aqi_pm10: 78, aqi_no2: 23, aqi_so2: 11, aqi_dominant: 0, aqi_eu_dominant: 0 },
    { weathercode: 71, precip: 64, temp_c: -6,  snow_cm: 3, rain_mm: 0,   freeze_m: 2590.8, wind_sfc_kph: 20, wind_sfc_dir: 5, wind_gust_kph: 38, wind_aloft: [{ kph: 76, dir: 4 }, { kph: 64, dir: 4 }, { kph: 52, dir: 4 }, { kph: 44, dir: 3 }, { kph: 28, dir: 2 }, { kph: 20, dir: 2 }, { kph: 16, dir: 3 }], cloud_band: [80, 75, 70, 65, 60, 55, 45, 40, 30, 25], aqi: 130, aqi_pm25: 124, aqi_o3: 40, aqi_eu: 61,  aqi_eu_pm25: 36, aqi_eu_o3: 43, aqi_eu_pm10: 28, aqi_eu_no2: 16, aqi_eu_so2: 7, aqi_pm10: 66, aqi_no2: 20, aqi_so2: 10, aqi_dominant: 0, aqi_eu_dominant: 1 },
    { weathercode: 2,  precip: 14, temp_c: -12, snow_cm: 0, rain_mm: 0,   freeze_m: 3352.8, wind_sfc_kph: 8,  wind_sfc_dir: 6, wind_gust_kph: 15, wind_aloft: [{ kph: 56, dir: 5 }, { kph: 44, dir: 5 }, { kph: 32, dir: 5 }, { kph: 24, dir: 4 }, { kph: 16, dir: 5 }, { kph: 8, dir: 5 }, { kph: 4, dir: 6 }], cloud_band: [20, 15, 10, 5, 5, 0, 0, 0, 0, 0],  aqi: 22,  aqi_pm25: 8,   aqi_o3: 21, aqi_eu: 12,  aqi_eu_pm25: 9, aqi_eu_o3: 11, aqi_eu_pm10: 7, aqi_eu_no2: 5, aqi_eu_so2: 3, aqi_pm10: 15, aqi_no2: 8, aqi_so2: 4, aqi_dominant: 1, aqi_eu_dominant: 1 },
    { weathercode: 71, precip: 43, temp_c: -10, snow_cm: 2, rain_mm: 0,   freeze_m: 2743.2, wind_sfc_kph: 12, wind_sfc_dir: 4, wind_gust_kph: 25, wind_aloft: [{ kph: 64, dir: 4 }, { kph: 52, dir: 4 }, { kph: 40, dir: 4 }, { kph: 32, dir: 4 }, { kph: 20, dir: 3 }, { kph: 12, dir: 3 }, { kph: 8, dir: 4 }], cloud_band: [90, 85, 80, 70, 55, 50, 40, 30, 20, 10], aqi: 88,  aqi_pm25: 85,  aqi_o3: 30, aqi_eu: 41,  aqi_eu_pm25: 26, aqi_eu_o3: 30, aqi_eu_pm10: 19, aqi_eu_no2: 12, aqi_eu_so2: 6, aqi_pm10: 52, aqi_no2: 17, aqi_so2: 8, aqi_dominant: 0, aqi_eu_dominant: 1 },
    { weathercode: 3,  precip: 29, temp_c: -7,  snow_cm: 0, rain_mm: 1.2, freeze_m: 2895.6, wind_sfc_kph: 20, wind_sfc_dir: 3, wind_gust_kph: 35, wind_aloft: [{ kph: 68, dir: 2 }, { kph: 56, dir: 2 }, { kph: 44, dir: 2 }, { kph: 36, dir: 2 }, { kph: 28, dir: 1 }, { kph: 20, dir: 1 }, { kph: 16, dir: 2 }], cloud_band: [60, 55, 50, 40, 35, 30, 25, 10, 5, 0], aqi: 51,  aqi_pm25: 12,  aqi_o3: 50, aqi_eu: 33,  aqi_eu_pm25: 14, aqi_eu_o3: 32, aqi_eu_pm10: 11, aqi_eu_no2: 9, aqi_eu_so2: 4, aqi_pm10: 20, aqi_no2: 13, aqi_so2: 6, aqi_dominant: 1, aqi_eu_dominant: 1 },
    { weathercode: 61, precip: 71, temp_c: -5,  snow_cm: 1, rain_mm: 2.1, freeze_m: 2590.8, wind_sfc_kph: 28, wind_sfc_dir: 2, wind_gust_kph: 55, wind_aloft: [{ kph: 76, dir: 1 }, { kph: 64, dir: 1 }, { kph: 52, dir: 1 }, { kph: 44, dir: 1 }, { kph: 36, dir: 0 }, { kph: 28, dir: 0 }, { kph: 24, dir: 1 }], cloud_band: [92, 88, 85, 80, 70, 65, 60, 45, 40, 30], aqi: 210, aqi_pm25: 205, aqi_o3: 45, aqi_eu: 105, aqi_eu_pm25: 66, aqi_eu_o3: 48, aqi_eu_pm10: 51, aqi_eu_no2: 21, aqi_eu_so2: 9, aqi_pm10: 96, aqi_no2: 25, aqi_so2: 12, aqi_dominant: 0, aqi_eu_dominant: 0 },
  ]],
};
if (input.periods[0].length !== layout.periodHours.length)
  throw new Error(`fixture: ${input.periods[0].length} periods for a ${layout.periodHours.length}-period layout`);

// The slim response omits lat/lon/model/vars/duration and the request datetime; decode recovers
// them from the request context (keyed by code). Mirror what test/fixture.test.ts builds.
const ctx = () => ({
  model: 31 - Math.clz32(input.models_mask & -input.models_mask),
  vars: input.vars,
  lat: input.lat,
  lon: input.lon,
  start: startMs,
  mode: request.mode,
  utcOffsetHours: request.utcOffsetHours,
});

const encoded = wireCodec.encode(input);
// Round-trip to capture quantization so fixture.decoded is exactly what decode produces.
const decoded = wireCodec.decode(encoded, ctx);

const fixture = {
  description: "Detail-mode fill (seq 5: 3h/12h/12h), all variables, Denali 14k camp",
  request,
  encoded,
  decoded,
};

const outDir = join(__dirname, "../test/fixtures");
mkdirSync(outDir, { recursive: true });
const outPath = join(outDir, "wire.fixture.json");
// vars is a Set; it persists as a sorted array and the tests revive it.
writeFileSync(outPath, JSON.stringify(fixture, (_k, v) => (v instanceof Set ? [...v].sort() : v), 2) + "\n");
console.log(`Written: ${outPath}`);
console.log(`Encoded: ${encoded}`);
