/**
 * What the coverage-aware weathercode aggregation COSTS. Held-out (5-fold by location) bits per
 * period for every column the change touches, under the former `maxOf` aggregation vs the rule in
 * src/weathercode.ts (now shipped — this scan is the record of what it cost).
 *
 * The affected set is exactly four columns. Weathercode itself changes symbol-for-symbol. The
 * three wet columns (precip chance, snow, rain) key their codebooks on the SAME-period weathercode
 * class (WEATHERCODE_CLASS — worth 0.978→0.876, 0.708→0.445 and 1.101→0.770 b/period per
 * analyze-cross-var-heldout.ts), so re-aggregating changes their context even though their own
 * values are untouched. Nothing else keys on weathercode: clouds × wcClass was measured and
 * rejected, and freeze keys on the temp delta.
 *
 * READ THE TWO COMPARISONS DIFFERENTLY:
 *   - The three WET columns are a true apples-to-apples test. Identical symbol sequences, only the
 *     conditioning context differs, so a win or loss there is real compression, full stop.
 *   - The WEATHERCODE column is NOT. The two aggregations emit different sequences, so this is the
 *     PRICE of a representation already chosen on fidelity grounds — not evidence that either
 *     representation is better. A rule that summarized every period as "clear" would win this
 *     column outright while being useless. Do not read a weathercode-column saving as a win.
 *
 * Variants, because appending 68/69 forces a choice about WEATHERCODE_CLASS (which the wet columns
 * key on): fold the mixed codes into the existing snow-ish class, or give them their own fifth
 * class. The fifth class widens every wet-column table by 25% for ~0.8% of periods, so it has to
 * earn that against thinner per-context counts.
 *
 *   pnpm exec tsx packages/codec-server/scripts/analyze-wc-aggregation-heldout.ts
 */
import { rowsFromWindows, toFullPeriod, HOURS_PER_PERIOD, type HourlyData } from "../src/forecast.ts";
import {
  WMO_CODES, WMO2IDX, compandSqrt, SNOW_K, RAIN_K, ACCUM_BITS,
  WEATHERCODE_CLASS, WC_CLASSES, type Period,
} from "@weather/protocol";
import { eachForecast, foldOf, N_FOLDS, scaledWeights } from "./derive-lib.ts";
import { aggregateWeathercode, drySkyCode, isDryWindow, WMO_MIX_LIGHT, WMO_MIX_HEAVY } from "../src/weathercode.ts";

const RES_IDXS = [1, 2, 3, 4]; // 12h/6h/3h/1h — layouts never emit 24h
const NRES = RES_IDXS.length;
const resPos: Record<number, number> = Object.fromEntries(RES_IDXS.map((r, i) => [r, i]));
const ALL_MASK = (1 << 13) - 1;

// eachForecast runs adjustPrecipPhase before the callback, which needs temperature_2m and
// freezing_level_height — omit them and the phase correction silently no-ops. The rest is what
// rowsFromWindows reads for the four columns under test.
const SCAN_VARS = [
  "weather_code", "rain", "showers", "snowfall", "precipitation_probability",
  "temperature_2m", "freezing_level_height",
];

// ── Alphabets ───────────────────────────────────────────────────────────────────
// The candidate appends 68/69 rather than inserting them in numeric order: WMO2IDX is positional,
// so inserting would renumber every symbol above 67 and silently reinterpret existing messages.
// 30 symbols keeps RAW_BITS at 5 (the fixed-width fallback stays the same width up to 32).
const BASE_CODES = WMO_CODES;
const CAND_CODES = [...WMO_CODES, WMO_MIX_LIGHT, WMO_MIX_HEAVY];
const NSYM_BASE = BASE_CODES.length; // 28
const NSYM_CAND = CAND_CODES.length; // 30
const CAND_IDX = new Map(CAND_CODES.map((c, i) => [c, i]));

// wcClass per symbol index. Base is the shipped table. The two candidate variants differ only in
// where the mixed codes land.
const CLASS_BASE = WEATHERCODE_CLASS;
const CLASS_FOLD = [...WEATHERCODE_CLASS, 3, 3];  // 68/69 → snow-ish, WC_CLASSES stays 4
const CLASS_NEW = [...WEATHERCODE_CLASS, 4, 4];   // 68/69 → their own class, WC_CLASSES becomes 5

