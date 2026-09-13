/**
 * Conditioning ladder for the three wet columns (precip chance, snow, rain): held-out (5-fold by
 * location) bits/period from an unconditioned table up through the shipped contexts and the
 * cross-variable candidates stacked on them. Columns decode in a fixed order (weathercode →
 * temp → freeze → clouds → precip → snow → rain → wind), so a later column may key its codebooks
 * on any earlier column's already-decoded same-period value for free.
 *
 * Rungs per column:
 *   pooled / prev          order-0, then order-1 on the previous decoded value (bucketed for the
 *                          accumulations: accumBucket, see derive-precipitation-codebooks.ts)
 *   × res                  resolution keyed
 *   × wcClass  ← shipped   same-period weathercode class {dry, rain, freezing, snow}
 *   snow + precipB         precip-chance bucket {0, 1-4, 5-7}
 *   rain + snow≠0          whether the same period carries snow
 *
 * OUTCOME (2026-07, re-measured 2026-08): wcClass took precip 0.978 → 0.876, snow 0.708 → 0.445,
 * rain 1.101 → 0.770 b/period. Stacking a second signal on the class (rain on snow≠0, snow on
 * the precip bucket) measured redundant with it and was not shipped.
 *
 * Transitions only (p ≥ 1): the per-column bootstrap is one symbol per message under a shared
 * table and does not move between rungs. Symbols are the wire's (3-bit chance in eighths,
 * 6-bit sqrt-companded accumulations), the weathercode class taken from the symbol the encoder
 * emits (WMO2IDX, unknown → 0) exactly as the wet columns key on it.
 *
 *   pnpm exec tsx packages/codec-server/scripts/analyze/precipitation.ts [--stride N]
 */
import { toFullPeriod } from "../../src/forecast.ts";
import {
  VAR, type Variable, WMO2IDX, WEATHERCODE_CLASS, WC_CLASSES, compandSqrt, SNOW_K, RAIN_K, ACCUM_BITS,
} from "@weather/protocol";
import { ACCUM_BUCKET_EDGES } from "../derive-precipitation-codebooks.ts";
import { NRES, argStride, eachColumn, heldOut, printLadder, runStandalone, type Rung } from "./lib.ts";

const WET_VARS: ReadonlySet<Variable> = new Set([VAR.precip, VAR.snow, VAR.rain]);
const N_PRECIP = 8;
const N_ACCUM = 1 << ACCUM_BITS; // 64
const N_ACCUM_B = ACCUM_BUCKET_EDGES.length + 1;
const accumBucket = (v: number) => { let b = 0; for (const e of ACCUM_BUCKET_EDGES) { if (v < e) break; b++; } return b; };
const precipBucket = (s: number) => (s === 0 ? 0 : s <= 4 ? 1 : 2);
const N_PRECIP_B = 3;
const clampInt = (v: number, width: number) => Math.min(Math.max(v, 0), (1 << width) - 1);

interface Chain {
  fold: number; res: number; n: number;
  wcClass: Uint8Array; precip: Uint8Array; snow: Uint8Array; rain: Uint8Array;
}

async function collectChains(stride: number): Promise<Chain[]> {
  const chains: Chain[] = [];
  await eachColumn({ vars: ["precipitation_probability", "rain", "showers", "snowfall", "weather_code"], stride }, (col) => {
    const periods = col.slice.rows.map((r) => toFullPeriod(r, WET_VARS, "US"));
    chains.push({
      fold: col.fold, res: col.res, n: col.slice.n,
      wcClass: Uint8Array.from(periods, (p) => WEATHERCODE_CLASS[WMO2IDX[p.weathercode] ?? 0]),
      precip: Uint8Array.from(periods, (p) => clampInt(Math.round((p.precip ?? 0) * 7 / 100), 3)),
      snow: Uint8Array.from(periods, (p) => compandSqrt(p.snow_cm ?? 0, SNOW_K, ACCUM_BITS)),
      rain: Uint8Array.from(periods, (p) => compandSqrt(p.rain_mm ?? 0, RAIN_K, ACCUM_BITS)),
    });
  });
  return chains;
}

type CtxOf = (c: Chain, p: number) => number;

function ladder(chains: Chain[], key: "precip" | "snow" | "rain", nsym: number, rungs: [string, number, CtxOf][]): Rung[] {
  return rungs.map(([label, nctx, ctxOf]) => ({
    label: `${label} (${nctx})`,
    result: heldOut({ nsym, nctx }, (add) => {
      for (const c of chains) for (let p = 1; p < c.n; p++) add(c.fold, c.res, ctxOf(c, p), c[key][p]);
    }),
  }));
}

export async function analyze(args: string[]): Promise<void> {
  const chains = await collectChains(argStride(args));
  console.log(`Columns (forecast × resolution): ${chains.length}`);
  const R = (c: Chain) => c.res;

  const precipPrev: CtxOf = (c, p) => c.precip[p - 1];
  const precipRes: CtxOf = (c, p) => R(c) * N_PRECIP + c.precip[p - 1];
  printLadder("precip chance: held-out bits/period (5-fold by location; transitions only)",
    ladder(chains, "precip", N_PRECIP, [
      ["pooled", 1, () => 0],
      ["prev", N_PRECIP, precipPrev],
      ["res × prev", NRES * N_PRECIP, precipRes],
      ["res × prev × wcClass ← shipped", NRES * N_PRECIP * WC_CLASSES, (c, p) => precipRes(c, p) * WC_CLASSES + c.wcClass[p]],
    ]));

  for (const key of ["snow", "rain"] as const) {
    const prevB: CtxOf = (c, p) => accumBucket(c[key][p - 1]);
    const resB: CtxOf = (c, p) => R(c) * N_ACCUM_B + prevB(c, p);
    const shipped: CtxOf = (c, p) => resB(c, p) * WC_CLASSES + c.wcClass[p];
    const stacked: [string, number, CtxOf][] = key === "snow"
      ? [
        ["res × prevB × precipB", NRES * N_ACCUM_B * N_PRECIP_B, (c, p) => resB(c, p) * N_PRECIP_B + precipBucket(c.precip[p])],
        ["res × prevB × wcClass × precipB", NRES * N_ACCUM_B * WC_CLASSES * N_PRECIP_B, (c, p) => shipped(c, p) * N_PRECIP_B + precipBucket(c.precip[p])],
      ]
      : [
        ["res × prevB × snow≠0", NRES * N_ACCUM_B * 2, (c, p) => resB(c, p) * 2 + (c.snow[p] > 0 ? 1 : 0)],
        ["res × prevB × wcClass × snow≠0", NRES * N_ACCUM_B * WC_CLASSES * 2, (c, p) => shipped(c, p) * 2 + (c.snow[p] > 0 ? 1 : 0)],
      ];
    printLadder(`${key}: held-out bits/period (5-fold by location; transitions only)`,
      ladder(chains, key, N_ACCUM, [
        ["pooled", 1, () => 0],
        ["prevB", N_ACCUM_B, prevB],
        ["res × prevB", NRES * N_ACCUM_B, resB],
        ["res × prevB × wcClass ← shipped", NRES * N_ACCUM_B * WC_CLASSES, shipped],
        ...stacked,
      ]));
  }
}

runStandalone(import.meta.url, analyze);
