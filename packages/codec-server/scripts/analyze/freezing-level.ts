/**
 * Freezing-level conditioning ladder: held-out (5-fold by location) bits/period for the
 * freeze-delta column from a pooled table up through the shipped context. Temp decodes before
 * freeze, so the SAME period's decoded temp delta is free context: the freezing level is where
 * the 0 °C isotherm sits, so it moves with the airmass temperature.
 *
 * Rungs:
 *   pooled                 one table
 *   res                    resolution keyed
 *   tempΔB                 same-period temp delta bucket {≤-2, -1, 0, +1, ≥+2} (tempDeltaBucket)
 *   res × tempΔB  ← shipped
 *
 * OUTCOME (2026-08, after the anchor widened to 5 bits): pooled 1.445 → res 1.393 →
 * res × tempΔ 1.308 b/period, occupancy min 858. Under the old 4-bit anchor, whose 15,000 ft cap
 * real forecasts clipped at, the same rung had measured −0.131 and was deferred.
 *
 * Transitions only (p ≥ 1). Quantization mirrors wire.ts quantFreeze (1000 ft steps, clamped to
 * 0..31); the temp bucket comes from the clamped reconstruction delta the decoder sees.
 *
 *   pnpm exec tsx packages/codec-server/scripts/analyze/freezing-level.ts [--stride N]
 */
import { toFullPeriod } from "../../src/forecast.ts";
import {
  VAR, type Variable, tempDeltaBucket, TEMP_DELTA_PREV_BUCKETS, TEMP_DELTA_MIN, TEMP_DELTA_MAX,
  FREEZE_DELTA_MAX,
} from "@weather/protocol";
import { NRES, argStride, eachColumn, heldOut, printLadder, runStandalone, type Rung } from "./lib.ts";

const STEP_M = 304.8; // 1000 ft, must match wire.ts
const NSYM = 2 * FREEZE_DELTA_MAX + 1; // 63: deltas -31..31
const N_TEMP_B = TEMP_DELTA_PREV_BUCKETS;
const FREEZE_VARS: ReadonlySet<Variable> = new Set([VAR.temp, VAR.freeze]);
const quantFreeze = (m: number) => Math.min(Math.max(Math.floor(m / STEP_M + 1e-9), 0), FREEZE_DELTA_MAX);
const quantTemp = (c: number) => Math.min(Math.max(Math.round(c + 100), 0), 255);

interface Chain { fold: number; res: number; n: number; freeze: Uint8Array; tempB: Int8Array }

async function collectChains(stride: number): Promise<Chain[]> {
  const chains: Chain[] = [];
  await eachColumn({ vars: ["temperature_2m", "freezing_level_height"], stride }, (col) => {
    const periods = col.slice.rows.map((r) => toFullPeriod(r, FREEZE_VARS, "US"));
    const n = col.slice.n;
    const tempB = new Int8Array(n).fill(-1);
    let recon = quantTemp(periods[0].temp_c ?? 0);
    for (let p = 1; p < n; p++) {
      const delta = Math.min(Math.max(quantTemp(periods[p].temp_c ?? 0) - recon, TEMP_DELTA_MIN), TEMP_DELTA_MAX);
      recon += delta;
      tempB[p] = tempDeltaBucket(delta);
    }
    chains.push({ fold: col.fold, res: col.res, n, freeze: Uint8Array.from(periods, (p) => quantFreeze(p.freeze_m ?? 0)), tempB });
  });
  return chains;
}

export async function analyze(args: string[]): Promise<void> {
  const chains = await collectChains(argStride(args));
  console.log(`Columns (forecast × resolution): ${chains.length}`);
  const rungs: [string, number, (c: Chain, p: number) => number][] = [
    ["pooled", 1, () => 0],
    ["res", NRES, (c) => c.res],
    ["tempΔB", N_TEMP_B, (c, p) => c.tempB[p]],
    ["res × tempΔB ← shipped", NRES * N_TEMP_B, (c, p) => c.res * N_TEMP_B + c.tempB[p]],
  ];
  const ladder: Rung[] = rungs.map(([label, nctx, ctxOf]) => ({
    label: `${label} (${nctx})`,
    result: heldOut({ nsym: NSYM, nctx }, (add) => {
      for (const c of chains) for (let p = 1; p < c.n; p++)
        add(c.fold, c.res, ctxOf(c, p), c.freeze[p] - c.freeze[p - 1] + FREEZE_DELTA_MAX);
    }),
  }));
  printLadder("freezing level: held-out bits/period (5-fold by location; transitions only)", ladder);
}

runStandalone(import.meta.url, analyze);
