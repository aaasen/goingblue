/**
 * Shared helpers for the entropy analysis scripts (analyze/<name>.ts, one per derive codebook).
 * Each script exports `analyze(args)` and answers one question about its codebook's
 * conditioning: held-out bits/period, 5-fold by location, for a ladder of candidate contexts.
 * The derive scripts train on the winner; the ladder here is the record of why.
 *
 * Every scan walks the corpus through eachColumn, which hands out the SAME per-cell aggregation
 * the derive scripts train on (CellCtx.atMidnight: local-midnight-aligned windows at the four
 * resolutions layouts emit), so a context measured here is measured on the symbol stream the
 * encoder emits. Costs come from heldOut, which floors training counts with scaledWeights
 * exactly as the shipped tables are, so a rung's number is what the table would cost.
 *
 * Run a script directly:
 *
 *   pnpm exec tsx packages/codec-server/scripts/analyze/<name>.ts [--stride N] [script flags]
 *
 * --stride N keeps one train cell in N (eachForecast's shard argument, which skips before the
 * read), for a quick look at a scan whose full pass takes an hour.
 */
import { fileURLToPath } from "node:url";
import { RESOLUTION_HOURS, TABLE_RES_IDXS } from "@weather/protocol";
import type { HourlyData } from "../../src/forecast.ts";
import {
  eachForecast, foldOf, makeCellCtx, N_FOLDS, scaledWeights, type CellCtx, type ResSlice,
} from "../derive-lib.ts";

export { N_FOLDS };

// The resolutions layouts emit, in codebook row order (12h/6h/3h/1h), and their labels.
export const RES_IDXS: readonly number[] = TABLE_RES_IDXS;
export const NRES = RES_IDXS.length;
export const RES_LABEL: readonly string[] = RES_IDXS.map((r) => `${RESOLUTION_HOURS[r]}h`);

// ── Arguments ────────────────────────────────────────────────────────────────────

// `--name value` → value, or `fallback` when absent.
export function argValue(args: readonly string[], name: string, fallback: string): string {
  const i = args.indexOf(name);
  return i >= 0 && i + 1 < args.length ? args[i + 1] : fallback;
}

export function argStride(args: readonly string[], fallback = 1): number {
  return Math.max(1, Number(argValue(args, "--stride", String(fallback))) || fallback);
}

// ── Column scan ──────────────────────────────────────────────────────────────────

// One (cell × resolution) column: the shared midnight-aligned slice plus what a scan keys on.
export interface Column {
  fold: number;              // held-out fold of the cell's location (foldOf)
  res: number;               // row into RES_IDXS (0 = 12h … 3 = 1h)
  resIdx: number;            // the resolution index itself (RES_IDXS[res])
  slice: ResSlice;           // hpp, first period's UTC epoch hour, period count, aggregated rows
  ctx: CellCtx;              // the cell (hourly series, position) for scans that read hours
  utcOffset: number;         // whole hours, the offset the windows were aligned with
  dataStart: number;         // UTC epoch hour of the cell's first hourly sample
  elevM?: number;
}

export interface ColumnScan {
  // Series to load (eachForecast's `vars`); null loads everything.
  vars: readonly string[] | null;
  split?: "train" | "eval" | "all";
  stride?: number;
  // Resolutions to visit, as RES_IDXS rows; default all four.
  resRows?: readonly number[];
  fillBand?: boolean;
}

// Visits every column of the split at the framing the wire uses. Returns the cell count.
export async function eachColumn(scan: ColumnScan, cb: (col: Column) => void): Promise<number> {
  const resRows = scan.resRows ?? RES_IDXS.map((_, i) => i);
  const stride = scan.stride ?? 1;
  let cells = 0;
  await eachForecast((h, _startHour, loc, pos, _split, elevM) => {
    if (!pos || !h.time?.length) return;
    cells++;
    const ctx = makeCellCtx(h, pos);
    const fold = foldOf(loc);
    const utcOffset = Math.round(pos.lon / 15);
    const dataStart = Math.floor(Date.parse(`${h.time[0]}:00Z`) / 3600000);
    for (const res of resRows) {
      const slice = ctx.atMidnight(RES_IDXS[res]);
      if (!slice) continue;
      cb({ fold, res, resIdx: RES_IDXS[res], slice, ctx, utcOffset, dataStart, elevM });
    }
  }, scan.split ?? "train", scan.vars, stride > 1 ? { index: 0, total: stride } : undefined,
  scan.fillBand ?? true);
  return cells;
}

