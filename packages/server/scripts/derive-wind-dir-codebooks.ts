/**
 * Derive wind-direction codebooks: order-1 transition tables keyed by resolution, plus
 * upper-level-conditioned tables for the 600/700 hPa columns.
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
 * the context chain carries the last encoded direction), matching the wire behavior in v1.ts.
 * The bootstrap table (a column's first encoded direction, no predecessor) is shared across
 * resolutions and levels — it fires once per column, so keying it isn't worth the tables.
 *
 * Tables land in packages/protocol/src/codebooks.gen.ts via `pnpm generate`; run standalone
 * (below) to derive and print without writing:
 *
 *   node packages/server/scripts/derive-wind-dir-codebooks.ts
 */
import { aggregateHourly, toFullPeriod, HOURS_PER_PERIOD } from "../src/forecast.ts";
import { VARS_BIT, type Period } from "@weather/protocol";
import { eachForecast, scaledWeights, runStandalone, type DerivedTables } from "./derive-lib.ts";

const NDIR = 8;
const NRES = 5; // resolution indices 0..4 (24h/12h/6h/3h/1h)
const WIND_MASK = (1 << VARS_BIT.wind) | (1 << VARS_BIT.w500) | (1 << VARS_BIT.w600) | (1 << VARS_BIT.w700);
const SPEED_FIELDS = ["wind_sfc_kph", "wind_500_kph", "wind_600_kph", "wind_700_kph"] as const;
const DIR_FIELDS = ["wind_sfc_dir", "wind_500_dir", "wind_600_dir", "wind_700_dir"] as const;
// level -> the level it conditions on when present (already decoded), or -1 (see v1.ts)
const UPPER_OF = [-1, -1, 1, 2];
const KPH_PER_STEP = 5 * 1.609344; // must match v1.ts
const SPEED_MAX = 31;              // must match v1.ts (WIND_SPEED_BITS = 5)

const qSpeed = (kph: number | undefined) =>
  Math.min(Math.floor(((kph ?? 0) / KPH_PER_STEP) + 1e-9), SPEED_MAX);

export async function derive(): Promise<DerivedTables> {
  const firstCounts = new Array(NDIR).fill(0);
  // trans[res][prev][next], all levels pooled; upper[res][prev*8+u][next], w600/w700 only.
  const trans = Array.from({ length: NRES }, () =>
    Array.from({ length: NDIR }, () => new Array(NDIR).fill(0)));
  const upper = Array.from({ length: NRES }, () =>
    Array.from({ length: NDIR * NDIR }, () => new Array(NDIR).fill(0)));
  let symbols = 0;

  await eachForecast((h, startHour) => {
    for (let resIdx = 0; resIdx < NRES; resIdx++) {
      const hpp = HOURS_PER_PERIOD[resIdx];
      const start = Math.floor(startHour / hpp) * hpp;
      const n = Math.floor(h.time.length / hpp);
      if (n < 2) continue;
      const rows = aggregateHourly(h, h.time, n, resIdx, start);
      const periods: Period[] = rows.map((r) => toFullPeriod(r, WIND_MASK, "GFS", resIdx));
      const sp = SPEED_FIELDS.map((f) => periods.map((p) => qSpeed((p as any)[f])));
      const dr = DIR_FIELDS.map((f) => periods.map((p) => (((p as any)[f] as number) ?? 0) % 8));
      // Displayed dir under calm gating: last encoded dir, 0 before any (mirrors v1.ts).
      const disp = SPEED_FIELDS.map((_, L) => {
        let eff = 0;
        return periods.map((_, p) => (sp[L][p] > 0 ? (eff = dr[L][p]) : eff));
      });
      for (let L = 0; L < SPEED_FIELDS.length; L++) {
        const U = UPPER_OF[L];
        let prev: number | null = null;
        for (let p = 0; p < n; p++) {
          if (sp[L][p] === 0) continue; // calm: no symbol on the wire
          const d = dr[L][p];
          symbols++;
          if (prev === null) firstCounts[d]++;
          else {
            trans[resIdx][prev][d]++;
            if (U >= 0) upper[resIdx][prev * NDIR + disp[U][p]][d]++;
          }
          prev = d;
        }
      }
    }
  });
  console.log(`Encoded (calm-gated) direction symbols across 5 resolutions: ${symbols}`);

  // Thin/unseen contexts fall back to broader priors so every table stays representable:
  // an empty [res][prev] row borrows the resolution's marginal; an empty [res][prev×u] row
  // borrows its [res][prev] row.
  const marginal = trans.map((byPrev) => {
    const m = new Array(NDIR).fill(0);
    for (const row of byPrev) for (let i = 0; i < NDIR; i++) m[i] += row[i];
    return m;
  });
  const sum = (r: number[]) => r.reduce((a, b) => a + b, 0);
  const byRes = trans.map((byPrev, res) =>
    byPrev.map((row) => scaledWeights(sum(row) > 0 ? row : marginal[res])));
  const upperByRes = upper.map((byCtx, res) =>
    byCtx.map((row, ctx) => scaledWeights(sum(row) > 0 ? row : trans[res][Math.floor(ctx / NDIR)])));

  return {
    WIND_DIR_BOOTSTRAP_WEIGHTS: scaledWeights(firstCounts),
    WIND_DIR_WEIGHTS_BY_RES: byRes,
    WIND_DIR_UPPER_WEIGHTS_BY_RES: upperByRes,
  };
}

runStandalone(import.meta.url, derive);
