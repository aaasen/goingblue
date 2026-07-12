import { writeFileSync, mkdirSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, join } from "path";
// Imports the built codec, so build the protocol first: `pnpm --filter @weather/protocol build`.
import { v1Codec, layoutFor, type ForecastMessage } from "../dist/index.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

// Every v1 variable bit (0..13), so the fixture exercises — and freezes — every column's encoding
// (precip, temp/tmin, snow, rain, freeze, surface + 500/600/700 hPa winds, total/high/mid/low cloud).
const vars_mask = (1 << 14) - 1;

// Duration-first fill: a 3-day request at 13:00 local (UTC-9), seq 5 → days 0-1 at 12h (day 0
// partial: one period from 12:00), day 2 daily — a mixed layout, so the fixture freezes the
// layout arithmetic (which is wire format, see layout.ts) alongside the byte format. The
// request datetime, duration, and offset live in `request` so the test can rebuild the
// context the decoder needs (the year floats: it is not on the wire, and the layout only
// depends on the hour-of-day).
const request = { month: 6, day: 15, hour: 22, durationDays: 3, utcOffsetHours: -9 };
const startMs = Date.UTC(new Date().getUTCFullYear(), request.month - 1, request.day, request.hour);
const seq = 5;
const layout = layoutFor(request.durationDays, startMs / 3600000, request.utcOffsetHours, seq);
const firstStart = new Date(layout.periodStartUtcHour[0] * 3600000);

const input: ForecastMessage = {
  version: 1,
  code: 0,
  days: layout.days,
  models_mask: 0b0001, // HRES only
  vars_mask,
  month: firstStart.getUTCMonth() + 1,
  day: firstStart.getUTCDate(),
  hour: firstStart.getUTCHours(),
  lat: 63.063,
  lon: -151.081,
  elevation: 4267,
  seq,
  durationDays: request.durationDays,
  periodHours: layout.periodHours,
  periods: [[
    { weathercode: 3,  precip: 57, temp_c: -8,  temp_min_c: -15, snow_cm: 0, rain_mm: 0,   freeze_m: 3048,   wind_sfc_kph: 16, wind_sfc_dir: 5, wind_500_kph: 48, wind_500_dir: 4, wind_600_kph: 40, wind_600_dir: 3, wind_700_kph: 24, wind_700_dir: 2, cloud_total: 80,  cloud_high: 60, cloud_mid: 40, cloud_low: 20 },
    { weathercode: 61, precip: 86, temp_c: -4,  temp_min_c: -12, snow_cm: 5, rain_mm: 3.5, freeze_m: 2438.4, wind_sfc_kph: 24, wind_sfc_dir: 5, wind_500_kph: 56, wind_500_dir: 3, wind_600_kph: 48, wind_600_dir: 3, wind_700_kph: 32, wind_700_dir: 3, cloud_total: 100, cloud_high: 90, cloud_mid: 70, cloud_low: 60 },
    { weathercode: 2,  precip: 14, temp_c: -12, temp_min_c: -20, snow_cm: 0, rain_mm: 0,   freeze_m: 3352.8, wind_sfc_kph: 8,  wind_sfc_dir: 6, wind_500_kph: 32, wind_500_dir: 5, wind_600_kph: 24, wind_600_dir: 4, wind_700_kph: 16, wind_700_dir: 5, cloud_total: 20,  cloud_high: 10, cloud_mid: 5,  cloud_low: 0  },
    { weathercode: 71, precip: 43, temp_c: -10, temp_min_c: -17, snow_cm: 2, rain_mm: 0,   freeze_m: 2743.2, wind_sfc_kph: 12, wind_sfc_dir: 4, wind_500_kph: 40, wind_500_dir: 4, wind_600_kph: 32, wind_600_dir: 4, wind_700_kph: 20, wind_700_dir: 3, cloud_total: 90,  cloud_high: 80, cloud_mid: 50, cloud_low: 30 },
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
  durationDays: request.durationDays,
  utcOffsetHours: request.utcOffsetHours,
});

const encoded = v1Codec.encode(input);
// Round-trip to capture quantization so fixture.decoded is exactly what decode produces.
const decoded = v1Codec.decode(encoded, ctx);

const fixture = {
  description: "3-day duration-first fill (seq 5: 12h/12h/daily), all variables, Denali 14k camp",
  request,
  encoded,
  decoded,
};

const outDir = join(__dirname, "../test/fixtures");
mkdirSync(outDir, { recursive: true });
const outPath = join(outDir, "v1.fixture.json");
writeFileSync(outPath, JSON.stringify(fixture, null, 2) + "\n");
console.log(`Written: ${outPath}`);
console.log(`Encoded: ${encoded}`);