// Hourly sample index range [from, to) of the column's period p.
export function hourRange(col: Column, p: number): [number, number] {
  const from = col.slice.start + p * col.slice.hpp - col.dataStart;
  return [from, from + col.slice.hpp];
}

// The arriving period's local midpoint in half-hours (the argument tempTodBucket takes).
export function localMidHalfHours(col: Column, p: number): number {
  const { start, hpp } = col.slice;
  return (start + p * hpp) * 2 + hpp + col.utcOffset * 2;
}

export const hourlyOf = (col: Column): HourlyData => col.ctx.hourly;

// ── Held-out evaluation ──────────────────────────────────────────────────────────

export interface Scheme {
  nsym: number;
  nctx: number;
  // Reporting axis (per-resolution columns by default). Training pools every group of a
  // context; the split is only for the report.
  nGroup?: number;
  // Raw payload charged after a symbol (an escape's fixed-width field).
  extraBits?: (sym: number) => number;
  // Which contexts an EMPTY training context borrows from: contexts with the same key are pooled
  // into its fallback row. Default: one pool over every context.
  fallbackOf?: (ctx: number) => number;
}

export interface HeldOut {
  bpp: number;
  n: number;
  byGroup: { bpp: number; n: number }[];
  byFold: number[];          // bpp per held-out fold, for paired comparisons between rungs
  occupancy: number[];       // mean training symbols per context (over the five folds)
  occMin: number;
  occMed: number;
}

// Bits to code `test` under scaledWeights(train), the flooring the shipped tables get, with each
// symbol's raw payload on top.
function heldOutBits(train: ArrayLike<number>, test: ArrayLike<number>, extra?: (s: number) => number): number {
  const w = scaledWeights(Array.from(train));
  let total = 0;
  for (const x of w) total += x;
  let bits = 0;
  for (let s = 0; s < w.length; s++) {
    if (test[s] === 0) continue;
    bits += test[s] * (-Math.log2(w[s] / total) + (extra ? extra(s) : 0));
  }
  return bits;
}

