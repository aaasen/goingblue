/**
 * Derive wind-speed-delta codebooks keyed by (resolution, level), plus upper-Δ-conditioned
 * tables for the 600/700 hPa columns.
 *
 * The quantized speed domain is 0..31 (5 mph steps → 155 mph cap; the old 0..15 domain clamped
 * 6% of 1h and 8.6% of 6h 500 hPa values at 75 mph). Deltas -31..31 (63 symbols) fit directly
 * in the alphabet — no escape needed.
 *
 * Schemes compared held-out (5-fold, split by location, rANS cost — see analyze-wind-heldout.ts):
 *
 *   pooled levels, trained at 1h, applied everywhere (old design): 4.45 (24h) … 1.46 (1h) b/Δ
 *   [res][level]:                                                  3.21 (24h) … 1.44 (1h)
 *   [res][bucket(upper same-period Δ)] (w600/w700):                2.99 (24h) … 1.45 (1h)
 *
 * Level keying pays because the pooled table taxed the surface column hardest (its deltas are
 * far more peaked than the jet levels'); resolution keying for the same reason as direction.
 * For w600/w700 the upper level's already-decoded same-period delta, bucketed to
 * {≤-2, -1, 0, +1, ≥+2}, beats even the level-keyed tables — adjacent pressure levels move
 * together. All of these contexts are known to both sides, so none cost wire bits.
 *
 * Tables land in packages/protocol/src/codebooks.gen.ts via `pnpm generate`; run standalone
 * (below) to derive and print without writing:
 *
 *   node packages/server/scripts/derive-wind-speed-delta-codebooks.ts
 */
import { aggregateHourly, toFullPeriod, HOURS_PER_PERIOD } from "../src/forecast.ts";
import { VARS_BIT, type Period } from "@weather/protocol";
import { eachForecast, scaledWeights, runStandalone, type DerivedTables } from "./derive-lib.ts";

const NRES = 5;
const NLEVEL = 4;                  // sfc, 500, 600, 700 (WIND_COLUMNS order in v1.ts)
const NBUCKET = 5;                 // upper Δ buckets: ≤-2, -1, 0, +1, ≥+2
const SPEED_MAX = 31;              // must match WIND_SPEED_BITS = 5 in v1.ts
const NSYM = 2 * SPEED_MAX + 1;    // 63: deltas -31..31
const KPH_PER_STEP = 5 * 1.609344; // must match v1.ts
const WIND_MASK = (1 << VARS_BIT.wind) | (1 << VARS_BIT.w500) | (1 << VARS_BIT.w600) | (1 << VARS_BIT.w700);
const SPEED_FIELDS = ["wind_sfc_kph", "wind_500_kph", "wind_600_kph", "wind_700_kph"] as const;
const UPPER_OF = [-1, -1, 1, 2];   // must match v1.ts

const qSpeed = (kph: number | undefined) =>
  Math.min(Math.floor(((kph ?? 0) / KPH_PER_STEP) + 1e-9), SPEED_MAX);
// must match upperDeltaBucket in entropy.ts
const dBucket = (d: number) => (d <= -2 ? 0 : d === -1 ? 1 : d === 0 ? 2 : d === 1 ? 3 : 4);

export async function derive(): Promise<DerivedTables> {
  const byLevel = Array.from({ length: NRES }, () =>
    Array.from({ length: NLEVEL }, () => new Array(NSYM).fill(0)));
  const byBucket = Array.from({ length: NRES }, () =>
    Array.from({ length: NBUCKET }, () => new Array(NSYM).fill(0)));
  let samples = 0;

  await eachForecast((h, startHour) => {
    for (let resIdx = 0; resIdx < NRES; resIdx++) {
      const hpp = HOURS_PER_PERIOD[resIdx];
      const start = Math.floor(startHour / hpp) * hpp;
      const n = Math.floor(h.time.length / hpp);
      if (n < 2) continue;
      const rows = aggregateHourly(h, h.time, n, resIdx, start);
      const periods: Period[] = rows.map((r) => toFullPeriod(r, WIND_MASK, "GFS", resIdx));
      const sp = SPEED_FIELDS.map((f) => periods.map((p) => qSpeed((p as any)[f])));
      for (let L = 0; L < NLEVEL; L++) {
        const U = UPPER_OF[L];
        for (let p = 1; p < n; p++) {
          const sym = sp[L][p] - sp[L][p - 1] + SPEED_MAX;
          byLevel[resIdx][L][sym]++;
          if (U >= 0) byBucket[resIdx][dBucket(sp[U][p] - sp[U][p - 1])][sym]++;
          samples++;
        }
      }
    }
  });
  console.log(`Delta samples across 5 resolutions × 4 levels: ${samples}`);

  // Empty rows (rare tails at coarse resolutions) fall back to the resolution's pooled marginal.
  const marginal = byLevel.map((levels) => {
    const m = new Array(NSYM).fill(0);
    for (const row of levels) for (let i = 0; i < NSYM; i++) m[i] += row[i];
    return m;
  });
  const sum = (r: number[]) => r.reduce((a, b) => a + b, 0);
  return {
    WIND_SPEED_DELTA_WEIGHTS_BY_RES_LEVEL: byLevel.map((levels, res) =>
      levels.map((row) => scaledWeights(sum(row) > 0 ? row : marginal[res]))),
    WIND_SPEED_UPPER_DELTA_WEIGHTS_BY_RES: byBucket.map((buckets, res) =>
      buckets.map((row) => scaledWeights(sum(row) > 0 ? row : marginal[res]))),
  };
}

runStandalone(import.meta.url, derive);
