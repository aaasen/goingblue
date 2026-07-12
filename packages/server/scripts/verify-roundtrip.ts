/**
 * Corpus round-trip sweep: encode + decode every cached forecast (data/raw/gfs) through the
 * production path (aggregateHourly → toFullPeriod → the v1 codec) at every resolution, and
 * verify the codec is a fixpoint: decode must consume the stream exactly (the rANS final-state
 * integrity check throws otherwise), and re-encoding the decoded message must reproduce the
 * identical string (quantization is idempotent, so any drift means an encode/decode mismatch).
 *
 * This is the strongest guard against coder edge cases synthetic tests miss (renormalization
 * boundaries, trailing zero words, escape paths under real weather).
 *
 *   node scripts/verify-roundtrip.ts            # from packages/server
 */
import { aggregateHourly, toFullPeriod, HOURS_PER_PERIOD, type HourlyData } from "../src/forecast.ts";
import { eachForecast } from "./derive-lib.ts";
import {
  v1MessageToString, v1MessageFromString, V1_MAX_PERIODS, VARS_BIT, DEFAULT_VARS_MASK,
  type ForecastMessage, type Period, type RequestContext,
} from "@weather/protocol";

const ALL_VARS = (1 << 14) - 1;
const RES_INDICES = [0, 1, 2, 3, 4]; // 24h, 12h, 6h, 3h, 1h
// Mirror the app: tmin is dropped at 1h (identical to temp there).
const maskForRes = (mask: number, resIdx: number) =>
  HOURS_PER_PERIOD[resIdx] === 1 ? mask & ~(1 << VARS_BIT.tmin) : mask;

let messages = 0;
let failures = 0;
let forecasts = 0;

await eachForecast((hourly: HourlyData, runHour: number) => {
  forecasts++;
  for (const resIdx of RES_INDICES) {
    const hoursPerPeriod = HOURS_PER_PERIOD[resIdx];
    const startEpochHour = Math.floor(runHour / hoursPerPeriod) * hoursPerPeriod;
    const n = Math.min(V1_MAX_PERIODS, Math.floor(hourly.time.length / hoursPerPeriod));
    if (n < 1) continue;
    const rows = aggregateHourly(hourly, hourly.time, n, resIdx, startEpochHour);

    for (const baseMask of [ALL_VARS, DEFAULT_VARS_MASK]) {
      const mask = maskForRes(baseMask, resIdx);
      const periods: Period[] = rows.map((r) => toFullPeriod(r, mask, "GFS", resIdx));
      const start = new Date(startEpochHour * 3600000);
      const msg: ForecastMessage = {
        version: 1, code: messages % 128, days: Math.ceil(n / (24 / hoursPerPeriod)),
        resolution: resIdx, models_mask: 1 << 1 /* GFS */, vars_mask: mask,
        month: start.getUTCMonth() + 1, day: start.getUTCDate(), hour: start.getUTCHours(),
        lat: 0, lon: 0, elevation: 0, periods: [periods],
      };
      const ctx: RequestContext = {
        resolution: resIdx, model: 1, vars_mask: mask, lat: 0, lon: 0,
        start: startEpochHour * 3600000,
      };
      messages++;
      try {
        const encoded = v1MessageToString(msg);
        const decoded = v1MessageFromString(encoded, () => ctx); // assertDone throws on desync
        if (decoded.periods[0].length !== n)
          throw new Error(`period count ${decoded.periods[0].length} != ${n}`);
        const reencoded = v1MessageToString(decoded);
        if (reencoded !== encoded)
          throw new Error(`re-encode drift:\n  ${encoded}\n  ${reencoded}`);
      } catch (e) {
        failures++;
        if (failures <= 10)
          console.error(`FAIL res=${resIdx} mask=${mask.toString(2)} n=${n}: ${e}`);
      }
    }
  }
});

console.log(`${forecasts} forecasts → ${messages} messages round-tripped, ${failures} failures`);
if (failures > 0) process.exit(1);
