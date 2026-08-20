/**
 * Vertical-neighbor conditioning scan for the cloud band: held-out (5-fold by location)
 * bits/period for the band's delta column under its planned per-level tables vs per-level plus
 * candidate free context. The column decodes level-major, 300 hPa first, so when level l codes
 * period p the level above (l−1) has already decoded its ENTIRE chain — its same-period delta
 * and value are free context, exactly like the 600/700 hPa wind columns' upper-level keying.
 * Level 0 (300 hPa) has no level above and keeps its unconditioned row in every scheme.
 *
 * Only the serving resolutions are scanned: the wire clamps band symbols to ≤3h periods
 * (cloudBandPeriodCount in v3.ts), so 3h and 1h are the only spans a table will ever price.
 *
 * Candidates (all available to the decoder before the target symbol):
 *   nbrΔ       — the level above's same-period delta, exact (15) or bucketed (upperDeltaBucket, 5)
 *   prevOwnB   — the level's own previous VALUE, bucketed {0, 1-3, 4-7} — the rhCrit floor pins
 *                levels at exactly 0 for long runs, so "was clear" may reshape the delta
 *   res        — 3h vs 1h, for the record (the training-set numbers said it buys ~nothing)
 *
 * Suspicion motivating the scan: fillCloudBand assigns the SAME magnitude to every level it
 * lights from one trio trigger, which manufactures vertical correlation the pre-fill trio scan
 * (analyze-cross-var-heldout.ts, "clouds × anything −0.03, REJECTED") never saw.
 *
 *   pnpm exec tsx packages/codec-server/scripts/analyze-cloud-neighbor-heldout.ts [--stride N]
 *
 * --stride N keeps one train cell in N (default 5, ~20k cells); --stride 1 scans the whole split.
 */
import { rowsFromWindows, toFullPeriod, HOURS_PER_PERIOD } from "../src/forecast.ts";
import {
  CLOUD_BAND_LEVELS_HPA, VARS_BIT, quantCover, upperDeltaBucket, type Period,
} from "@weather/protocol";
import { eachForecast, foldOf, N_FOLDS, scaledWeights } from "./derive-lib.ts";

const args = process.argv.slice(2);
const stride = Math.max(1, Number(args[args.indexOf("--stride") + 1]) || 5);

const RES_IDXS = [3, 4]; // 3h/1h — the band's resolution clamp makes these the only served spans
const NRES = RES_IDXS.length;
const NLEVEL = CLOUD_BAND_LEVELS_HPA.length;
const NSYM = 15; // deltas -7..7
const CLOUD_MASK = 1 << VARS_BIT.cch;

const N_NBR_B = 5; // upperDeltaBucket domain: ≤-2, -1, 0, +1, ≥+2
const prevOwnBucket = (q: number) => (q === 0 ? 0 : q <= 3 ? 1 : 2);
const N_PREV_B = 3;

interface Chain { fold: number; res: number; n: number; q: Uint8Array[] } // q[level][period]

const chains: Chain[] = [];
await eachForecast((h, _startHour, loc, pos) => {
  if (!pos || !h.time?.length) return;
  const off = Math.round(pos.lon / 15);
  const dataStart = Math.floor(Date.parse(`${h.time[0]}:00Z`) / 3600000);
  const dataEnd = dataStart + h.time.length;
  const fold = foldOf(loc);
  for (const res of RES_IDXS) {
    const hpp = HOURS_PER_PERIOD[res];
    const firstUtc = Math.ceil((dataStart + off) / 24) * 24 - off; // first local midnight
    const n = Math.floor((dataEnd - firstUtc) / hpp);
    if (n < 3) continue;
    const windows: number[][] = [];
    for (let p = 0; p < n; p++) {
      const w: number[] = [];
      for (let eh = firstUtc + p * hpp; eh < firstUtc + (p + 1) * hpp; eh++) w.push(eh - dataStart);
      windows.push(w);
    }
    const periods: Period[] = rowsFromWindows(h, h.time, windows, off)
      .map((r) => toFullPeriod(r, CLOUD_MASK, "US"));
    chains.push({
      fold, res, n,
      q: Array.from({ length: NLEVEL }, (_, li) =>
        Uint8Array.from(periods, (p) => quantCover(p.cloud_band?.[li]))),
    });
  }
}, "train", undefined, { index: 0, total: stride });

console.log(`Columns (forecast × resolution): ${chains.length} (stride ${stride})`);

// ── Held-out evaluation over (level, period) symbols ────────────────────────────
const zeros = (n: number) => new Array<number>(n).fill(0);
const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0);

function heldOutBits(train: number[], test: number[], fallback: number[]): number {
  const t = sum(train) > 0 ? train : fallback;
  const w = scaledWeights(t);
  const total = sum(w);
  let bits = 0;
  for (let s = 0; s < test.length; s++) if (test[s] > 0) bits += test[s] * -Math.log2(w[s] / total);
  return bits;
}

