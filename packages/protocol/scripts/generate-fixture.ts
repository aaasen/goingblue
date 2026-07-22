import { writeFileSync, mkdirSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, join } from "path";
// Imports the built codec, so build the protocol first: `pnpm --filter @weather/protocol build`.
import { v1Codec, layoutFor, type ForecastMessage } from "../dist/index.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

// Every v1 variable bit, so the fixture exercises — and freezes — every column's encoding
// (precip, temp, snow, rain, freeze, surface + 500/600/700 hPa winds, high/mid/low cloud).
const vars_mask = ((1 << 13) - 1) & ~(1 << 8); // bit 8 (formerly cloud_total) is reserved

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
  version: 1,
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
  periods: [[
    { weathercode: 3,  precip: 57, temp_c: -8,  snow_cm: 0, rain_mm: 0,   freeze_m: 3048,   wind_sfc_kph: 16, wind_sfc_dir: 5, wind_500_kph: 48, wind_500_dir: 4, wind_600_kph: 40, wind_600_dir: 3, wind_700_kph: 24, wind_700_dir: 2, cloud_high: 60, cloud_mid: 40, cloud_low: 20 },
    { weathercode: 61, precip: 86, temp_c: -4,  snow_cm: 5, rain_mm: 3.5, freeze_m: 2438.4, wind_sfc_kph: 24, wind_sfc_dir: 5, wind_500_kph: 56, wind_500_dir: 3, wind_600_kph: 48, wind_600_dir: 3, wind_700_kph: 32, wind_700_dir: 3, cloud_high: 90, cloud_mid: 70, cloud_low: 60 },
    { weathercode: 2,  precip: 14, temp_c: -12, snow_cm: 0, rain_mm: 0,   freeze_m: 3352.8, wind_sfc_kph: 8,  wind_sfc_dir: 6, wind_500_kph: 32, wind_500_dir: 5, wind_600_kph: 24, wind_600_dir: 4, wind_700_kph: 16, wind_700_dir: 5, cloud_high: 10, cloud_mid: 5,  cloud_low: 0  },
    { weathercode: 71, precip: 43, temp_c: -10, snow_cm: 2, rain_mm: 0,   freeze_m: 2743.2, wind_sfc_kph: 12, wind_sfc_dir: 4, wind_500_kph: 40, wind_500_dir: 4, wind_600_kph: 32, wind_600_dir: 4, wind_700_kph: 20, wind_700_dir: 3, cloud_high: 80, cloud_mid: 50, cloud_low: 30 },
    { weathercode: 3,  precip: 29, temp_c: -7,  snow_cm: 0, rain_mm: 1.2, freeze_m: 2895.6, wind_sfc_kph: 20, wind_sfc_dir: 3, wind_500_kph: 44, wind_500_dir: 2, wind_600_kph: 36, wind_600_dir: 2, wind_700_kph: 28, wind_700_dir: 1, cloud_high: 50, cloud_mid: 30, cloud_low: 10 },
    { weathercode: 61, precip: 71, temp_c: -5,  snow_cm: 1, rain_mm: 2.1, freeze_m: 2590.8, wind_sfc_kph: 28, wind_sfc_dir: 2, wind_500_kph: 52, wind_500_dir: 1, wind_600_kph: 44, wind_600_dir: 1, wind_700_kph: 36, wind_700_dir: 0, cloud_high: 85, cloud_mid: 65, cloud_low: 45 },
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

const encoded = v1Codec.encode(input);
// Round-trip to capture quantization so fixture.decoded is exactly what decode produces.
const decoded = v1Codec.decode(encoded, ctx);

const fixture = {
  description: "Detail-mode fill (seq 4: 6h/12h/12h), all variables, Denali 14k camp",
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
