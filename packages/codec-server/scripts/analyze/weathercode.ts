/**
 * Weathercode scans, held-out (5-fold by location) bits/period for every column a change to
 * the weathercode column touches. Weathercode changes symbol-for-symbol; the three wet columns
 * (precip chance, snow, rain) key their codebooks on the SAME-period weathercode class
 * (WEATHERCODE_CLASS), so re-aggregating changes their context even though their own values
 * are untouched. Nothing else keys on weathercode: clouds × wcClass was measured and rejected,
 * and freeze keys on the temp delta.
 *
 * READ THE TWO COMPARISONS DIFFERENTLY:
 *   - The three WET columns are a true apples-to-apples test. Identical symbol sequences, only
 *     the conditioning context differs, so a win or loss there is real compression.
 *   - The WEATHERCODE column is NOT. Two aggregations emit different sequences, so its delta is
 *     the PRICE of a representation chosen on fidelity grounds (weathercode-aggregation.ts and
 *     weathercode-amount-mix.ts are the fidelity cases), not evidence that either is better. A
 *     rule that summarized every period as "clear" would win this column outright.
 *
 * Sections:
 *   A. --change aggregation   the former `maxOf` aggregation vs the coverage-aware rule in
 *                             src/weathercode.ts (code arm only), with the two ways of classing
 *                             the mixed codes 68/69 for the wet columns (fold into snow-ish
 *                             ← shipped, or a fifth class), and the rule's two halves priced
 *                             alone (wet rule only; dry-sky fix only).
 *   B. --change amount-arm    the code-count gate alone vs code OR amount arm ← shipped.
 *   C. --change context       the shipped order-1 table (previous symbol, pooled over
 *                             resolution) vs one per resolution.
 *
 * OUTCOME: A (2026-08-15): a fifth class moved the wet columns by −0.003 b/period total while
 * widening every wet table by 25% and dropping their minimum occupancy to zero; 68/69 joined
 * snow-ish. B (2026-08-19): the amount arm cost +0.001 b/period. C (2026-07): resolution
 * keying bought −0.033 b/period, too small to pay for.
 *
 * Transitions only (p ≥ 1): the bootstrap symbol is one per column per message under a shared
 * table and does not move between variants.
 *
 *   pnpm exec tsx packages/codec-server/scripts/analyze/weathercode.ts [--stride N] [--change aggregation|amount-arm|context]
 */
import { toFullPeriod } from "../../src/forecast.ts";
import { aggregateWeathercode, drySkyCode, isDryWindow } from "../../src/weathercode.ts";
import {
  VAR, type Variable, WMO_CODES, WMO2IDX, WEATHERCODE_CLASS, WC_CLASSES, compandSqrt, SNOW_K, RAIN_K, ACCUM_BITS,
  RESOLUTION_HOURS,
} from "@weather/protocol";
import { ACCUM_BUCKET_EDGES } from "../derive-precipitation-codebooks.ts";
import {
  NRES, RES_IDXS, RES_LABEL, argStride, argValue, eachColumn, heldOut, hourRange, hourlyOf, printLadder,
  runStandalone, type HeldOut,
} from "./lib.ts";

const WET_VARS: ReadonlySet<Variable> = new Set([VAR.precip, VAR.snow, VAR.rain]);
const NSYM = WMO_CODES.length; // 30, 68/69 included
const N_PRECIP = 8;
const N_ACCUM = 1 << ACCUM_BITS;
const N_ACCUM_B = ACCUM_BUCKET_EDGES.length + 1;
const accumBucket = (v: number) => { let b = 0; for (const e of ACCUM_BUCKET_EDGES) { if (v < e) break; b++; } return b; };
const clampInt = (v: number, width: number) => Math.min(Math.max(v, 0), (1 << width) - 1);
const IDX_68 = WMO2IDX[68], IDX_69 = WMO2IDX[69];
// 68/69 in their own fifth class (the alternative section A prices).
const CLASS_FIFTH = WEATHERCODE_CLASS.map((cls, i) => (i === IDX_68 || i === IDX_69 ? WC_CLASSES : cls));

