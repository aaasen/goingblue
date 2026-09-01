/**
 * What the AMOUNT arm of the mixed-phase gate COSTS. Held-out (5-fold by location) bits per
 * period for every column the arm touches, under the code-count-only gate (what production
 * encoded before) vs the full rule in src/weathercode.ts (code arm OR amount arm).
 *
 * Same machinery and the same reading rules as analyze-wc-aggregation-heldout.ts, which priced
 * the original coverage-aware aggregation against `maxOf` and is kept as that change's record:
 *   - The three WET columns (precip chance, snow, rain) key their codebooks on the SAME-period
 *     weathercode class, so re-gating changes their conditioning even though their own symbols
 *     are untouched. That comparison is apples-to-apples: a win or loss there is real.
 *   - The WEATHERCODE column emits different sequences under the two gates, so its delta is the
 *     PRICE of a representation chosen on fidelity grounds (the sizing scan
 *     analyze-wc-amount-mix.ts is the fidelity case), not evidence either gate is better.
 *
 * No alphabet or class variants this time: 68/69 are already wire symbols with class snow-ish,
 * and the fifth-class question was settled when the code arm shipped. The only axis is the gate.
 *
 *   pnpm exec tsx packages/codec-server/scripts/analyze-wc-amount-mix-heldout.ts
 */
import { rowsFromWindows, toFullPeriod, HOURS_PER_PERIOD, type HourlyData } from "../src/forecast.ts";
import {
  VAR, type Variable, WMO_CODES, WMO2IDX, compandSqrt, SNOW_K, RAIN_K, ACCUM_BITS,
  WEATHERCODE_CLASS, WC_CLASSES, type Period,
} from "@weather/protocol";
import { eachForecast, foldOf, N_FOLDS, scaledWeights } from "./derive-lib.ts";
import { aggregateWeathercode } from "../src/weathercode.ts";

const RES_IDXS = [1, 2, 3, 4]; // 12h/6h/3h/1h — layouts never emit 24h
const NRES = RES_IDXS.length;
const resPos: Record<number, number> = Object.fromEntries(RES_IDXS.map((r, i) => [r, i]));
const ALL_VARS: ReadonlySet<Variable> = new Set([
  VAR.precip, VAR.temp, VAR.snow, VAR.freeze, VAR.rain, VAR.wind, VAR.gust,
  VAR.w300, VAR.w400, VAR.w500, VAR.clouds,
]);
const NSYM = WMO_CODES.length; // 30 — 68/69 are already in the alphabet

// eachForecast runs adjustPrecipPhase before the callback, which needs temperature_2m and
// freezing_level_height — omit them and the phase correction silently no-ops.
const SCAN_VARS = [
  "weather_code", "rain", "showers", "snowfall", "precipitation_probability",
  "temperature_2m", "freezing_level_height",
];

// Wet-column context geometry — must match entropy.ts (same as the sibling scan).
const ACCUM_EDGES = [1, 4, 10, 21];
const accumBucket = (v: number) => { let b = 0; for (const e of ACCUM_EDGES) { if (v < e) break; b++; } return b; };
const N_ACCUM_B = ACCUM_EDGES.length + 1; // 5
const N_PRECIP_V = 8;                     // chance in eighths
const N_ACCUM_SYM = 1 << ACCUM_BITS;      // 64 companded steps
const clampInt = (v: number, width: number) => Math.min(Math.max(v, 0), (1 << width) - 1);

interface Chain {
  fold: number;
  res: number;
  n: number;
  wcBase: Uint8Array;  // code-count arm only (noAmountMix)
  wcCand: Uint8Array;  // full shipped rule, amount arm on
  precip: Uint8Array;
  snow: Uint8Array;
  rain: Uint8Array;
}

let nChanged = 0, nPeriods = 0;
const changedByRes = new Map<number, [number, number]>(RES_IDXS.map((r) => [r, [0, 0]]));
const candOccupancy = new Map<number, Map<number, number>>(RES_IDXS.map((r) => [r, new Map()]));
const baseOccupancy = new Map<number, Map<number, number>>(RES_IDXS.map((r) => [r, new Map()]));

