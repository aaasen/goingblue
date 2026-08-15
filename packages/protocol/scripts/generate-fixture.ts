import { writeFileSync, mkdirSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, join } from "path";
// Imports the built codec, so build the protocol first: `pnpm --filter @weather/protocol build`.
import { v2Codec, V2_VERSION, layoutFor, type ForecastMessage } from "../dist/index.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

// Every v2 variable bit, so the fixture exercises — and freezes — every column's encoding
// (precip, temp, snow, rain, freeze, surface + 500/600/700 hPa winds, gust, high/mid/low cloud,
// and all twelve air-quality indices). Bit 8 = gust (always-on since 2026-07-30). Bits 0..24 are
// every allocated bit; 25 is free (the US carbon monoxide sub-index, dropped so the two scales
// offer the same constituents — see VARS_BIT). With every sub-index present, BOTH headlines
// encode under their all-three residual mask, which is the mode a real request most wants frozen.
const vars_mask = (1 << 25) - 1;

// Priority-mode fill: Detail mode requested at 13:00 local (UTC-9). seq 4 on the Detail path
// is |6h|12h|12h| — slot 0 at 6h (partial: two periods from 12:00), two whole days at 12h — a
// mixed layout, so the fixture freezes the path tables and layout arithmetic (which are wire
// format, see layout.ts) alongside the byte format. The request datetime, mode, and offset
// live in `request` so the test can rebuild the context the decoder needs (the year floats:
// it is not on the wire, and the layout only depends on the hour-of-day).
const request = { month: 6, day: 15, hour: 22, mode: 0 /* MODE_DETAIL */, utcOffsetHours: -9 };
const startMs = Date.UTC(new Date().getUTCFullYear(), request.month - 1, request.day, request.hour);
const seq = 4;
const layout = layoutFor(request.mode, startMs / 3600000, request.utcOffsetHours, seq);
const firstStart = new Date(layout.periodStartUtcHour[0] * 3600000);

