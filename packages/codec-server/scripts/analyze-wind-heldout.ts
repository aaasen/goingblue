/**
 * Held-out (5-fold, split by location) comparison of candidate wind coding schemes, under the
 * real coder's cost model (rANS quantized-frequency cross-entropy). Decides which contexts earn
 * wire tables before any codebook is frozen:
 *
 *   dir:   cur  = prev-keyed, trained at 1h, applied to every resolution (shipped design)
 *          a    = [res][prev]                       (resolution-keyed)
 *          b    = [res][prev][upper dir]            (full 64-context, w600/w700 only)
 *          c    = [res][prev][circular dist 0/1/2+] (compact upper context, w600/w700 only)
 *   speed: cur  = pooled levels, trained at 1h, applied everywhere (shipped design, new alphabet)
 *          a    = [res][level]
 *          b    = [res][bucket(upper Δt)] pooled over w600/w700 (upper-conditioned)
 *
 * Direction sequences are collected under calm gating (no symbol when quantized speed = 0; the
 * context chain carries the last encoded direction), matching the planned wire behavior.
 *
 *   node scripts/analyze-wind-heldout.ts
 */
import { aggregateHourly, toFullPeriod, HOURS_PER_PERIOD, type HourlyData } from "../src/forecast.ts";
import { eachForecast, foldOf, N_FOLDS, scaledWeights } from "./derive-lib.ts";
import { quantizeFreqs, RANS_PROB_BITS, VARS_BIT, type Period } from "@weather/protocol";

const WIND_MASK = (1 << VARS_BIT.wind) | (1 << VARS_BIT.w500) | (1 << VARS_BIT.w600) | (1 << VARS_BIT.w700);
// STALE (2026-07-31): this scan predates the extended-Beaufort wire (quantWind in v1.ts) and
// still quantizes linearly — its recorded conclusions stand, but re-derive the chains against
// quantWind before trusting fresh numbers. See analyze-wind-scale-heldout.ts for the scale scan.
const STEP_OF = [5, 5 * 1.609344, 5 * 1.609344, 5 * 1.609344];
const SPEED_MAX = 31;                    // 0..31 steps per level
const NSPD = 2 * SPEED_MAX + 1;          // deltas -31..31
const NDIR = 8;
const RES_INDICES = [0, 1, 2, 3, 4];
const LEVELS = ["sfc", "500", "600", "700"] as const;
const SPEED_FIELDS = ["wind_sfc_kph", "wind_500_kph", "wind_600_kph", "wind_700_kph"] as const;
const DIR_FIELDS = ["wind_sfc_dir", "wind_500_dir", "wind_600_dir", "wind_700_dir"] as const;
// level -> index of the level it may condition on (already decoded), or -1
const UPPER_OF = [-1, -1, 1, 2];

const qSpeed = (kph: number | undefined, level: number) =>
  Math.min(Math.floor(((kph ?? 0) / STEP_OF[level]) + 1e-9), SPEED_MAX);
const dBucket = (d: number) => (d <= -2 ? 0 : d === -1 ? 1 : d === 0 ? 2 : d === 1 ? 3 : 4);
const circDist = (a: number, b: number) => Math.min((a - b + 8) % 8, (b - a + 8) % 8);

// counts[fold] -> Map<ctx, number[]>
type FoldCounts = Map<string, number[]>[];
const newFolds = (): FoldCounts => Array.from({ length: N_FOLDS }, () => new Map());
const bump = (fc: FoldCounts, fold: number, ctx: string, sym: number, n: number): void => {
  let arr = fc[fold].get(ctx);
  if (!arr) { arr = new Array(n).fill(0); fc[fold].set(ctx, arr); }
  arr[sym]++;
};

const dirP = newFolds();   // res|prev -> next          (all levels, gated)
const dirJ = newFolds();   // res|prev|upper -> next    (w600/w700, gated)
const dirC = newFolds();   // res|prev|dist -> next     (w600/w700, gated)
const spdL = newFolds();   // res|level -> delta        (all levels)
const spdPool = newFolds();// res -> delta              (all levels pooled)
const spdU = newFolds();   // res|bucket -> delta       (w600/w700)

