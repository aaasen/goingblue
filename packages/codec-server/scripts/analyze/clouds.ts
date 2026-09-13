/**
 * Cloud band conditioning ladder: held-out (5-fold by location) bits/period for the band's
 * column under per-level tables plus candidate free context. The column decodes level-major,
 * 300 hPa first, so when level l codes period p the level above (l−1) has already decoded its
 * ENTIRE chain: its same-period delta and value are free context, like the pressure-level wind
 * columns' upper-level keying. Level 0 (300 hPa) has no level above and keeps its
 * unconditioned row in every scheme.
 *
 * Only the serving resolutions are scanned: the wire clamps band symbols to ≤3h periods
 * (cloudBandPeriodCount in wire.ts), so 3h and 1h are the only spans a table will ever price.
 *
 * Candidates (all available to the decoder before the target symbol):
 *   nbrΔ       the level above's same-period delta, exact (15) or bucketed (upperDeltaBucket, 5)
 *   prevOwnB   the level's own previous VALUE, bucketed {0, 1-3, 4-7}: the rhCrit floor pins
 *              levels at exactly 0 for long runs, so "was clear" may reshape the delta
 *   prevOwn    the level's own previous value, exact: order-1 VALUE coding in delta clothes
 *              (prev + delta ↔ value), the model the precip/snow/rain columns ship   ← shipped
 *   res        3h vs 1h
 *
 * OUTCOME (2026-08-20): per-level pooled deltas 10.59 → per-level × prev exact 7.74 b/period
 * over the 8 levels (−27%); the vertical-neighbor delta added only −0.19 on top and was left
 * out; res keying added ~nothing (−0.09) at the resolutions that serve.
 *
 * Symbols are deltas of the quantized step (quantCover, 0..7); the cost is reported per PERIOD,
 * i.e. summed over the eight trained levels. An empty context row falls back to its level's
 * pooled row, so a thin context degrades to exactly the per-level table.
 *
 *   pnpm exec tsx packages/codec-server/scripts/analyze/clouds.ts [--stride N]
 *
 * --stride defaults to 5 (~20k train cells); --stride 1 scans the whole split.
 */
import { toFullPeriod } from "../../src/forecast.ts";
import {
  CLOUD_BAND_LEVELS_HPA, CLOUD_BAND_TRAINED_LEVEL_OFFSET, CLOUD_BAND_MAX_HOURS, RESOLUTION_HOURS,
  VAR, type Variable, quantCover, upperDeltaBucket, type Period,
} from "@weather/protocol";
import { CLOUD_FILL_OUTPUTS } from "../derive-lib.ts";
import { RES_IDXS, RES_LABEL, argStride, eachColumn, heldOut, printLadder, runStandalone, type Rung } from "./lib.ts";

const LEVEL_OFFSET = CLOUD_BAND_TRAINED_LEVEL_OFFSET;
const NLEVEL = CLOUD_BAND_LEVELS_HPA.length - LEVEL_OFFSET; // 8, 300 hPa … 1000 hPa
const NSYM = 15; // deltas -7..7
const N_NBR_B = 5; // upperDeltaBucket domain
const prevOwnBucket = (q: number) => (q === 0 ? 0 : q <= 3 ? 1 : 2);
const N_PREV_B = 3;
const CLOUD_VARS: ReadonlySet<Variable> = new Set([VAR.clouds]);
// The band's serving resolutions, as RES_IDXS rows, derived from the wire's own clamp.
const SERVING_ROWS = RES_IDXS.map((r, i) => i).filter((i) => RESOLUTION_HOURS[RES_IDXS[i]] <= CLOUD_BAND_MAX_HOURS);
const NGROUP = SERVING_ROWS.length;

interface Chain { fold: number; group: number; n: number; q: Uint8Array[] } // q[level][period]