// ctxOf sees (chain, level, period ≥ 1); the per-level fallback pools the level's other contexts,
// so a thin context row degrades to exactly the per-level table the baseline ships.
function evalScheme(
  label: string, nctxPerLevel: number,
  ctxOf: (c: Chain, li: number, p: number) => number,
  baseline: number | null,
): number {
  const nctx = NLEVEL * nctxPerLevel;
  const counts = Array.from({ length: N_FOLDS }, () => Array.from({ length: nctx }, () => zeros(NSYM)));
  for (const c of chains) for (let li = 0; li < NLEVEL; li++) {
    const q = c.q[li];
    for (let p = 1; p < c.n; p++)
      counts[c.fold][li * nctxPerLevel + ctxOf(c, li, p)][q[p] - q[p - 1] + 7]++;
  }
  let bits = 0, n = 0, occMin = Infinity;
  for (let fold = 0; fold < N_FOLDS; fold++) {
    const train = Array.from({ length: nctx }, () => zeros(NSYM));
    const levelFallback = Array.from({ length: NLEVEL }, () => zeros(NSYM));
    for (let f = 0; f < N_FOLDS; f++) {
      if (f === fold) continue;
      for (let ctx = 0; ctx < nctx; ctx++) for (let s = 0; s < NSYM; s++) {
        train[ctx][s] += counts[f][ctx][s];
        levelFallback[Math.floor(ctx / nctxPerLevel)][s] += counts[f][ctx][s];
      }
    }
    for (let ctx = 0; ctx < nctx; ctx++) {
      const held = counts[fold][ctx];
      if (sum(held) === 0 && sum(train[ctx]) === 0) continue;
      if (sum(train[ctx]) > 0) occMin = Math.min(occMin, sum(train[ctx]));
      bits += heldOutBits(train[ctx], held, levelFallback[Math.floor(ctx / nctxPerLevel)]);
      n += sum(held);
    }
  }
  const bpp = (bits / n) * NLEVEL; // per PERIOD = all 8 levels' symbols
  const delta = baseline == null ? null : bpp - baseline;
  console.log(`  ${label.padEnd(34)} ${bpp.toFixed(3).padStart(7)}` +
    (delta == null ? "        " : ` ${(delta > 0 ? "+" : "") + delta.toFixed(3)}`) +
    `   occ min=${occMin === Infinity ? 0 : occMin}`);
  return bpp;
}

// The level above's same-period delta; level 0 reports bucket "0" (its rows for other bucket
// values stay empty, so it effectively keeps one unconditioned row).
const nbrDelta = (c: Chain, li: number, p: number): number =>
  li === 0 ? 0 : c.q[li - 1][p] - c.q[li - 1][p - 1];

console.log(`\nHeld-out bits/period (5-fold by location; band = all ${NLEVEL} levels, transitions only, 3h+1h)`);
const base = evalScheme("per-level pooled (8) [planned B]", 1, () => 0, null);
evalScheme("+ res (16) [as committed]", NRES, (c) => (c.res === 3 ? 0 : 1), base);
evalScheme("+ prevOwnB (24)", N_PREV_B, (c, li, p) => prevOwnBucket(c.q[li][p - 1]), base);
evalScheme("+ nbrΔB (40)", N_NBR_B, (c, li, p) => li === 0 ? 2 : upperDeltaBucket(nbrDelta(c, li, p)), base);
evalScheme("+ nbrΔ exact (120)", NSYM, (c, li, p) => li === 0 ? 7 : nbrDelta(c, li, p) + 7, base);
evalScheme("+ nbrΔB × prevOwnB (120)", N_NBR_B * N_PREV_B,
  (c, li, p) => (li === 0 ? 2 : upperDeltaBucket(nbrDelta(c, li, p))) * N_PREV_B + prevOwnBucket(c.q[li][p - 1]), base);
evalScheme("+ nbrΔ exact × prevOwnB (360)", NSYM * N_PREV_B,
  (c, li, p) => (li === 0 ? 7 : nbrDelta(c, li, p) + 7) * N_PREV_B + prevOwnBucket(c.q[li][p - 1]), base);
// Exact previous value = order-1 VALUE coding in delta clothes (prev + delta ↔ value), the same
// model the precip/snow/rain columns ship.
evalScheme("+ prevOwn exact (64)", 8, (c, li, p) => c.q[li][p - 1], base);
evalScheme("+ prevOwn exact × nbrΔB (320)", 8 * N_NBR_B,
  (c, li, p) => c.q[li][p - 1] * N_NBR_B + (li === 0 ? 2 : upperDeltaBucket(nbrDelta(c, li, p))), base);
evalScheme("+ prevOwn exact × res (128)", 8 * NRES,
  (c, li, p) => c.q[li][p - 1] * NRES + (c.res === 3 ? 0 : 1), base);