const input: ForecastMessage = {
  version: V2_VERSION,
  code: 0,
  days: layout.days,
  models_mask: 0b0001, // Best Match only (bit 0)
  vars_mask,
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
    { weathercode: 3,  precip: 57, temp_c: -8,  snow_cm: 0, rain_mm: 0,   freeze_m: 3048,   wind_sfc_kph: 16, wind_sfc_dir: 5, wind_gust_kph: 30, wind_500_kph: 48, wind_500_dir: 4, wind_600_kph: 40, wind_600_dir: 3, wind_700_kph: 24, wind_700_dir: 2, cloud_high: 60, cloud_mid: 40, cloud_low: 20, aqi: 118, aqi_pm25: 96,  aqi_o3: 42, aqi_eu: 55,  aqi_eu_pm25: 31, aqi_eu_o3: 50, aqi_eu_pm10: 24, aqi_eu_no2: 15, aqi_eu_so2: 7, aqi_pm10: 61, aqi_no2: 19, aqi_so2: 10 },
    { weathercode: 61, precip: 86, temp_c: -4,  snow_cm: 5, rain_mm: 3.5, freeze_m: 2438.4, wind_sfc_kph: 24, wind_sfc_dir: 5, wind_gust_kph: 45, wind_500_kph: 56, wind_500_dir: 3, wind_600_kph: 48, wind_600_dir: 3, wind_700_kph: 32, wind_700_dir: 3, cloud_high: 90, cloud_mid: 70, cloud_low: 60, aqi: 165, aqi_pm25: 160, aqi_o3: 38, aqi_eu: 72,  aqi_eu_pm25: 44, aqi_eu_o3: 41, aqi_eu_pm10: 33, aqi_eu_no2: 18, aqi_eu_so2: 8, aqi_pm10: 74, aqi_no2: 22, aqi_so2: 11 },
    { weathercode: 2,  precip: 14, temp_c: -12, snow_cm: 0, rain_mm: 0,   freeze_m: 3352.8, wind_sfc_kph: 8,  wind_sfc_dir: 6, wind_gust_kph: 15, wind_500_kph: 32, wind_500_dir: 5, wind_600_kph: 24, wind_600_dir: 4, wind_700_kph: 16, wind_700_dir: 5, cloud_high: 10, cloud_mid: 5,  cloud_low: 0,  aqi: 22,  aqi_pm25: 8,   aqi_o3: 21, aqi_eu: 12,  aqi_eu_pm25: 9, aqi_eu_o3: 11, aqi_eu_pm10: 7, aqi_eu_no2: 5, aqi_eu_so2: 3, aqi_pm10: 15, aqi_no2: 8, aqi_so2: 4 },
    { weathercode: 71, precip: 43, temp_c: -10, snow_cm: 2, rain_mm: 0,   freeze_m: 2743.2, wind_sfc_kph: 12, wind_sfc_dir: 4, wind_gust_kph: 25, wind_500_kph: 40, wind_500_dir: 4, wind_600_kph: 32, wind_600_dir: 4, wind_700_kph: 20, wind_700_dir: 3, cloud_high: 80, cloud_mid: 50, cloud_low: 30, aqi: 88,  aqi_pm25: 85,  aqi_o3: 30, aqi_eu: 41,  aqi_eu_pm25: 26, aqi_eu_o3: 30, aqi_eu_pm10: 19, aqi_eu_no2: 12, aqi_eu_so2: 6, aqi_pm10: 52, aqi_no2: 17, aqi_so2: 8 },
    { weathercode: 3,  precip: 29, temp_c: -7,  snow_cm: 0, rain_mm: 1.2, freeze_m: 2895.6, wind_sfc_kph: 20, wind_sfc_dir: 3, wind_gust_kph: 35, wind_500_kph: 44, wind_500_dir: 2, wind_600_kph: 36, wind_600_dir: 2, wind_700_kph: 28, wind_700_dir: 1, cloud_high: 50, cloud_mid: 30, cloud_low: 10, aqi: 51,  aqi_pm25: 12,  aqi_o3: 50, aqi_eu: 33,  aqi_eu_pm25: 14, aqi_eu_o3: 32, aqi_eu_pm10: 11, aqi_eu_no2: 9, aqi_eu_so2: 4, aqi_pm10: 20, aqi_no2: 13, aqi_so2: 6 },
    { weathercode: 61, precip: 71, temp_c: -5,  snow_cm: 1, rain_mm: 2.1, freeze_m: 2590.8, wind_sfc_kph: 28, wind_sfc_dir: 2, wind_gust_kph: 55, wind_500_kph: 52, wind_500_dir: 1, wind_600_kph: 44, wind_600_dir: 1, wind_700_kph: 36, wind_700_dir: 0, cloud_high: 85, cloud_mid: 65, cloud_low: 45, aqi: 210, aqi_pm25: 205, aqi_o3: 45, aqi_eu: 105, aqi_eu_pm25: 66, aqi_eu_o3: 48, aqi_eu_pm10: 51, aqi_eu_no2: 21, aqi_eu_so2: 9, aqi_pm10: 96, aqi_no2: 25, aqi_so2: 12 },
  ]],
};
if (input.periods[0].length !== layout.periodHours.length)
  throw new Error(`fixture: ${input.periods[0].length} periods for a ${layout.periodHours.length}-period layout`);

// The slim response omits lat/lon/model/vars/duration and the request datetime; decode recovers
// them from the request context (keyed by code). Mirror what test/fixture.test.ts builds.
const ctx = () => ({
  model: 31 - Math.clz32(input.models_mask & -input.models_mask),
  vars_mask: input.vars_mask,
  lat: input.lat,
  lon: input.lon,
  start: startMs,
  mode: request.mode,
  utcOffsetHours: request.utcOffsetHours,
});

const encoded = v2Codec.encode(input);
// Round-trip to capture quantization so fixture.decoded is exactly what decode produces.
const decoded = v2Codec.decode(encoded, ctx);

const fixture = {
  description: "Detail-mode fill (seq 4: 6h/12h/12h), all variables, Denali 14k camp",
  request,
  encoded,
  decoded,
};

const outDir = join(__dirname, "../test/fixtures");
mkdirSync(outDir, { recursive: true });
const outPath = join(outDir, "v2.fixture.json");
writeFileSync(outPath, JSON.stringify(fixture, null, 2) + "\n");
console.log(`Written: ${outPath}`);
console.log(`Encoded: ${encoded}`);
