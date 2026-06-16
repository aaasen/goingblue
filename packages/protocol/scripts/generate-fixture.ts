import { writeFileSync, mkdirSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, join } from "path";
import { v1Codec } from "../src/versions/v1.js";
import { DEFAULT_VARS_MASK } from "../src/constants.js";
import type { V1ForecastMessage } from "../src/model.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

const input: V1ForecastMessage = {
  version: 1,
  location: 2,         // 14k camp
  days: 3,
  resolution: 0,       // daily
  models_mask: 0b0001, // HRES only
  vars_mask: DEFAULT_VARS_MASK, // precip + snow + freeze + w500 + w600 + w700
  month: 6,
  day: 15,
  hour: 0,
  lat: 63.063,
  lon: -151.081,
  elevation: 4267,
  periods: [[
    { weathercode: 3,  precip: 57,  snow_in: 0,  freeze_ft: 10000, wind_500_mph: 30, wind_500_dir: 4, wind_600_mph: 25, wind_600_dir: 3, wind_700_mph: 15, wind_700_dir: 2 },
    { weathercode: 61, precip: 86,  snow_in: 2,  freeze_ft:  8000, wind_500_mph: 35, wind_500_dir: 3, wind_600_mph: 30, wind_600_dir: 3, wind_700_mph: 20, wind_700_dir: 3 },
    { weathercode: 2,  precip: 14,  snow_in: 0,  freeze_ft: 11000, wind_500_mph: 20, wind_500_dir: 5, wind_600_mph: 15, wind_600_dir: 4, wind_700_mph: 10, wind_700_dir: 5 },
  ]],
};

const encoded = v1Codec.encode(input);
// Round-trip to capture quantization so fixture.decoded is exactly what decode produces.
const decoded = v1Codec.decode(encoded);

const fixture = {
  description: "3-day daily ECMWF HRES, precip+snow+freeze+w500+w600+w700, Denali 14k camp",
  encoded,
  decoded,
};

const outDir = join(__dirname, "../test/fixtures");
mkdirSync(outDir, { recursive: true });
const outPath = join(outDir, "v1.fixture.json");
writeFileSync(outPath, JSON.stringify(fixture, null, 2) + "\n");
console.log(`Written: ${outPath}`);
console.log(`Encoded: ${encoded}`);