await eachForecast((hourly: HourlyData, runHour: number, loc: string) => {
  const fold = foldOf(loc);
  for (const resIdx of RES_INDICES) {
    const hpp = HOURS_PER_PERIOD[resIdx];
    const start = Math.floor(runHour / hpp) * hpp;
    const n = Math.min(256, Math.floor(hourly.time.length / hpp));
    if (n < 2) continue;
    const rows = aggregateHourly(hourly, hourly.time, n, resIdx, start);
    const periods: Period[] = rows.map((r) => toFullPeriod(r, WIND_MASK, "US"));
    const sp = LEVELS.map((_, L) => periods.map((p) => qSpeed((p as any)[SPEED_FIELDS[L]], L)));
    const dr = LEVELS.map((_, L) => periods.map((p) => (((p as any)[DIR_FIELDS[L]] as number) ?? 0) % 8));
    // Displayed dir under calm gating: last encoded dir, 0 before any.
    const disp = LEVELS.map((_, L) => {
      let eff = 0;
      return periods.map((_, p) => (sp[L][p] > 0 ? (eff = dr[L][p]) : eff));
    });
    for (let L = 0; L < LEVELS.length; L++) {
      const U = UPPER_OF[L];
      let prev: number | null = null;
      for (let p = 0; p < n; p++) {
        if (p > 0) {
          const delta = sp[L][p] - sp[L][p - 1];
          bump(spdL, fold, `${resIdx}|${L}`, delta + SPEED_MAX, NSPD);
          bump(spdPool, fold, `${resIdx}`, delta + SPEED_MAX, NSPD);
          if (U >= 0) bump(spdU, fold, `${resIdx}|${dBucket(sp[U][p] - sp[U][p - 1])}`, delta + SPEED_MAX, NSPD);
        }
        if (sp[L][p] === 0) continue; // calm: no dir symbol
        const d = dr[L][p];
        if (prev !== null) {
          bump(dirP, fold, `${resIdx}|${prev}`, d, NDIR);
          if (U >= 0) {
            const u = disp[U][p];
            bump(dirJ, fold, `${resIdx}|${prev}|${u}`, d, NDIR);
            bump(dirC, fold, `${resIdx}|${prev}|${Math.min(circDist(u, prev), 2)}`, d, NDIR);
          }
        }
        prev = d;
      }
    }
  }
});

// Held-out cost of coding evalFc's fold-f counts under tables trained on trainFc's other folds.
// `mapCtx` remaps an eval context onto the training structure's context key (e.g. drop the upper
// component, or force res=4 for the shipped-design baseline).
function heldOut(
  trainFc: FoldCounts, evalFc: FoldCounts,
  filter: (ctx: string) => boolean, mapCtx: (ctx: string) => string,
): { bpp: number } {
  let bits = 0, syms = 0;
  for (let f = 0; f < N_FOLDS; f++) {
    const train = new Map<string, number[]>();
    for (let g = 0; g < N_FOLDS; g++) {
      if (g === f) continue;
      for (const [ctx, arr] of trainFc[g]) {
        let t = train.get(ctx);
        if (!t) { t = new Array(arr.length).fill(0); train.set(ctx, t); }
        for (let i = 0; i < arr.length; i++) t[i] += arr[i];
      }
    }
    const freqCache = new Map<string, number[]>();
    const freqsFor = (ctx: string, nsym: number): number[] => {
      let q = freqCache.get(ctx);
      if (!q) {
        const counts = train.get(ctx) ?? new Array(nsym).fill(0);
        q = quantizeFreqs(scaledWeights(counts));
        freqCache.set(ctx, q);
      }
      return q;
    };
    for (const [ctx, arr] of evalFc[f]) {
      if (!filter(ctx)) continue;
      const q = freqsFor(mapCtx(ctx), arr.length);
      for (let s = 0; s < arr.length; s++) {
        if (arr[s] === 0) continue;
        bits += arr[s] * (RANS_PROB_BITS - Math.log2(q[s]));
        syms += arr[s];
      }
    }
  }
  return { bpp: bits / Math.max(syms, 1) };
}

const resOf = (ctx: string) => ctx.split("|")[0];
console.log("═══ direction (held-out bits/symbol, calm-gated) ═══");
for (const r of RES_INDICES) {
  const inRes = (ctx: string) => resOf(ctx) === `${r}`;
  const cur = heldOut(dirP, dirP, inRes, (ctx) => `4|${ctx.split("|")[1]}`);
  const a = heldOut(dirP, dirP, inRes, (ctx) => ctx);
  // b/c evaluate on the w600/w700 subset; `aJ` is scheme (a) on that same subset, for fairness.
  const aJ = heldOut(dirP, dirJ, inRes, (ctx) => { const [res, prev] = ctx.split("|"); return `${res}|${prev}`; });
  const b = heldOut(dirJ, dirJ, inRes, (ctx) => ctx);
  const c = heldOut(dirC, dirC, inRes, (ctx) => ctx);
  console.log(`  res ${r} (${HOURS_PER_PERIOD[r]}h): cur ${cur.bpp.toFixed(3)}  a[res|prev] ${a.bpp.toFixed(3)}` +
    `   — w6/700 subset: a ${aJ.bpp.toFixed(3)}  b[+upper] ${b.bpp.toFixed(3)}  c[+dist] ${c.bpp.toFixed(3)}`);
}
console.log("\n═══ speed deltas (held-out bits/symbol, domain 0..31) ═══");
for (const r of RES_INDICES) {
  const inRes = (ctx: string) => resOf(ctx) === `${r}`;
  const cur = heldOut(spdPool, spdL, inRes, () => "4");
  const a = heldOut(spdL, spdL, inRes, (ctx) => ctx);
  const aU = heldOut(spdL, spdL, (ctx) => inRes(ctx) && ["2", "3"].includes(ctx.split("|")[1]), (ctx) => ctx);
  const b = heldOut(spdU, spdU, inRes, (ctx) => ctx);
  console.log(`  res ${r} (${HOURS_PER_PERIOD[r]}h): cur ${cur.bpp.toFixed(3)}  a[res|level] ${a.bpp.toFixed(3)}` +
    `   — w6/700 subset: a ${aU.bpp.toFixed(3)}  b[+upperΔ] ${b.bpp.toFixed(3)}`);
}
