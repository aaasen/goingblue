import { writeFileSync, mkdirSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, join } from "path";
import { v2Codec } from "../src/versions/v2.js";
import { DEFAULT_VARS_MASK } from "../src/constants.js";
import type { ForecastMessage } from "../src/model.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

// Include temp (bit 1) and tmin (bit 13) to exercise v2's 7-bit Celsius encoding.
const vars_mask = DEFAULT_VARS_MASK | (1 << 1) | (1 << 13);

const input: ForecastMessage = {
  version: 2,
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
    { weathercode: 3,  precip: 57,  temp_c: -8,  temp_min_c: -15, snow_cm: 0,    freeze_m: 3048,   wind_500_kph: 48, wind_500_dir: 4, wind_600_kph: 40, wind_600_dir: 3, wind_700_kph: 24, wind_700_dir: 2 },
    { weathercode: 61, precip: 86,  temp_c: -4,  temp_min_c: -12, snow_cm: 5,    freeze_m: 2438.4, wind_500_kph: 56, wind_500_dir: 3, wind_600_kph: 48, wind_600_dir: 3, wind_700_kph: 32, wind_700_dir: 3 },
    { weathercode: 2,  precip: 14,  temp_c: -12, temp_min_c: -20, snow_cm: 0,    freeze_m: 3352.8, wind_500_kph: 32, wind_500_dir: 5, wind_600_kph: 24, wind_600_dir: 4, wind_700_kph: 16, wind_700_dir: 5 },
  ]],
};

const encoded = v2Codec.encode(input);
// Round-trip to capture quantization so fixture.decoded is exactly what decode produces.
const decoded = v2Codec.decode(encoded);

const fixture = {
  description: "3-day daily ECMWF HRES, precip+temp+tmin+snow+freeze+w500+w600+w700, Denali 14k camp",
  encoded,
  decoded,
};

const outDir = join(__dirname, "../test/fixtures");
mkdirSync(outDir, { recursive: true });
const outPath = join(outDir, "v2.fixture.json");
writeFileSync(outPath, JSON.stringify(fixture, null, 2) + "\n");
console.log(`Written: ${outPath}`);
console.log(`Encoded: ${encoded}`);
