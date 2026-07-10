import { writeFileSync, mkdirSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, join } from "path";
// Imports the built codec, so build the protocol first: `pnpm --filter @weather/protocol build`.
import { v1Codec, type ForecastMessage } from "../dist/index.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

// Every v1 variable bit (0..13), so the fixture exercises — and freezes — every column's encoding
// (precip, temp/tmin, snow, rain, freeze, surface + 500/600/700 hPa winds, total/high/mid/low cloud).
const vars_mask = (1 << 14) - 1;

const input: ForecastMessage = {
  version: 1,
  code: 0,
  days: 3,
  resolution: 0,       // daily
  models_mask: 0b0001, // HRES only
  vars_mask,
  month: 6,
  day: 15,
  hour: 0,
  lat: 63.063,
  lon: -151.081,
  elevation: 4267,
  periods: [[
    { weathercode: 3,  precip: 57, temp_c: -8,  temp_min_c: -15, snow_cm: 0, rain_mm: 0,   freeze_m: 3048,   wind_sfc_kph: 16, wind_sfc_dir: 5, wind_500_kph: 48, wind_500_dir: 4, wind_600_kph: 40, wind_600_dir: 3, wind_700_kph: 24, wind_700_dir: 2, cloud_total: 80,  cloud_high: 60, cloud_mid: 40, cloud_low: 20 },
    { weathercode: 61, precip: 86, temp_c: -4,  temp_min_c: -12, snow_cm: 5, rain_mm: 3.5, freeze_m: 2438.4, wind_sfc_kph: 24, wind_sfc_dir: 5, wind_500_kph: 56, wind_500_dir: 3, wind_600_kph: 48, wind_600_dir: 3, wind_700_kph: 32, wind_700_dir: 3, cloud_total: 100, cloud_high: 90, cloud_mid: 70, cloud_low: 60 },
    { weathercode: 2,  precip: 14, temp_c: -12, temp_min_c: -20, snow_cm: 0, rain_mm: 0,   freeze_m: 3352.8, wind_sfc_kph: 8,  wind_sfc_dir: 6, wind_500_kph: 32, wind_500_dir: 5, wind_600_kph: 24, wind_600_dir: 4, wind_700_kph: 16, wind_700_dir: 5, cloud_total: 20,  cloud_high: 10, cloud_mid: 5,  cloud_low: 0  },
  ]],
};

// The slim response omits lat/lon/model/vars/resolution and the start datetime; decode recovers them
// from the request context (keyed by code). Mirror what test/fixture.test.ts builds.
const ctx = () => ({
  resolution: input.resolution,
  model: 31 - Math.clz32(input.models_mask & -input.models_mask),
  vars_mask: input.vars_mask,
  lat: input.lat,
  lon: input.lon,
  start: Date.UTC(new Date().getUTCFullYear(), input.month - 1, input.day, input.hour),
});

const encoded = v1Codec.encode(input);
// Round-trip to capture quantization so fixture.decoded is exactly what decode produces.
const decoded = v1Codec.decode(encoded, ctx);

const fixture = {
  description: "3-day daily ECMWF HRES, all v1 variables, Denali 14k camp",
  encoded,
  decoded,
};

const outDir = join(__dirname, "../test/fixtures");
mkdirSync(outDir, { recursive: true });
const outPath = join(outDir, "v1.fixture.json");
writeFileSync(outPath, JSON.stringify(fixture, null, 2) + "\n");
console.log(`Written: ${outPath}`);
console.log(`Encoded: ${encoded}`);