// Wet-column context geometry — must match entropy.ts. precip keys on the previous value
// directly; snow/rain key on a bucket of it. Rows are prev-major: ctxOf(prev) * nClass + wcClass.
const ACCUM_EDGES = [1, 4, 10, 21];
const accumBucket = (v: number) => { let b = 0; for (const e of ACCUM_EDGES) { if (v < e) break; b++; } return b; };
const N_ACCUM_B = ACCUM_EDGES.length + 1; // 5
const N_PRECIP_V = 8;                     // chance in eighths
const N_ACCUM_SYM = 1 << ACCUM_BITS;      // 64 companded steps
const clampInt = (v: number, width: number) => Math.min(Math.max(v, 0), (1 << width) - 1);

// ── Chains ──────────────────────────────────────────────────────────────────────
// Typed arrays throughout: the full-corpus scan holds ~400k chains and plain number[] blew the
// V8 heap in the sibling cross-var script.
interface Chain {
  fold: number;
  res: number;
  n: number;
  wcBase: Uint8Array;  // symbol index into BASE_CODES
  wcCand: Uint8Array;  // symbol index into CAND_CODES
  wcWetOnly: Uint8Array; // candidate wet rule, dry windows still by max
  wcDryOnly: Uint8Array; // dry-sky fix only, wet windows still by max
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
      const periods: Period[] = rows.map((r) => toFullPeriod(r, ALL_MASK, "US"));

      const wcBase = new Uint8Array(n);
      const wcCand = new Uint8Array(n);
      const wcWetOnly = new Uint8Array(n);
      const wcDryOnly = new Uint8Array(n);
      const cnt = changedByRes.get(res)!;
      const candOcc = candOccupancy.get(res)!;
      const baseOcc = baseOccupancy.get(res)!;
      for (let p = 0; p < n; p++) {
        const codes: number[] = [];
        for (const i of windows[p]) { const c = wc[i]; if (c != null) codes.push(c); }
        // The FORMER aggregation, computed here rather than read off periods[p] — rowsFromWindows
        // now returns the new rule, so reading it back would compare the rule against itself.
        const base = codes.length > 0 ? Math.max(...codes) : 0;
        const cand = aggregateWeathercode(codes, rows[p].snow_cm, rows[p].rain_mm);
        const wetOnly = aggregateWeathercode(codes, rows[p].snow_cm, rows[p].rain_mm, true);
        // Dry-sky fix in isolation: mean-fraction sky on dry windows, today's max everywhere else.
        // Dry and wet windows partition the periods, so wet-only and dry-only sum to the candidate.
        const dryOnly = codes.length > 0 && isDryWindow(codes) ? drySkyCode(codes) : base;
        wcBase[p] = WMO2IDX[base] ?? 0;
        wcCand[p] = CAND_IDX.get(cand) ?? 0;
        wcWetOnly[p] = CAND_IDX.get(wetOnly) ?? 0;
        wcDryOnly[p] = WMO2IDX[dryOnly] ?? 0;
        baseOcc.set(base, (baseOcc.get(base) ?? 0) + 1);
        candOcc.set(cand, (candOcc.get(cand) ?? 0) + 1);
        cnt[1]++; nPeriods++;
        if (cand !== base) { cnt[0]++; nChanged++; }
      }

      chains.push({
        fold, res, n, wcBase, wcCand, wcWetOnly, wcDryOnly,
        precip: Uint8Array.from(periods, (p) => clampInt(Math.round((p.precip ?? 0) * 7 / 100), 3)),
        snow: Uint8Array.from(periods, (p) => compandSqrt(p.snow_cm ?? 0, SNOW_K, ACCUM_BITS)),
        rain: Uint8Array.from(periods, (p) => compandSqrt(p.rain_mm ?? 0, RAIN_K, ACCUM_BITS)),
      });
    }
  }, "train", SCAN_VARS);
  return chains;
}

// ── Held-out evaluation (identical machinery to analyze-cross-var-heldout.ts) ────
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