// Symbol indices per aggregation variant, plus the wet-column symbols they condition.
interface Chain {
  fold: number; res: number; n: number;
  wcMax: Uint8Array;      // the former `maxOf` aggregation
  wcCode: Uint8Array;     // coverage-aware rule, code-count arm only
  wcShipped: Uint8Array;  // the full shipped rule (rowsFromWindows)
  wcWetOnly: Uint8Array;  // wet rule only, dry windows still by max
  wcDryOnly: Uint8Array;  // dry-sky fix only, wet windows still by max
  precip: Uint8Array; snow: Uint8Array; rain: Uint8Array;
}

// Emitted-code occupancy per variant at each resolution, for the shift tables.
type Occupancy = Map<number, number>[];
const newOcc = (): Occupancy => RES_IDXS.map(() => new Map());
const bump = (m: Map<number, number>, k: number) => m.set(k, (m.get(k) ?? 0) + 1);

async function collectChains(stride: number) {
  const chains: Chain[] = [];
  const occ = { max: newOcc(), code: newOcc(), shipped: newOcc() };
  await eachColumn({ vars: ["weather_code", "rain", "showers", "snowfall", "precipitation_probability"], stride }, (col) => {
    const wc = hourlyOf(col).weather_code as (number | null)[] | undefined;
    if (!wc) return;
    const { rows, n } = col.slice;
    const periods = rows.map((r) => toFullPeriod(r, WET_VARS, "US"));
    const c: Chain = {
      fold: col.fold, res: col.res, n,
      wcMax: new Uint8Array(n), wcCode: new Uint8Array(n), wcShipped: new Uint8Array(n),
      wcWetOnly: new Uint8Array(n), wcDryOnly: new Uint8Array(n),
      precip: Uint8Array.from(periods, (p) => clampInt(Math.round((p.precip ?? 0) * 7 / 100), 3)),
      snow: Uint8Array.from(periods, (p) => compandSqrt(p.snow_cm ?? 0, SNOW_K, ACCUM_BITS)),
      rain: Uint8Array.from(periods, (p) => compandSqrt(p.rain_mm ?? 0, RAIN_K, ACCUM_BITS)),
    };
    for (let p = 0; p < n; p++) {
      const [from, to] = hourRange(col, p);
      const codes: number[] = [];
      for (let i = from; i < to; i++) { const code = wc[i]; if (code != null) codes.push(code); }
      // The former aggregation is computed here: rowsFromWindows returns the shipped rule, so
      // reading it back would compare the rule against itself.
      const max = codes.length > 0 ? Math.max(...codes) : 0;
      const code = aggregateWeathercode(codes, rows[p].snow_cm, rows[p].rain_mm, false, true);
      const shipped = rows[p].weathercode ?? 0;
      const wetOnly = aggregateWeathercode(codes, rows[p].snow_cm, rows[p].rain_mm, true, true);
      // Dry and wet windows partition the periods, so wet-only and dry-only sum to the code rule.
      const dryOnly = codes.length > 0 && isDryWindow(codes) ? drySkyCode(codes) : max;
      c.wcMax[p] = WMO2IDX[max] ?? 0;
      c.wcCode[p] = WMO2IDX[code] ?? 0;
      c.wcShipped[p] = WMO2IDX[shipped] ?? 0;
      c.wcWetOnly[p] = WMO2IDX[wetOnly] ?? 0;
      c.wcDryOnly[p] = WMO2IDX[dryOnly] ?? 0;
      bump(occ.max[col.res], max); bump(occ.code[col.res], code); bump(occ.shipped[col.res], shipped);
    }
    chains.push(c);
  });
  return { chains, occ };
}

// ── Pricing one representation ───────────────────────────────────────────────────

