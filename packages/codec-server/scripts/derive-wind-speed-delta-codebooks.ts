/**
 * Derive wind-speed-delta codebooks keyed by (resolution, level), plus upper-Δ-conditioned
 * tables for the 600/700 hPa columns.
 *
 * The quantized speed domain is the extended Beaufort scale, forces 0..17, for EVERY wind
 * column (see quantWind in derive-lib.ts / v2.ts — chosen 2026-07-31 over linear and other
 * companded scales, analyze-wind-scale-heldout.ts). Deltas -17..17 (35 symbols) fit directly
 * in the alphabet — no escape needed.
 *
 * The surface column is conditioned on the gust column's same-period delta on the wire (gust
 * decodes first — see derive-gust-delta-codebooks.ts, which owns those tables and charges
 * sfc's wire cost); the [res][level 0] tables emitted here are sfc's FALLBACK for messages
 * without gust in vars_mask, so their costBits stay 0 like 600/700's.
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
 *   pnpm exec tsx packages/codec-server/scripts/derive-wind-speed-delta-codebooks.ts
 */
import { aggregateHourly, toFullPeriod, HOURS_PER_PERIOD } from "../src/forecast.ts";
import { VARS_BIT, type Period } from "@weather/protocol";
import {
  deriveCounts, tableOffsets, rowAt, rowCostBits, scaledWeights, runStandalone, quantWind,
  type CellCounter, type DerivedTables,
} from "./derive-lib.ts";

const NRES = 5;
const NLEVEL = 4;                  // sfc, 500, 600, 700
const NBUCKET = 5;                 // upper Δ buckets: ≤-2, -1, 0, +1, ≥+2
const SPEED_MAX = 17;              // extended Beaufort force domain, must match v2.ts
const NSYM = 2 * SPEED_MAX + 1;    // 35: deltas -17..17
const WIND_MASK = (1 << VARS_BIT.wind) | (1 << VARS_BIT.w500) | (1 << VARS_BIT.w600) | (1 << VARS_BIT.w700);
const SPEED_FIELDS = ["wind_sfc_kph", "wind_500_kph", "wind_600_kph", "wind_700_kph"] as const;
const UPPER_OF = [-1, -1, 1, 2];   // 600 | 500Δ, 700 | 600Δ — must match v2.ts
// [res][level] wire cost: only 500 encodes there in corpus conditions — sfc is charged under
// the gust script's conditioned tables (gust always present in counting), 600/700 under the
// upper-Δ tables. A symbol is never charged twice.
const CHARGED = [false, true, false, false];

const qSpeed = (kph: number | undefined, _level: number) => quantWind(kph);
// must match upperDeltaBucket in entropy.ts
const dBucket = (d: number) => (d <= -2 ? 0 : d === -1 ? 1 : d === 0 ? 2 : d === 1 ? 3 : 4);

export function counter(): CellCounter {
  const tables = [
    { name: "windSpeedDelta", dims: [NRES, NLEVEL, NSYM] },
    { name: "windSpeedUpperDelta", dims: [NRES, NBUCKET, NSYM] },
  ];
  const { offsets, nSlots } = tableOffsets(tables);
  const LEVEL = offsets.windSpeedDelta, UPPER = offsets.windSpeedUpperDelta;
  const sum = (r: number[]) => r.reduce((a, b) => a + b, 0);

  // byLevel[res][level] rows plus the per-res pooled marginal (the empty-row fallback).
  const levelRows = (counts: ArrayLike<number>): { rows: number[][]; marginal: number[] }[] =>
    Array.from({ length: NRES }, (_, res) => {
      const rows = Array.from({ length: NLEVEL }, (_, l) =>
        rowAt(counts, LEVEL + (res * NLEVEL + l) * NSYM, NSYM));
      const marginal = new Array<number>(NSYM).fill(0);
      for (const row of rows) for (let s = 0; s < NSYM; s++) marginal[s] += row[s];
      return { rows, marginal };
    });

  return {
    tables, nSlots,
    countCell(ctx, add) {
      for (let resIdx = 0; resIdx < NRES; resIdx++) {
        // Periods anchored to the request hour, aggregated once per cell and shared with every
        // other counter using this anchoring.
        const slice = ctx.atRequest(resIdx);
        if (!slice) continue;
        const { n, rows } = slice;
        const periods: Period[] = rows.map((r) => toFullPeriod(r, WIND_MASK, "US", resIdx));
        const sp = SPEED_FIELDS.map((f, L) => periods.map((p) => qSpeed((p as any)[f], L)));
        for (let L = 0; L < NLEVEL; L++) {
          const U = UPPER_OF[L];
          for (let p = 1; p < n; p++) {
            const sym = sp[L][p] - sp[L][p - 1] + SPEED_MAX;
            add(LEVEL + (resIdx * NLEVEL + L) * NSYM + sym);
            if (U >= 0) add(UPPER + (resIdx * NBUCKET + dBucket(sp[U][p] - sp[U][p - 1])) * NSYM + sym);
          }
        }
      }
    },
    tablesFrom(counts): DerivedTables {
      // Empty rows (rare tails at coarse resolutions) fall back to the resolution's pooled marginal.
      const byRes = levelRows(counts);
      return {
        WIND_SPEED_DELTA_WEIGHTS_BY_RES_LEVEL: byRes.map(({ rows, marginal }) =>
          rows.map((row) => scaledWeights(sum(row) > 0 ? row : marginal))),
        WIND_SPEED_UPPER_DELTA_WEIGHTS_BY_RES: byRes.map(({ marginal }, res) =>
          Array.from({ length: NBUCKET }, (_, b) => {
            const row = rowAt(counts, UPPER + (res * NBUCKET + b) * NSYM, NSYM);
            return scaledWeights(sum(row) > 0 ? row : marginal);
          })),
      };
    },
    costBits(counts) {
      // See CHARGED above — only 500's [res][level] slots carry wire cost here.
      const L = new Float64Array(nSlots);
      const put = (start: number, row: number[]) => {
        const c = rowCostBits(scaledWeights(row));
        for (let s = 0; s < NSYM; s++) L[start + s] = c[s];
      };
      levelRows(counts).forEach(({ rows, marginal }, res) => {
        rows.forEach((row, l) => {
          if (!CHARGED[l]) return;
          put(LEVEL + (res * NLEVEL + l) * NSYM, sum(row) > 0 ? row : marginal);
        });
        for (let b = 0; b < NBUCKET; b++) {
          const row = rowAt(counts, UPPER + (res * NBUCKET + b) * NSYM, NSYM);
          put(UPPER + (res * NBUCKET + b) * NSYM, sum(row) > 0 ? row : marginal);
        }
      });
      return L;
    },
  };
}

export async function derive(precounted?: Float64Array): Promise<DerivedTables> {
  const c = counter();
  const counts = precounted ?? await deriveCounts(c);
  let samples = 0;
  for (let i = 0; i < c.tables[0].dims.reduce((a, b) => a * b, 1); i++) samples += counts[i];
  console.log(`Delta samples across 5 resolutions × 4 levels: ${samples}`);
  return c.tablesFrom(counts);
}

runStandalone(import.meta.url, derive);
