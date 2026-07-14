/**
 * Derive a single freezing-level-delta Huffman codebook from the corpus's pooled hour-to-hour
 * quantized freeze-level delta distribution. The quantized freeze-level step (0..31, 304.8 m /
 * 1000 ft steps — see the freeze column in v1.ts) is bounded, so like wind speed the full delta
 * range -31..31 (63 symbols) fits directly in the alphabet — no escape/raw-payload fallback needed.
 *
 * Earlier versions of this script k-means clustered per-forecast delta histograms into 16 tables
 * selected per message (like weathercode/wind direction). That doesn't pay off here: unlike
 * weathercode and wind direction, freeze-level deltas don't have genuinely distinct regimes across
 * locations/seasons — they're dominated everywhere by "usually 0, occasionally ±1", so the 16
 * clusters were only picking up local volatility, not real distributional differences. A held-out
 * check confirmed cheapest-of-16 (1.371 b/period, including the 4-bit selector) is actually WORSE
 * than a single shared table (1.340 b/period, no selector) — so this script now just builds the
 * one table.
 *
 * The table lands in packages/protocol/src/codebooks.gen.ts via `pnpm generate`; run standalone
 * (below) to derive and print without writing:
 *
 *   node packages/server/scripts/derive-freeze-delta-codebooks.ts
 */
import { aggregateHourly, toFullPeriod, HOURS_PER_PERIOD } from "../src/forecast.ts";
import { VARS_BIT } from "@weather/protocol";
import { eachForecast, huffmanLengths, scaledWeights, runStandalone, type DerivedTables } from "./derive-lib.ts";

const STEP_BITS = 5;               // matches the freeze column width in v1.ts (steps 0..31)
const STEP_MAX = (1 << STEP_BITS) - 1;
const NSYM = 2 * STEP_MAX + 1;     // 63: deltas -31..31, no escape needed (already bounded)
const STEP_M = 304.8;              // 1000 ft, must match v1.ts
const RES_IDX = 4;                 // 1h — finest, most samples
const RAW_BITS = STEP_BITS;        // cost of the fixed-width fallback

const quantFreeze = (m: number): number => Math.min(Math.floor(m / STEP_M), STEP_MAX);
const deltaSym = (delta: number): number => delta + STEP_MAX; // -31..31 -> 0..62

// Pooled delta counts across the whole corpus.
async function collectCounts(): Promise<number[]> {
  const counts = new Array(NSYM).fill(0);
  await eachForecast((h, startHour) => {
    const n = Math.min(128, Math.floor(h.time.length / HOURS_PER_PERIOD[RES_IDX]));
    const periods = aggregateHourly(h, h.time, n, RES_IDX, startHour).map((r) => toFullPeriod(r, 1 << VARS_BIT.freeze, "GFS", RES_IDX));
    for (let i = 1; i < periods.length; i++) {
      const prev = quantFreeze(periods[i - 1].freeze_m ?? 0);
      const cur = quantFreeze(periods[i].freeze_m ?? 0);
      counts[deltaSym(cur - prev)]++;
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

  return { FREEZE_DELTA_WEIGHTS: weights };
}

runStandalone(import.meta.url, derive);