async function collectChains(stride: number): Promise<Chain[]> {
  const chains: Chain[] = [];
  await eachColumn({
    vars: ["cloud_cover_high", "cloud_cover_mid", "cloud_cover_low", ...CLOUD_FILL_OUTPUTS],
    stride, resRows: SERVING_ROWS,
  }, (col) => {
    const periods: Period[] = col.slice.rows.map((r) => toFullPeriod(r, CLOUD_VARS, "US"));
    chains.push({
      fold: col.fold, group: SERVING_ROWS.indexOf(col.res), n: col.slice.n,
      q: Array.from({ length: NLEVEL }, (_, li) =>
        Uint8Array.from(periods, (p) => quantCover(p.cloud_band?.[li + LEVEL_OFFSET]))),
    });
  });
  return chains;
}

// The level above's same-period delta; level 0 reports the "no change" value, so its rows for
// other values stay empty and it effectively keeps one unconditioned row.
const nbrDelta = (c: Chain, li: number, p: number) => (li === 0 ? 0 : c.q[li - 1][p] - c.q[li - 1][p - 1]);
const nbrB = (c: Chain, li: number, p: number) => (li === 0 ? 2 : upperDeltaBucket(nbrDelta(c, li, p)));

type CtxOf = (c: Chain, li: number, p: number) => number;

function rung(chains: Chain[], label: string, nctxPerLevel: number, ctxOf: CtxOf): Rung {
  const result = heldOut({
    nsym: NSYM, nctx: NLEVEL * nctxPerLevel, nGroup: NGROUP,
    fallbackOf: (ctx) => Math.floor(ctx / nctxPerLevel),
  }, (add) => {
    for (const c of chains) for (let li = 0; li < NLEVEL; li++) {
      const q = c.q[li];
      for (let p = 1; p < c.n; p++) add(c.fold, c.group, li * nctxPerLevel + ctxOf(c, li, p), q[p] - q[p - 1] + 7);
    }
  });
  // Per PERIOD: every level's symbol.
  const scale = <T extends { bpp: number }>(x: T): T => ({ ...x, bpp: x.bpp * NLEVEL });
  return {
    label: `${label} (${NLEVEL * nctxPerLevel})`,
    result: { ...scale(result), byGroup: result.byGroup.map(scale), byFold: result.byFold.map((b) => b * NLEVEL) },
  };
}

export async function analyze(args: string[]): Promise<void> {
  const stride = argStride(args, 5);
  const chains = await collectChains(stride);
  console.log(`Columns (forecast × resolution): ${chains.length} (stride ${stride})`);
  const res2 = (c: Chain) => c.group;
  const rungs: Rung[] = [
    rung(chains, "per-level pooled", 1, () => 0),
    rung(chains, "+ res", NGROUP, res2),
    rung(chains, "+ prevOwnB", N_PREV_B, (c, li, p) => prevOwnBucket(c.q[li][p - 1])),
    rung(chains, "+ nbrΔB", N_NBR_B, nbrB),
    rung(chains, "+ nbrΔ exact", NSYM, (c, li, p) => (li === 0 ? 7 : nbrDelta(c, li, p) + 7)),
    rung(chains, "+ nbrΔB × prevOwnB", N_NBR_B * N_PREV_B, (c, li, p) => nbrB(c, li, p) * N_PREV_B + prevOwnBucket(c.q[li][p - 1])),
    rung(chains, "+ nbrΔ exact × prevOwnB", NSYM * N_PREV_B,
      (c, li, p) => (li === 0 ? 7 : nbrDelta(c, li, p) + 7) * N_PREV_B + prevOwnBucket(c.q[li][p - 1])),
    rung(chains, "+ prevOwn exact ← shipped", 8, (c, li, p) => c.q[li][p - 1]),
    rung(chains, "+ prevOwn exact × nbrΔB", 8 * N_NBR_B, (c, li, p) => c.q[li][p - 1] * N_NBR_B + nbrB(c, li, p)),
    rung(chains, "+ prevOwn exact × res", 8 * NGROUP, (c, li, p) => c.q[li][p - 1] * NGROUP + res2(c)),
  ];
  printLadder(`cloud band: held-out bits/period (5-fold by location; all ${NLEVEL} levels, transitions only)`,
    rungs, SERVING_ROWS.map((i) => RES_LABEL[i]));
}

runStandalone(import.meta.url, analyze);
