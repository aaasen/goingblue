/**
 * Derive wind-direction codebooks: order-1 transition tables keyed by resolution, plus
 * upper-level-conditioned tables for the pressure-level columns, keyed by the ladder gap to the
 * served level above (windGapClass in entropy.ts — the reader picks any subset of the eight
 * WIND_LEVELS_HPA levels, so every (lower, upper) pair of the ladder is counted under its gap).
 *
 * Three context schemes were compared held-out (5-fold, split by location, rANS cost — see
 * analyze-wind-heldout.ts):
 *
 *   prev only, trained at 1h, applied everywhere (old design):  3.04 (24h) … 0.76 (1h) b/dir
 *   [res][prev]:                                                2.15 (24h) … 0.76 (1h)
 *   [res][prev × same-period upper dir] (w600/w700):            1.21 (24h) … 0.64 (1h)
 *
 * Resolution keying pays because direction persistence falls sharply with the aggregation step
 * (P(next=prev) ≈ 0.85 at 1h vs ≈ 0.55 at 6h) — the shipped 1h-only table was overconfident at
 * coarser resolutions, which rANS (unlike Huffman's integer rounding) faithfully charges for.
 * The full 64-context upper conditioning beat a compact circular-distance variant at every
 * resolution held-out, so it earns its table count. Resolution and the upper column's decoded
 * value are context both sides already have, so none of this costs wire bits.
 *
 * Sequences are collected under calm gating (no direction symbol when the quantized speed is 0;
 * the context chain carries the last encoded direction), matching the wire behavior in v3.ts.
 * The bootstrap table (a column's first encoded direction, no predecessor) is shared across
 * resolutions and levels — it fires once per column, so keying it isn't worth the tables.
 *
 * The [res][prev] transition counts are kept in two ranges — sfc + the top level vs the levels
 * below it — because on the wire a lower level's symbol is coded under the upper-conditioned
 * table whenever a level above is served (always, in corpus counting), so per-cell cost
 * accounting must not charge it under [res][prev] too. The SHIPPED [res][prev] tables still pool
 * every level (their sum).
 *
 * Tables land in packages/protocol/src/codebooks.gen.ts via `pnpm generate`; run standalone
 * (below) to derive and print without writing:
 *
 *   pnpm exec tsx packages/codec-server/scripts/derive-wind-dir-codebooks.ts
 */
import { aggregateHourly, toFullPeriod, HOURS_PER_PERIOD } from "../src/forecast.ts";
import {
  VARS_BIT, TABLE_RES_IDXS, WIND_LEVELS_HPA, WIND_LEVELS_MASK, N_WIND_GAPS, windGapClass,
  type Period,
} from "@weather/protocol";
import {
  deriveCounts, tableOffsets, rowAt, rowCostBits, scaledWeights, runStandalone,
  quantWind, CALM_MAX_FORCE,
  type CellCounter, type DerivedTables,
} from "./derive-lib.ts";

const NDIR = 8;
const NRES = TABLE_RES_IDXS.length; // 12h/6h/3h/1h — the resolutions layouts emit, in row order
const NGAP = N_WIND_GAPS;
const NLEVEL = 1 + WIND_LEVELS_HPA.length; // sfc, then the ladder (300 hPa … 1000 hPa)
const WIND_MASK = (1 << VARS_BIT.wind) | WIND_LEVELS_MASK;
const speedOf = (p: Period, L: number): number | undefined =>
  L === 0 ? p.wind_sfc_kph : p.wind_aloft?.[L - 1]?.kph;
const dirOf = (p: Period, L: number): number | undefined =>
  L === 0 ? p.wind_sfc_dir : p.wind_aloft?.[L - 1]?.dir;
// Speeds only feed the calm gate here (force ≤ CALM_MAX_FORCE ⇒ no direction symbol), but the
// gate must mirror the wire's own quantization (extended Beaufort, quantWind) or the trained
// tables see a different symbol stream.
const qSpeed = (kph: number | undefined) => quantWind(kph);