async function collectChains(): Promise<Chain[]> {
  const chains: Chain[] = [];
  await eachForecast((h: HourlyData, _startHour, loc, pos) => {
    if (!pos || !h.time?.length) return;
    const wc = h.weather_code as (number | null)[] | undefined;
    if (!wc) return;
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
      const rows = rowsFromWindows(h, h.time, windows, off);
      const periods: Period[] = rows.map((r) => toFullPeriod(r, ALL_VARS, "US"));

      const wcBase = new Uint8Array(n);
      const wcCand = new Uint8Array(n);
      const cnt = changedByRes.get(res)!;
      const candOcc = candOccupancy.get(res)!;
      const baseOcc = baseOccupancy.get(res)!;
      for (let p = 0; p < n; p++) {
        const codes: number[] = [];
        for (const i of windows[p]) { const c = wc[i]; if (c != null) codes.push(c); }
        // The candidate is what rowsFromWindows now returns; the baseline (code arm only) is
        // computed explicitly with the amount arm off.
        const base = aggregateWeathercode(codes, rows[p].snow_cm, rows[p].rain_mm, false, true);
        const cand = rows[p].weathercode ?? 0;
        wcBase[p] = WMO2IDX[base] ?? 0;
        wcCand[p] = WMO2IDX[cand] ?? 0;
        baseOcc.set(base, (baseOcc.get(base) ?? 0) + 1);
        candOcc.set(cand, (candOcc.get(cand) ?? 0) + 1);
        cnt[1]++; nPeriods++;
        if (cand !== base) { cnt[0]++; nChanged++; }
      }

      chains.push({
        fold, res, n, wcBase, wcCand,
        precip: Uint8Array.from(periods, (p) => clampInt(Math.round((p.precip ?? 0) * 7 / 100), 3)),
        snow: Uint8Array.from(periods, (p) => compandSqrt(p.snow_cm ?? 0, SNOW_K, ACCUM_BITS)),
        rain: Uint8Array.from(periods, (p) => compandSqrt(p.rain_mm ?? 0, RAIN_K, ACCUM_BITS)),
      });
    }
  }, "train", SCAN_VARS);
  return chains;
}

// ── Held-out evaluation (identical machinery to analyze-wc-aggregation-heldout.ts) ─
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

// Transitions only (p ≥ 1), matching the sibling scans.
function evalScheme(
  chains: Chain[], nsym: number, nctx: number,
  symOf: (c: Chain, p: number) => number, ctxOf: (c: Chain, p: number) => number,
): { bpp: number; occMin: number } {
  const counts = Array.from({ length: N_FOLDS }, () => Array.from({ length: nctx }, () => zeros(nsym)));
  for (const c of chains) for (let p = 1; p < c.n; p++) counts[c.fold][ctxOf(c, p)][symOf(c, p)]++;
  let bits = 0, n = 0;
  const occ = zeros(nctx);
  for (let fold = 0; fold < N_FOLDS; fold++) {
    const train = Array.from({ length: nctx }, () => zeros(nsym));
    const fallback = zeros(nsym);
    for (let f = 0; f < N_FOLDS; f++) {
      if (f === fold) continue;
      for (let ctx = 0; ctx < nctx; ctx++) for (let s = 0; s < nsym; s++) {
        train[ctx][s] += counts[f][ctx][s];
        fallback[s] += counts[f][ctx][s];
      }
    }
    for (let ctx = 0; ctx < nctx; ctx++) {
      occ[ctx] += sum(train[ctx]) / (N_FOLDS - 1);
      bits += heldOutBits(train[ctx], counts[fold][ctx], fallback);
      n += sum(counts[fold][ctx]);
    }
  }
  return { bpp: n > 0 ? bits / n : 0, occMin: Math.min(...occ) };
}

interface Variant {
  name: string;
  wcOf: (c: Chain, p: number) => number;
}

const VARIANTS: Variant[] = [
  { name: "code arm only (pre-change)", wcOf: (c, p) => c.wcBase[p] },
  { name: "code OR amount arm", wcOf: (c, p) => c.wcCand[p] },
];