type WcOf = (c: Chain, p: number) => number;
interface Variant { name: string; wcOf: WcOf; classOf?: readonly number[]; nClass?: number }
interface Priced { wcode: HeldOut; precip: HeldOut; snow: HeldOut; rain: HeldOut; total: number; wet: number }

function price(chains: Chain[], v: Variant): Priced {
  const classOf = v.classOf ?? WEATHERCODE_CLASS, nClass = v.nClass ?? WC_CLASSES;
  const cls = (c: Chain, p: number) => classOf[v.wcOf(c, p)];
  const scheme = (nsym: number, nctx: number, symOf: WcOf, ctxOf: WcOf) =>
    heldOut({ nsym, nctx }, (add) => {
      for (const c of chains) for (let p = 1; p < c.n; p++) add(c.fold, c.res, ctxOf(c, p), symOf(c, p));
    });
  // Weathercode: order-1 on the previous symbol, pooled over resolution, exactly as shipped.
  const wcode = scheme(NSYM, NSYM, v.wcOf, (c, p) => v.wcOf(c, p - 1));
  // Wet columns: res × ctxOf(prev value) × same-period class, prev-major, as in entropy.ts.
  const precip = scheme(N_PRECIP, NRES * N_PRECIP * nClass, (c, p) => c.precip[p],
    (c, p) => (c.res * N_PRECIP + c.precip[p - 1]) * nClass + cls(c, p));
  const snow = scheme(N_ACCUM, NRES * N_ACCUM_B * nClass, (c, p) => c.snow[p],
    (c, p) => (c.res * N_ACCUM_B + accumBucket(c.snow[p - 1])) * nClass + cls(c, p));
  const rain = scheme(N_ACCUM, NRES * N_ACCUM_B * nClass, (c, p) => c.rain[p],
    (c, p) => (c.res * N_ACCUM_B + accumBucket(c.rain[p - 1])) * nClass + cls(c, p));
  const wet = precip.bpp + snow.bpp + rain.bpp;
  return { wcode, precip, snow, rain, total: wcode.bpp + wet, wet };
}

function printVariants(title: string, chains: Chain[], variants: Variant[]): void {
  const priced = variants.map((v) => ({ v, r: price(chains, v) }));
  const base = priced[0].r;
  const width = Math.max(30, ...variants.map((v) => v.name.length + 2));
  const cell = (x: number) => x.toFixed(3).padStart(9);
  const delta = (x: number) => ((x >= 0 ? "+" : "") + x.toFixed(3)).padStart(9);
  console.log(`\n${title}`);
  console.log(`  ${"variant".padEnd(width)}${"wcode".padStart(9)}${"precip".padStart(9)}${"snow".padStart(9)}${"rain".padStart(9)}${"TOTAL".padStart(10)}${"Δ".padStart(9)}${"wet only".padStart(10)}${"Δ".padStart(9)}`);
  for (const { v, r } of priced)
    console.log(`  ${v.name.padEnd(width)}${cell(r.wcode.bpp)}${cell(r.precip.bpp)}${cell(r.snow.bpp)}${cell(r.rain.bpp)}` +
      `${r.total.toFixed(3).padStart(10)}${delta(r.total - base.total)}${r.wet.toFixed(3).padStart(10)}${delta(r.wet - base.wet)}`);
  console.log(`  min per-context training occupancy (thin contexts train badly):`);
  for (const { v, r } of priced)
    console.log(`  ${v.name.padEnd(width)}wcode ${String(r.wcode.occMin).padStart(7)}  precip ${String(r.precip.occMin).padStart(7)}` +
      `  snow ${String(r.snow.occMin).padStart(7)}  rain ${String(r.rain.occMin).padStart(7)}`);
}

