/**
 * Derive wind-speed-delta codebooks keyed by (resolution, level), plus upper-Δ-conditioned
 * tables for the pressure-level columns — keyed by the ladder gap to the level they condition on.
 *
 * The quantized speed domain is the extended Beaufort scale, forces 0..17, for EVERY wind
 * column (see quantWind in derive-lib.ts / v4.ts — chosen 2026-07-31 over linear and other
 * companded scales, analyze-wind-scale-heldout.ts). Deltas -17..17 (35 symbols) fit directly
 * in the alphabet — no escape needed.
 *
 * The surface column is conditioned on the gust column's same-period delta on the wire (gust
 * decodes first — see derive-gust-delta-codebooks.ts, which owns those tables and charges
 * sfc's wire cost); the [res][level 0] tables emitted here are sfc's FALLBACK for messages
 * without gust in vars_mask, so their costBits stay 0.
 *
 * Schemes compared held-out (5-fold, split by location, rANS cost — see analyze-wind-heldout.ts):
 *
 *   pooled levels, trained at 1h, applied everywhere (old design): 4.45 (24h) … 1.46 (1h) b/Δ
 *   [res][level]:                                                  3.21 (24h) … 1.44 (1h)
 *   [res][bucket(upper same-period Δ)] (w600/w700):                2.99 (24h) … 1.45 (1h)
 *
 * Level keying pays because the pooled table taxed the surface column hardest (its deltas are
 * far more peaked than the jet levels'); resolution keying for the same reason as direction.
 * For a pressure level below the topmost served one, the served level above's already-decoded
 * same-period delta, bucketed to {≤-2, -1, 0, +1, ≥+2}, beats even the level-keyed tables —
 * adjacent pressure levels move together. Since 2026-08-22 the reader selects any subset of the
 * eight WIND_LEVELS_HPA levels, so the level above may sit one, two or more rungs up; the
 * conditioned tables are keyed by that gap class (windGapClass in entropy.ts) and trained on
 * every (lower, upper) pair of the ladder. All of these contexts are known to both sides, so
 * none cost wire bits.
 *
 * Tables land in packages/protocol/src/codebooks.gen.ts via `pnpm generate`; run standalone
 * (below) to derive and print without writing:
 *
 *   pnpm exec tsx packages/codec-server/scripts/derive-wind-speed-delta-codebooks.ts
 */
import { aggregateHourly, toFullPeriod, HOURS_PER_PERIOD } from "../src/forecast.ts";
import {
  VARS_BIT, TABLE_RES_IDXS, WIND_LEVELS_HPA, WIND_LEVELS_MASK, N_WIND_GAPS, windGapClass,
  type Period,
} from "@weather/protocol";
import {
  deriveCounts, tableOffsets, rowAt, rowCostBits, scaledWeights, runStandalone, quantWind,
  type CellCounter, type DerivedTables,
} from "./derive-lib.ts";

const NRES = TABLE_RES_IDXS.length; // 12h/6h/3h/1h — the resolutions layouts emit, in row order
const NLEVEL = 1 + WIND_LEVELS_HPA.length; // sfc, then the ladder (300 hPa … 1000 hPa)
const NBUCKET = 5;                 // upper Δ buckets: ≤-2, -1, 0, +1, ≥+2
const NGAP = N_WIND_GAPS;          // ladder gap to the conditioning level: 1, 2, 3+
const SPEED_MAX = 17;              // extended Beaufort force domain, must match v4.ts
const NSYM = 2 * SPEED_MAX + 1;    // 35: deltas -17..17
const WIND_MASK = (1 << VARS_BIT.wind) | WIND_LEVELS_MASK;
const speedOf = (p: Period, L: number): number | undefined =>
  L === 0 ? p.wind_sfc_kph : p.wind_aloft?.[L - 1]?.kph;
// [res][level] wire cost: only the topmost level (300 hPa) encodes there in corpus conditions
// (the benchmark's all-levels request) — sfc is charged under the gust script's conditioned
// tables (gust always present in counting), every other level under the adjacent-gap upper-Δ
// tables. A symbol is never charged twice.
const CHARGED = Array.from({ length: NLEVEL }, (_, L) => L === 1);

const qSpeed = (kph: number | undefined) => quantWind(kph);
// must match upperDeltaBucket in entropy.ts
const dBucket = (d: number) => (d <= -2 ? 0 : d === -1 ? 1 : d === 0 ? 2 : d === 1 ? 3 : 4);

export function counter(): CellCounter {
  const tables = [
    { name: "windSpeedDelta", dims: [NRES, NLEVEL, NSYM] },
    { name: "windSpeedUpperDelta", dims: [NRES, NGAP, NBUCKET, NSYM] },
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
        const slice = ctx.atRequest(TABLE_RES_IDXS[resIdx]);
        if (!slice) continue;
        const { n, rows } = slice;
        const periods: Period[] = rows.map((r) => toFullPeriod(r, WIND_MASK, "US", resIdx));
        const sp = Array.from({ length: NLEVEL }, (_, L) => periods.map((p) => qSpeed(speedOf(p, L))));
        for (let L = 0; L < NLEVEL; L++) {
          for (let p = 1; p < n; p++) {
            const sym = sp[L][p] - sp[L][p - 1] + SPEED_MAX;
            add(LEVEL + (resIdx * NLEVEL + L) * NSYM + sym);
            // Every pressure level above this one is a possible conditioning level on the wire
            // (the reader picks the subset); count the pair under its gap class.
            for (let U = 1; U < L; U++) {
              const g = windGapClass(L - U);
              add(UPPER + ((resIdx * NGAP + g) * NBUCKET + dBucket(sp[U][p] - sp[U][p - 1])) * NSYM + sym);
            }
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
        // [res][gap × bucket], gap-major (windSpeedBook in entropy.ts indexes it that way).
        WIND_SPEED_UPPER_DELTA_WEIGHTS_BY_RES: byRes.map(({ marginal }, res) =>
          Array.from({ length: NGAP * NBUCKET }, (_, gb) => {
            const row = rowAt(counts, UPPER + (res * NGAP * NBUCKET + gb) * NSYM, NSYM);
            return scaledWeights(sum(row) > 0 ? row : marginal);
          })),
      };
    },
    costBits(counts) {
      // See CHARGED above — only the top level's [res][level] slots carry wire cost here, and
      // of the upper tables only the adjacent-gap class (the benchmark request carries every
      // level, so each conditions on the rung above).
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
          const start = UPPER + (res * NGAP * NBUCKET + b) * NSYM; // gap class 0 = adjacent
          const row = rowAt(counts, start, NSYM);
          put(start, sum(row) > 0 ? row : marginal);
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
  console.log(`Delta samples across ${NRES} resolutions × ${NLEVEL} levels: ${samples}`);
  return c.tablesFrom(counts);
}

runStandalone(import.meta.url, derive);