function evalVariant(chains: Chain[], v: Variant) {
  const cls = (c: Chain, p: number) => WEATHERCODE_CLASS[v.wcOf(c, p)];
  // Weathercode: order-1 on the previous symbol, exactly the shipped scheme.
  const wcode = evalScheme(chains, NSYM, NSYM, v.wcOf, (c, p) => v.wcOf(c, p - 1));
  // Wet columns: res × ctxOf(prev value) × same-period wcClass, prev-major.
  const precip = evalScheme(chains, N_PRECIP_V, NRES * N_PRECIP_V * WC_CLASSES,
    (c, p) => c.precip[p],
    (c, p) => (resPos[c.res] * N_PRECIP_V + c.precip[p - 1]) * WC_CLASSES + cls(c, p));
  const snow = evalScheme(chains, N_ACCUM_SYM, NRES * N_ACCUM_B * WC_CLASSES,
    (c, p) => c.snow[p],
    (c, p) => (resPos[c.res] * N_ACCUM_B + accumBucket(c.snow[p - 1])) * WC_CLASSES + cls(c, p));
  const rain = evalScheme(chains, N_ACCUM_SYM, NRES * N_ACCUM_B * WC_CLASSES,
    (c, p) => c.rain[p],
    (c, p) => (resPos[c.res] * N_ACCUM_B + accumBucket(c.rain[p - 1])) * WC_CLASSES + cls(c, p));
  return { wcode, precip, snow, rain, total: wcode.bpp + precip.bpp + snow.bpp + rain.bpp };
}

// ── Report ──────────────────────────────────────────────────────────────────────
console.log("Collecting chains…");
const chains = await collectChains();
console.log(`  ${chains.length} chains, ${nPeriods} periods`);

console.log(`\nPeriods whose emitted code CHANGES under the amount arm:`);
for (const res of RES_IDXS) {
  const [ch, tot] = changedByRes.get(res)!;
  console.log(`  ${String(HOURS_PER_PERIOD[res]).padStart(2)}h: ${((100 * ch) / tot).toFixed(2)}%  (${ch} / ${tot})`);
}

console.log(`\nEmitted occupancy shift (12h), code arm → with amount arm:`);
{
  const b = baseOccupancy.get(1)!, c = candOccupancy.get(1)!;
  const tot = [...b.values()].reduce((a, x) => a + x, 0);
  const codes = [...new Set([...b.keys(), ...c.keys()])].sort((x, y) => x - y);
  for (const code of codes) {
    const bp = (100 * (b.get(code) ?? 0)) / tot, cp = (100 * (c.get(code) ?? 0)) / tot;
    if (bp < 0.05 && cp < 0.05) continue;
    const arrow = Math.abs(cp - bp) < 0.05 ? " " : cp > bp ? "▲" : "▼";
    console.log(`  ${String(code).padStart(3)}  ${bp.toFixed(2).padStart(6)}% → ${cp.toFixed(2).padStart(6)}%  ${arrow}`);
  }
}

const results = VARIANTS.map((v) => ({ v, r: evalVariant(chains, v) }));
const base = results[0].r;

console.log(`\nHeld-out b/period, 5-fold by location, transitions only.`);
console.log(`WET COLUMNS are apples-to-apples (same symbols, different context).`);
console.log(`WEATHERCODE is NOT — different sequences. It is the price of the representation.\n`);
console.log(`  ${"variant".padEnd(30)}${"wcode".padStart(9)}${"precip".padStart(9)}${"snow".padStart(9)}${"rain".padStart(9)}${"TOTAL".padStart(10)}${"Δ".padStart(9)}`);
for (const { v, r } of results) {
  const d = r.total - base.total;
  console.log(`  ${v.name.padEnd(30)}${r.wcode.bpp.toFixed(3).padStart(9)}${r.precip.bpp.toFixed(3).padStart(9)}` +
    `${r.snow.bpp.toFixed(3).padStart(9)}${r.rain.bpp.toFixed(3).padStart(9)}${r.total.toFixed(3).padStart(10)}` +
    `${(d >= 0 ? "+" : "") + d.toFixed(3)}`.padStart(9));
}

console.log(`\n  wet columns only (the honest comparison):`);
for (const { v, r } of results) {
  const wet = r.precip.bpp + r.snow.bpp + r.rain.bpp;
  const bwet = base.precip.bpp + base.snow.bpp + base.rain.bpp;
  const d = wet - bwet;
  console.log(`  ${v.name.padEnd(30)}${wet.toFixed(3).padStart(9)}   ${(d >= 0 ? "+" : "") + d.toFixed(3)}`);
}
console.log();