// How many emitted codes move between two variants, and the 12h occupancy shift.
function printShift(label: string, chains: Chain[], a: keyof Chain, b: keyof Chain, occA: Occupancy, occB: Occupancy): void {
  console.log(`\n  periods whose emitted code changes, ${label}:`);
  for (let res = 0; res < NRES; res++) {
    let changed = 0, tot = 0;
    for (const c of chains) {
      if (c.res !== res) continue;
      const x = c[a] as Uint8Array, y = c[b] as Uint8Array;
      for (let p = 0; p < c.n; p++) { tot++; if (x[p] !== y[p]) changed++; }
    }
    console.log(`    ${RES_LABEL[res].padStart(3)}: ${((100 * changed) / Math.max(1, tot)).toFixed(2)}%  (${changed} / ${tot})`);
  }
  const A = occA[0], B = occB[0];
  const tot = [...A.values()].reduce((s, x) => s + x, 0);
  console.log(`  emitted occupancy shift (${RESOLUTION_HOURS[RES_IDXS[0]]}h), ${label}:`);
  for (const code of [...new Set([...A.keys(), ...B.keys()])].sort((x, y) => x - y)) {
    const ap = (100 * (A.get(code) ?? 0)) / tot, bp = (100 * (B.get(code) ?? 0)) / tot;
    if (ap < 0.05 && bp < 0.05) continue;
    const arrow = Math.abs(bp - ap) < 0.05 ? " " : bp > ap ? "▲" : "▼";
    console.log(`    ${String(code).padStart(3)}  ${ap.toFixed(2).padStart(6)}% → ${bp.toFixed(2).padStart(6)}%  ${arrow}`);
  }
}

export async function analyze(args: string[]): Promise<void> {
  const change = argValue(args, "--change", "");
  const { chains, occ } = await collectChains(argStride(args));
  console.log(`Columns (forecast × resolution): ${chains.length}`);
  const note = "\nHeld-out b/period, 5-fold by location, transitions only. WET COLUMNS are apples-to-apples;\n" +
    "WEATHERCODE is the price of the representation, not evidence for it.";

  if (!change || change === "aggregation") {
    printShift("max → coverage-aware rule", chains, "wcMax", "wcCode", occ.max, occ.code);
    printVariants(`A. former max aggregation vs the coverage-aware rule (code arm)${note}`, chains, [
      { name: "max", wcOf: (c, p) => c.wcMax[p] },
      { name: "coverage-aware, 68/69 → snow class ← shipped", wcOf: (c, p) => c.wcCode[p] },
      { name: "coverage-aware, 68/69 → own class", wcOf: (c, p) => c.wcCode[p], classOf: CLASS_FIFTH, nClass: WC_CLASSES + 1 },
      { name: "  wet rule only (dry by max)", wcOf: (c, p) => c.wcWetOnly[p] },
      { name: "  dry-sky fix only", wcOf: (c, p) => c.wcDryOnly[p] },
    ]);
  }
  if (!change || change === "amount-arm") {
    printShift("code arm → with amount arm", chains, "wcCode", "wcShipped", occ.code, occ.shipped);
    printVariants(`B. mixed-phase gate: code-count arm alone vs code OR amount arm${note}`, chains, [
      { name: "code arm only", wcOf: (c, p) => c.wcCode[p] },
      { name: "code OR amount arm ← shipped", wcOf: (c, p) => c.wcShipped[p] },
    ]);
  }
  if (!change || change === "context") {
    const wcOf: WcOf = (c, p) => c.wcShipped[p];
    const rung = (label: string, nctx: number, ctxOf: WcOf) => ({
      label: `${label} (${nctx})`,
      result: heldOut({ nsym: NSYM, nctx }, (add) => {
        for (const c of chains) for (let p = 1; p < c.n; p++) add(c.fold, c.res, ctxOf(c, p), wcOf(c, p));
      }),
    });
    printLadder("C. weathercode context: held-out bits/period (5-fold by location; transitions only)", [
      rung("prev ← shipped", NSYM, (c, p) => wcOf(c, p - 1)),
      rung("res × prev", NRES * NSYM, (c, p) => wcOf(c, p - 1) * NRES + c.res),
    ]);
  }
}

runStandalone(import.meta.url, analyze);