// Transitions only (p ≥ 1), matching the sibling scans: the bootstrap symbol is one per column per
// message and its table is shared, so it does not move between candidates.
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
  nsym: number;
  wcOf: (c: Chain, p: number) => number;
  classOf: readonly number[];
  nClass: number;
}

const VARIANTS: Variant[] = [
  { name: "baseline (max)", nsym: NSYM_BASE, wcOf: (c, p) => c.wcBase[p], classOf: CLASS_BASE, nClass: WC_CLASSES },
  { name: "candidate, 68/69 → snow class", nsym: NSYM_CAND, wcOf: (c, p) => c.wcCand[p], classOf: CLASS_FOLD, nClass: WC_CLASSES },
  { name: "candidate, 68/69 → own class", nsym: NSYM_CAND, wcOf: (c, p) => c.wcCand[p], classOf: CLASS_NEW, nClass: WC_CLASSES + 1 },
  // Attribution: the two halves of the change partition the periods (a window is wet or dry),
  // so these price the wet-side rule and the dry-sky fix independently against the same baseline.
  { name: "  wet rule only (dry by max)", nsym: NSYM_CAND, wcOf: (c, p) => c.wcWetOnly[p], classOf: CLASS_FOLD, nClass: WC_CLASSES },
  { name: "  dry-sky fix only", nsym: NSYM_BASE, wcOf: (c, p) => c.wcDryOnly[p], classOf: CLASS_BASE, nClass: WC_CLASSES },
];

function evalVariant(chains: Chain[], v: Variant) {
  const cls = (c: Chain, p: number) => v.classOf[v.wcOf(c, p)];
  // Weathercode: order-1 on the previous symbol, exactly the shipped scheme.
  const wcode = evalScheme(chains, v.nsym, v.nsym, v.wcOf, (c, p) => v.wcOf(c, p - 1));
  // Wet columns: res × ctxOf(prev value) × same-period wcClass, prev-major.
  const precip = evalScheme(chains, N_PRECIP_V, NRES * N_PRECIP_V * v.nClass,
    (c, p) => c.precip[p],
    (c, p) => (resPos[c.res] * N_PRECIP_V + c.precip[p - 1]) * v.nClass + cls(c, p));
  const snow = evalScheme(chains, N_ACCUM_SYM, NRES * N_ACCUM_B * v.nClass,
    (c, p) => c.snow[p],
    (c, p) => (resPos[c.res] * N_ACCUM_B + accumBucket(c.snow[p - 1])) * v.nClass + cls(c, p));
  const rain = evalScheme(chains, N_ACCUM_SYM, NRES * N_ACCUM_B * v.nClass,
    (c, p) => c.rain[p],
    (c, p) => (resPos[c.res] * N_ACCUM_B + accumBucket(c.rain[p - 1])) * v.nClass + cls(c, p));
  return { wcode, precip, snow, rain, total: wcode.bpp + precip.bpp + snow.bpp + rain.bpp };
}

// ── Report ──────────────────────────────────────────────────────────────────────
console.log("Collecting chains…");
const chains = await collectChains();
console.log(`  ${chains.length} chains, ${nPeriods} periods`);

console.log(`\nPeriods whose emitted code CHANGES under the candidate:`);
for (const res of RES_IDXS) {
  const [ch, tot] = changedByRes.get(res)!;
  console.log(`  ${String(HOURS_PER_PERIOD[res]).padStart(2)}h: ${((100 * ch) / tot).toFixed(1)}%  (${ch} / ${tot})`);
}

console.log(`\nEmitted occupancy shift (12h), base → candidate:`);
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

console.log(`\n  min per-context training occupancy (thin contexts train badly):`);
for (const { v, r } of results) {
  console.log(`  ${v.name.padEnd(30)}wcode ${Math.round(r.wcode.occMin).toString().padStart(7)}` +
    `  precip ${Math.round(r.precip.occMin).toString().padStart(7)}` +
    `  snow ${Math.round(r.snow.occMin).toString().padStart(7)}` +
    `  rain ${Math.round(r.rain.occMin).toString().padStart(7)}`);
}
console.log();