export function counter(): CellCounter {
  const tables = [
    { name: "windDirBootstrap", dims: [NDIR] },
    { name: "windDirTransLow", dims: [NRES, NDIR, NDIR] },   // sfc + the top level
    { name: "windDirTransHigh", dims: [NRES, NDIR, NDIR] },  // lower levels (upper table on wire)
    { name: "windDirUpper", dims: [NRES, NGAP, NDIR * NDIR, NDIR] },
  ];
  const { offsets, nSlots } = tableOffsets(tables);
  const BOOT = offsets.windDirBootstrap, LOW = offsets.windDirTransLow,
    HIGH = offsets.windDirTransHigh, UPPER = offsets.windDirUpper;
  const sum = (r: number[]) => r.reduce((a, b) => a + b, 0);

  // trans[res][prev][next] pooled over all levels (low + high ranges), plus its per-res marginal.
  const transRows = (counts: ArrayLike<number>): { rows: number[][]; marginal: number[] }[] =>
    Array.from({ length: NRES }, (_, res) => {
      const rows = Array.from({ length: NDIR }, (_, prev) => {
        const row = rowAt(counts, LOW + (res * NDIR + prev) * NDIR, NDIR);
        for (let s = 0; s < NDIR; s++) row[s] += counts[HIGH + (res * NDIR + prev) * NDIR + s];
        return row;
      });
      const marginal = new Array<number>(NDIR).fill(0);
      for (const row of rows) for (let s = 0; s < NDIR; s++) marginal[s] += row[s];
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
        const dr = Array.from({ length: NLEVEL }, (_, L) => periods.map((p) => (dirOf(p, L) ?? 0) % 8));
        // Displayed dir under calm gating: last encoded dir, 0 before any (mirrors v3.ts).
        const disp = sp.map((_, L) => {
          let eff = 0;
          return periods.map((_, p) => (sp[L][p] > CALM_MAX_FORCE ? (eff = dr[L][p]) : eff));
        });
        for (let L = 0; L < NLEVEL; L++) {
          const TRANS = L >= 2 ? HIGH : LOW;
          let prev: number | null = null;
          for (let p = 0; p < n; p++) {
            if (sp[L][p] <= CALM_MAX_FORCE) continue; // calm (< 6 kph): no symbol on the wire
            const d = dr[L][p];
            if (prev === null) add(BOOT + d);
            else {
              add(TRANS + (resIdx * NDIR + prev) * NDIR + d);
              // Every pressure level above this one is a possible conditioning level on the
              // wire (the reader picks the subset); count the pair under its gap class.
              for (let U = 1; U < L; U++) {
                const g = windGapClass(L - U);
                add(UPPER + ((resIdx * NGAP + g) * NDIR * NDIR + prev * NDIR + disp[U][p]) * NDIR + d);
              }
            }
            prev = d;
          }
        }
      }
    },
    tablesFrom(counts): DerivedTables {
      // Thin/unseen contexts fall back to broader priors so every table stays representable:
      // an empty [res][prev] row borrows the resolution's marginal; an empty [res][prev×u] row
      // borrows its [res][prev] row.
      const trans = transRows(counts);
      return {
        WIND_DIR_BOOTSTRAP_WEIGHTS: scaledWeights(rowAt(counts, BOOT, NDIR)),
        WIND_DIR_WEIGHTS_BY_RES: trans.map(({ rows, marginal }) =>
          rows.map((row) => scaledWeights(sum(row) > 0 ? row : marginal))),
        // [res][gap × prev × upper], gap-major (windDirBook in entropy.ts indexes it that way).
        WIND_DIR_UPPER_WEIGHTS_BY_RES: trans.map(({ rows }, res) =>
          Array.from({ length: NGAP * NDIR * NDIR }, (_, gctx) => {
            const row = rowAt(counts, UPPER + (res * NGAP * NDIR * NDIR + gctx) * NDIR, NDIR);
            return scaledWeights(sum(row) > 0 ? row : rows[Math.floor(gctx / NDIR) % NDIR]);
          })),
      };
    },
    costBits(counts) {
      // Wire cost: low-range symbols under the pooled [res][prev] tables, lower levels' under
      // the upper-conditioned tables — their [res][prev] (high-range) slots stay 0 so a symbol is
      // never charged twice.
      const L = new Float64Array(nSlots);
      const put = (start: number, row: number[]) => {
        const c = rowCostBits(scaledWeights(row));
        for (let s = 0; s < NDIR; s++) L[start + s] = c[s];
      };
      put(BOOT, rowAt(counts, BOOT, NDIR));
      transRows(counts).forEach(({ rows, marginal }, res) => {
        rows.forEach((row, prev) =>
          put(LOW + (res * NDIR + prev) * NDIR, sum(row) > 0 ? row : marginal));
        // Only the adjacent-gap class carries wire cost: the benchmark request serves every
        // level, so each conditions on the rung above.
        for (let ctx = 0; ctx < NDIR * NDIR; ctx++) {
          const start = UPPER + (res * NGAP * NDIR * NDIR + ctx) * NDIR;
          const row = rowAt(counts, start, NDIR);
          put(start, sum(row) > 0 ? row : rows[Math.floor(ctx / NDIR)]);
        }
      });
      return L;
    },
  };
}

export async function derive(precounted?: Float64Array): Promise<DerivedTables> {
  const c = counter();
  const counts = precounted ?? await deriveCounts(c);
  let symbols = 0;
  const { offsets } = tableOffsets(c.tables);
  // Every emission lands exactly once in bootstrap/low/high (upper double-counts high symbols).
  for (let i = offsets.windDirBootstrap; i < offsets.windDirUpper; i++) symbols += counts[i];
  console.log(`Encoded (calm-gated) direction symbols across 5 resolutions: ${symbols}`);
  return c.tablesFrom(counts);
}

runStandalone(import.meta.url, derive);
