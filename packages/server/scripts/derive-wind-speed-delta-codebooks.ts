/**
 * Derive a single wind-speed-delta Huffman codebook from the corpus's pooled hour-to-hour
 * quantized-speed delta distribution. The quantized speed step (0..15, see
 * WIND_SPEED_BITS/KPH_PER_STEP in v1.ts) is bounded, so like freezing level the full delta range
 * -15..15 (31 symbols) fits directly in the alphabet — no escape/raw-payload fallback needed.
 * Counts are pooled across all four wind levels (surface + 500/600/700 hPa) — same call as wind
 * direction (see derive-wind-dir-codebooks.ts): pooling barely changes the bit cost vs. deriving
 * separate tables per level.
 *
 * Earlier versions of this script k-means clustered per-(forecast × wind level) delta histograms
 * into 16 tables selected per message. Like freezing level (see
 * derive-freeze-delta-codebooks.ts), that doesn't pay off: wind-speed deltas are dominated
 * everywhere by "usually 0, occasionally ±1", so the clusters only picked up local volatility. A
 * held-out check (split by location) found cheapest-of-16 with a 4-bit selector at 1.529 b/period
 * vs 1.514 b/period for one shared table — the single table actually generalizes better.
 *
 * The table lands in packages/protocol/src/codebooks.gen.ts via `pnpm generate`; run standalone
 * (below) to derive and print without writing:
 *
 *   node packages/server/scripts/derive-wind-speed-delta-codebooks.ts
 */
import { aggregateHourly, toFullPeriod, HOURS_PER_PERIOD } from "../src/forecast.ts";
import { VARS_BIT } from "@weather/protocol";
import { eachForecast, huffmanLengths, scaledWeights, runStandalone, type DerivedTables } from "./derive-lib.ts";

const SPEED_BITS = 4;              // matches WIND_SPEED_BITS in v1.ts (steps 0..15)
const SPEED_MAX = (1 << SPEED_BITS) - 1;
const NSYM = 2 * SPEED_MAX + 1;    // 31: deltas -15..15, no escape needed (already bounded)
const KPH_PER_STEP = 5 * 1.609344; // must match v1.ts
const WIND_MASK = (1 << VARS_BIT.wind) | (1 << VARS_BIT.w500) | (1 << VARS_BIT.w600) | (1 << VARS_BIT.w700);
const SPEED_FIELDS = ["wind_sfc_kph", "wind_500_kph", "wind_600_kph", "wind_700_kph"] as const;
const RES_IDX = 4;                 // 1h — finest, most samples
const RAW_BITS = SPEED_BITS;       // cost of the fixed-width fallback

const quantSpeed = (kph: number): number => Math.min(Math.floor(kph / KPH_PER_STEP), SPEED_MAX);
const deltaSym = (delta: number): number => delta + SPEED_MAX; // -15..15 -> 0..30

// Pooled delta counts across the whole corpus (all forecasts × wind levels).
async function collectCounts(): Promise<number[]> {
  const counts = new Array(NSYM).fill(0);
  await eachForecast((h, startHour) => {
    const n = Math.min(128, Math.floor(h.time.length / HOURS_PER_PERIOD[RES_IDX]));
    const periods = aggregateHourly(h, h.time, n, RES_IDX, startHour).map((r) => toFullPeriod(r, WIND_MASK, "GFS", RES_IDX));
    for (const field of SPEED_FIELDS) {
      for (let i = 1; i < periods.length; i++) {
        const prev = quantSpeed(((periods[i - 1] as any)[field] as number) ?? 0);
        const cur = quantSpeed(((periods[i] as any)[field] as number) ?? 0);
        counts[deltaSym(cur - prev)]++;
      }
    }
  });
  return counts;
}

export async function derive(): Promise<DerivedTables> {
  const counts = await collectCounts();
  const total = counts.reduce((a, b) => a + b, 0);
  console.log(`Delta samples: ${total}`);

  const weights = scaledWeights(counts);
  const lens = huffmanLengths(weights);
  const meanBits = counts.reduce((s, c, sym) => s + c * lens[sym], 0) / total;
  console.log(`Mean bits/period (single table): ${meanBits.toFixed(3)}  (raw = ${RAW_BITS})`);

  return { WIND_SPEED_DELTA_WEIGHTS: weights };
}

runStandalone(import.meta.url, derive);