// Held-out (5-fold by location) cost of one scheme. `count` emits every symbol the scheme
// would code, as (fold, group, ctx, sym); for each fold the tables are trained on the other four
// and the fold is costed under them.
export function heldOut(scheme: Scheme, count: (add: (fold: number, group: number, ctx: number, sym: number) => void) => void): HeldOut {
  const { nsym, nctx } = scheme;
  const nGroup = scheme.nGroup ?? NRES;
  const counts = new Float64Array(N_FOLDS * nGroup * nctx * nsym);
  const at = (fold: number, group: number, ctx: number) => ((fold * nGroup + group) * nctx + ctx) * nsym;
  count((fold, group, ctx, sym) => { counts[at(fold, group, ctx) + sym]++; });

  const fallbackOf = scheme.fallbackOf ?? (() => 0);
  const poolOf = Array.from({ length: nctx }, (_, c) => fallbackOf(c));
  const nPool = Math.max(0, ...poolOf) + 1;

  const groupBits = new Float64Array(nGroup), groupN = new Float64Array(nGroup);
  const byFold: number[] = [];
  const occupancy = new Array<number>(nctx).fill(0);
  const train = new Float64Array(nsym), fallback = new Float64Array(nPool * nsym);
  for (let fold = 0; fold < N_FOLDS; fold++) {
    fallback.fill(0);
    // Every context's training row is summed on demand; the fallback pools are summed once.
    for (let f = 0; f < N_FOLDS; f++) {
      if (f === fold) continue;
      for (let g = 0; g < nGroup; g++) for (let c = 0; c < nctx; c++) {
        const base = at(f, g, c), pool = poolOf[c] * nsym;
        for (let s = 0; s < nsym; s++) fallback[pool + s] += counts[base + s];
      }
    }
    let foldBits = 0, foldN = 0;
    for (let c = 0; c < nctx; c++) {
      train.fill(0);
      let trainN = 0;
      for (let f = 0; f < N_FOLDS; f++) {
        if (f === fold) continue;
        for (let g = 0; g < nGroup; g++) {
          const base = at(f, g, c);
          for (let s = 0; s < nsym; s++) { train[s] += counts[base + s]; trainN += counts[base + s]; }
        }
      }
      occupancy[c] += trainN / N_FOLDS;
      const table = trainN > 0 ? train : fallback.subarray(poolOf[c] * nsym, (poolOf[c] + 1) * nsym);
      for (let g = 0; g < nGroup; g++) {
        const test = counts.subarray(at(fold, g, c), at(fold, g, c) + nsym);
        let testN = 0;
        for (let s = 0; s < nsym; s++) testN += test[s];
        if (testN === 0) continue;
        const bits = heldOutBits(table, test, scheme.extraBits);
        groupBits[g] += bits; groupN[g] += testN;
        foldBits += bits; foldN += testN;
      }
    }
    byFold.push(foldBits / Math.max(1, foldN));
  }
  let bits = 0, n = 0;
  for (let g = 0; g < nGroup; g++) { bits += groupBits[g]; n += groupN[g]; }
  const occSorted = occupancy.map(Math.round).sort((a, b) => a - b);
  return {
    bpp: bits / Math.max(1, n), n,
    byGroup: Array.from({ length: nGroup }, (_, g) => ({ bpp: groupBits[g] / Math.max(1, groupN[g]), n: groupN[g] })),
    byFold, occupancy,
    occMin: occSorted[0] ?? 0, occMed: occSorted[occSorted.length >> 1] ?? 0,
  };
}

// ── Reports ──────────────────────────────────────────────────────────────────────

export interface Rung { label: string; result: HeldOut }

const fmt = (x: number) => x.toFixed(3);
const signed = (x: number) => (x > 0 ? "+" : "") + fmt(x);

// One ladder: overall b/period, the change against the first rung, one column per group, and
// the training occupancy (a rung whose thin contexts train badly is not a win).
export function printLadder(title: string, rungs: Rung[], groupLabels: readonly string[] = RES_LABEL): void {
  const width = Math.max(30, ...rungs.map((r) => r.label.length + 2));
  console.log(`\n${title}`);
  console.log(`${"rung".padEnd(width)} overall        ${groupLabels.map((l) => l.padStart(7)).join("")}   train occ`);
  const base = rungs[0]?.result.bpp;
  for (const { label, result } of rungs) {
    const delta = result.bpp - base;
    console.log(`${label.padEnd(width)} ${fmt(result.bpp).padStart(7)} ${(delta === 0 ? "" : signed(delta)).padStart(7)}` +
      `${result.byGroup.map((g) => (g.n ? fmt(g.bpp) : "  -  ").padStart(7)).join("")}` +
      `   min=${result.occMin} med=${result.occMed}`);
  }
}

// Per-fold b/period for the rungs that matter: folds split by location, so a gap whose sign
// holds in every fold is geography-independent, not noise.
export function printFolds(rungs: Rung[]): void {
  const width = Math.max(30, ...rungs.map((r) => r.label.length + 2));
  console.log(`\nPer-fold b/period (paired; a consistent sign across folds is not noise)`);
  console.log(`${"rung".padEnd(width)} ${Array.from({ length: N_FOLDS }, (_, f) => `fold${f}`.padStart(7)).join(" ")}`);
  for (const { label, result } of rungs)
    console.log(`${label.padEnd(width)} ${result.byFold.map((b) => fmt(b).padStart(7)).join(" ")}`);
}

// Direct-run guard: `pnpm exec tsx scripts/analyze/foo.ts` runs the script's analyze() with the
// command-line arguments.
export function runStandalone(moduleUrl: string, analyze: (args: string[]) => Promise<void>): void {
  if (process.argv[1] !== fileURLToPath(moduleUrl)) return;
  analyze(process.argv.slice(2)).catch((e) => { console.error(e); process.exit(1); });
}
