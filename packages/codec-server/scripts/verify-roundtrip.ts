/**
 * Corpus round-trip sweep: encode + decode every cached forecast (data/raw/gfs) through the
 * production path (encodeFillSeq: layout windows → aggregation → toFullPeriod → the v1 codec)
 * at every fill-sequence number, and verify the codec is a fixpoint: decode must consume the
 * stream exactly (the rANS final-state integrity check throws otherwise), and re-encoding the
 * decoded message must reproduce the identical string (quantization is idempotent, so any
 * drift means an encode/decode mismatch).
 *
 * This is the strongest guard against coder edge cases synthetic tests miss (renormalization
 * boundaries, trailing zero words, escape paths under real weather).
 *
 *   pnpm exec tsx scripts/verify-roundtrip.ts             # every ~200th corpus forecast (see --stride)
 *   pnpm exec tsx scripts/verify-roundtrip.ts --stride 1  # the whole corpus (hours)
 */
import { encodeFillSeq, type ForecastParams, type HourlyData } from "../src/forecast.ts";
import { eachForecast } from "./derive-lib.ts";
import {
  v1MessageToString, v1MessageFromString, layoutFor, maxFillSeq, DEFAULT_VARS_MASK,
  ALWAYS_VARS_MASK, CODECS,
  MODE_DETAIL, MODE_AUTO, MODE_RANGE,
  type RequestContext,
} from "@weather/protocol";

const ALL_VARS = ((1 << 13) - 1) & ~(1 << 8); // bit 8 (formerly cloud_total) is reserved
const UTC_OFFSET = 0;
// Request at midnight (whole day 0) and mid-afternoon (partial day 0) to cover both layouts.
const REQUEST_HOURS_OF_DAY = [0, 13];
const codec = CODECS[1];

// Every mode × seq × mask × request hour is ~800 messages per forecast, so the full corpus
// (~100k train cells) is an hours-long run. The default stride samples an even spread that
// still exercises every layout shape against ~500 real forecasts.
const strideArg = process.argv.indexOf("--stride");
const STRIDE = strideArg >= 0 ? Math.max(1, parseInt(process.argv[strideArg + 1], 10)) : 200;

let messages = 0;
let failures = 0;
let forecasts = 0;
let visited = 0;

await eachForecast((hourly: HourlyData, _runHour: number) => {
  if (visited++ % STRIDE !== 0) return;
  forecasts++;
  const times = hourly.time;
  const dataStart = Math.floor(Date.parse(`${times[0]}:00Z`) / 3600000);
  const dataEnd = dataStart + times.length; // exclusive
  // Anchor day 0 at the first covered local midnight so every layout's window has data.
  const day0 = Math.ceil(dataStart / 24) * 24;

  for (const hourOfDay of REQUEST_HOURS_OF_DAY) {
    const startEpochHour = day0 + hourOfDay;
    // ALWAYS_VARS_MASK is what a bare request (no `v:` token) encodes with — the lean base set
    // including gust, with precip left out.
    for (const mask of [ALL_VARS, DEFAULT_VARS_MASK, ALWAYS_VARS_MASK]) {
      for (const mode of [MODE_DETAIL, MODE_AUTO, MODE_RANGE]) {
        const params: ForecastParams = {
          locationIdx: 0, lat: 0, lon: 0,
          mode, utcOffsetHours: UTC_OFFSET,
          modelsMask: 1 << 1 /* GFS */, varsMask: mask,
          maxChars: 160, decoderVersion: 1, code: messages % 128,
          startEpochHour, userToken: null,
        };
        const ctx: RequestContext = {
          model: 1, vars_mask: mask, lat: 0, lon: 0,
          start: startEpochHour * 3600000, mode, utcOffsetHours: UTC_OFFSET,
        };

        for (let seq = 1; seq <= maxFillSeq(mode); seq++) {
          const layout = layoutFor(mode, startEpochHour, UTC_OFFSET, seq);
          // Skip layouts the cached window can't cover (short corpus records).
          const last = layout.periodStartUtcHour.length - 1;
          if (layout.periodStartUtcHour[last] + layout.periodHours[last] > dataEnd) continue;
          messages++;
          try {
            const encoded = encodeFillSeq(hourly, times, params, seq, 0, 0, 0, "US", codec);
            if (encoded === null) throw new Error("data gap: layout not covered by corpus hours");
            const decoded = v1MessageFromString(encoded, () => ctx); // assertDone throws on desync
            if (decoded.periods[0].length !== layout.periodHours.length)
              throw new Error(`period count ${decoded.periods[0].length} != ${layout.periodHours.length}`);
            const reencoded = v1MessageToString(decoded);
            if (reencoded !== encoded)
              throw new Error(`re-encode drift:\n  ${encoded}\n  ${reencoded}`);
          } catch (e) {
            failures++;
            if (failures <= 10)
              console.error(`FAIL mode=${mode} seq=${seq} hourOfDay=${hourOfDay} mask=${mask.toString(2)}: ${e}`);
          }
        }
      }
    }
  }
});

console.log(`${forecasts} forecasts → ${messages} messages round-tripped, ${failures} failures`);
if (failures > 0) process.exit(1);
