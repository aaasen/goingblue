/**
 * Dewpoint context ladder: held-out (5-fold by location) bits/period for a 1 °C delta chain of
 * dewpoint AND of dewpoint depression (temp − dewpoint), each under the same decoder-available
 * contexts. Temp's alphabet (|Δ| ≤ 7 core + 6-bit escape), local-midnight windows, the dewpoint
 * sampled at the hour representativeTemps picked (rowsFromWindows), both chains clamped and
 * diffed against their reconstructions exactly as derive-dewpoint-codebooks.ts trains them.
 *
 * Contexts (all keyed by resolution):
 *   ΔT5     same-period temp delta bucket {≤-2, -1, 0, +1, ≥+2} (tempDeltaBucket)
 *   ΔT15    same-period temp delta, exact within the core (dewpointTempCtx)
 *   wc4     same-period weathercode class (WEATHERCODE_CLASS: dry/rain/freezing/snow)
 *   wc5     wc4 with fog (45/48) split out of dry
 *   dep5    PREVIOUS period's decoded depression {0, 1-2, 3-5, 6-10, 11+} (dewpointDepressionBucket)
 *   pΔd5    previous dewpoint delta bucket (order-1)
 *   ΔT15 × dep5   ← shipped
 *
 * OUTCOME (2026-09-01): res-only 4.024/3.373/2.709/1.748 (12h/6h/3h/1h) → ΔT15 × dep5
 * 3.550/2.915/2.351/1.582. The depression chain lost to the dewpoint chain under every context.
 *
 *   pnpm exec tsx packages/codec-server/scripts/analyze/dewpoint.ts [--stride N] [--refine | --refine2]
 *
 * --refine costs dewpoint only, over bucket-width variants of the winning contexts; --refine2
 * over variants stacked on the shipped pair.
 */
import { toFullPeriod } from "../../src/forecast.ts";
import {
  VAR, type Variable, WEATHERCODE_CLASS, WMO2IDX,
  TEMP_DELTA_CORE_RADIUS, TEMP_DELTA_MIN, TEMP_DELTA_MAX, TEMP_DELTA_ESCAPE_BITS,
  tempDeltaBucket, dewpointTempCtx, dewpointDepressionBucket,
  DEWPOINT_TEMP_CTX, DEWPOINT_DEPRESSION_BUCKETS,
} from "@weather/protocol";
import {
  NRES, argStride, eachColumn, heldOut, localMidHalfHours, printLadder, runStandalone, type Rung,
} from "./lib.ts";

const NSYM = 2 * TEMP_DELTA_CORE_RADIUS + 2;
const ESC = NSYM - 1;
const escapeBits = (s: number) => (s === ESC ? TEMP_DELTA_ESCAPE_BITS : 0);
const sym = (d: number) => (Math.abs(d) <= TEMP_DELTA_CORE_RADIUS ? d + TEMP_DELTA_CORE_RADIUS : ESC);
const quant = (c: number) => Math.min(Math.max(Math.round(c + 100), 0), 255);
const clampDelta = (d: number) => Math.min(Math.max(d, TEMP_DELTA_MIN), TEMP_DELTA_MAX);
const FOG_IDX = new Set([WMO2IDX[45], WMO2IDX[48]]);
const wc5Of = (idx: number) => (FOG_IDX.has(idx) ? 4 : WEATHERCODE_CLASS[idx]);
const DEWPOINT_VARS: ReadonlySet<Variable> = new Set([VAR.temp, VAR.dewpoint]);

// One growable byte column per feature: the full corpus is ~52M deltas, so the features live in
// flat typed arrays rather than per-column objects.
class Bytes {
  buf = new Uint8Array(1 << 20);
  n = 0;
  push(v: number): void {
    if (this.n === this.buf.length) { const b = new Uint8Array(this.buf.length * 2); b.set(this.buf); this.buf = b; }
    this.buf[this.n++] = v;
  }
}
const F = new Bytes(), R = new Bytes(), S = new Bytes(), SD = new Bytes(), DT5 = new Bytes(), DT15 = new Bytes(),
  DEPR = new Bytes(), DEP5 = new Bytes(), TOD = new Bytes(), WC = new Bytes(), PD = new Bytes();

async function collect(stride: number): Promise<number> {
  await eachColumn({ vars: ["temperature_2m", "dew_point_2m", "weather_code", "rain", "showers", "snowfall"], stride }, (col) => {
    const { rows, n } = col.slice;
    if (rows.some((r) => r.temp_c == null || r.dewpoint_c == null || r.weathercode == null)) return;
    const periods = rows.map((r) => toFullPeriod(r, DEWPOINT_VARS, "US"));
    let tempRecon = quant(periods[0].temp_c!);
    // Anchor: the depression against the temp anchor, clamped to the 6-bit field like the wire.
    let dewRecon = tempRecon - Math.min(Math.max(tempRecon - quant(periods[0].dewpoint_c!), 0), 63);
    let prevDewDelta: number | null = null;
    for (let p = 1; p < n; p++) {
      const tempDelta = clampDelta(quant(periods[p].temp_c!) - tempRecon);
      const prevDepression = tempRecon - dewRecon;
      tempRecon += tempDelta;
      const dewDelta = clampDelta(quant(periods[p].dewpoint_c!) - dewRecon);
      F.push(col.fold); R.push(col.res);
      S.push(sym(dewDelta));
      SD.push(sym(tempDelta - dewDelta)); // the depression chain's delta
      DT5.push(tempDeltaBucket(tempDelta));
      DT15.push(dewpointTempCtx(tempDelta));
      DEPR.push(Math.min(Math.max(prevDepression, 0), 15));
      DEP5.push(dewpointDepressionBucket(prevDepression));
      TOD.push(Math.floor((((localMidHalfHours(col, p) % 48) + 48) % 48) / 12));
      WC.push(wc5Of(WMO2IDX[rows[p].weathercode!] ?? 0));
      PD.push(prevDewDelta === null ? 2 : tempDeltaBucket(prevDewDelta));
      prevDewDelta = dewDelta;
      dewRecon += dewDelta;
    }
  });
  return F.n;
}

interface Ctx { label: string; nctx: number; f: (i: number) => number }

const wc4 = (i: number) => (WC.buf[i] === 4 ? 0 : WC.buf[i]);
const dep3 = (i: number) => (DEP5.buf[i] === 0 ? 0 : DEP5.buf[i] <= 2 ? 1 : 2);
const dep4 = (i: number) => Math.min(DEP5.buf[i], 3);
const dep8 = (i: number) => Math.min(DEPR.buf[i], 7);
const dt3 = (i: number) => (DT5.buf[i] <= 1 ? 0 : DT5.buf[i] === 2 ? 1 : 2);
const dt7 = (i: number) => Math.min(Math.max(DT15.buf[i] - 7, -3), 3) + 3;
const dt11 = (i: number) => Math.min(Math.max(DT15.buf[i] - 7, -5), 5) + 5;
const wet2 = (i: number) => (WC.buf[i] === 0 ? 0 : 1);
const pd3 = (i: number) => (PD.buf[i] <= 1 ? 0 : PD.buf[i] === 2 ? 1 : 2);
const shipped = (i: number) => DT15.buf[i] * DEWPOINT_DEPRESSION_BUCKETS + DEP5.buf[i];
const N_SHIPPED = DEWPOINT_TEMP_CTX * DEWPOINT_DEPRESSION_BUCKETS; // 75

const LADDER: Ctx[] = [
  { label: "res only", nctx: 1, f: () => 0 },
  { label: "ΔT5", nctx: 5, f: (i) => DT5.buf[i] },
  { label: "wc4", nctx: 4, f: wc4 },
  { label: "wc5 (fog)", nctx: 5, f: (i) => WC.buf[i] },
  { label: "dep5", nctx: 5, f: (i) => DEP5.buf[i] },
  { label: "pΔd5", nctx: 5, f: (i) => PD.buf[i] },
  { label: "ΔT5 × wc4", nctx: 20, f: (i) => DT5.buf[i] * 4 + wc4(i) },
  { label: "ΔT5 × wc5", nctx: 25, f: (i) => DT5.buf[i] * 5 + WC.buf[i] },
  { label: "ΔT5 × dep5", nctx: 25, f: (i) => DT5.buf[i] * 5 + DEP5.buf[i] },
  { label: "ΔT5 × pΔd5", nctx: 25, f: (i) => DT5.buf[i] * 5 + PD.buf[i] },
  { label: "wc5 × dep5", nctx: 25, f: (i) => WC.buf[i] * 5 + DEP5.buf[i] },
  { label: "ΔT15 × dep5 ← shipped", nctx: N_SHIPPED, f: shipped },
  { label: "ΔT5 × wc5 × dep5", nctx: 125, f: (i) => (DT5.buf[i] * 5 + WC.buf[i]) * 5 + DEP5.buf[i] },
  { label: "ΔT5 × dep5 × pΔd5", nctx: 125, f: (i) => (DT5.buf[i] * 5 + DEP5.buf[i]) * 5 + PD.buf[i] },
  { label: "ΔT5 × wc5 × pΔd5", nctx: 125, f: (i) => (DT5.buf[i] * 5 + WC.buf[i]) * 5 + PD.buf[i] },
  { label: "ΔT5 × wc5 × dep5 × pΔd5", nctx: 625, f: (i) => ((DT5.buf[i] * 5 + WC.buf[i]) * 5 + DEP5.buf[i]) * 5 + PD.buf[i] },
];
const REFINE: Ctx[] = [
  { label: "ΔT5 × dep5 (ref)", nctx: 25, f: (i) => DT5.buf[i] * 5 + DEP5.buf[i] },
  { label: "ΔT3 × dep5", nctx: 15, f: (i) => dt3(i) * 5 + DEP5.buf[i] },
  { label: "ΔT7 × dep5", nctx: 35, f: (i) => dt7(i) * 5 + DEP5.buf[i] },
  { label: "ΔT15 × dep5 ← shipped", nctx: N_SHIPPED, f: shipped },
  { label: "ΔT5 × dep3", nctx: 15, f: (i) => DT5.buf[i] * 3 + dep3(i) },
  { label: "ΔT5 × dep4", nctx: 20, f: (i) => DT5.buf[i] * 4 + dep4(i) },
  { label: "ΔT5 × dep8", nctx: 40, f: (i) => DT5.buf[i] * 8 + dep8(i) },
  { label: "ΔT5 × dep16", nctx: 80, f: (i) => DT5.buf[i] * 16 + DEPR.buf[i] },
  { label: "ΔT7 × dep8", nctx: 56, f: (i) => dt7(i) * 8 + dep8(i) },
  { label: "ΔT5 × dep5 × wet2", nctx: 50, f: (i) => (DT5.buf[i] * 5 + DEP5.buf[i]) * 2 + wet2(i) },
  { label: "ΔT5 × dep5 × pΔd3", nctx: 75, f: (i) => (DT5.buf[i] * 5 + DEP5.buf[i]) * 3 + pd3(i) },
  { label: "ΔT5 × dep5 × tod4", nctx: 100, f: (i) => (DT5.buf[i] * 5 + DEP5.buf[i]) * 4 + TOD.buf[i] },
  { label: "ΔT5 × dep5 × pΔd5", nctx: 125, f: (i) => (DT5.buf[i] * 5 + DEP5.buf[i]) * 5 + PD.buf[i] },
  { label: "ΔT7 × dep8 × pΔd3", nctx: 168, f: (i) => (dt7(i) * 8 + dep8(i)) * 3 + pd3(i) },
];
const REFINE2: Ctx[] = [
  { label: "ΔT15 × dep5 ← shipped", nctx: N_SHIPPED, f: shipped },
  { label: "ΔT11 × dep5", nctx: 55, f: (i) => dt11(i) * 5 + DEP5.buf[i] },
  { label: "ΔT15 × dep3", nctx: 45, f: (i) => DT15.buf[i] * 3 + dep3(i) },
  { label: "ΔT15 × dep8", nctx: 120, f: (i) => DT15.buf[i] * 8 + dep8(i) },
  { label: "ΔT15 × dep5 × wet2", nctx: 150, f: (i) => shipped(i) * 2 + wet2(i) },
  { label: "ΔT15 × dep5 × pΔd3", nctx: 225, f: (i) => shipped(i) * 3 + pd3(i) },
  { label: "ΔT15 × dep5 × pΔd5", nctx: 375, f: (i) => shipped(i) * 5 + PD.buf[i] },
];

// Every context is keyed by resolution on top of its own axis: the tables ship per resolution.
function rung(c: Ctx, target: Bytes): Rung {
  const result = heldOut({ nsym: NSYM, nctx: c.nctx * NRES, extraBits: escapeBits }, (add) => {
    for (let i = 0; i < F.n; i++) add(F.buf[i], R.buf[i], c.f(i) * NRES + R.buf[i], target.buf[i]);
  });
  return { label: `${c.label} (${c.nctx * NRES} ctx)`, result };
}

export async function analyze(args: string[]): Promise<void> {
  const n = await collect(argStride(args));
  console.log(`${n} deltas`);
  const refine = args.includes("--refine2") ? REFINE2 : args.includes("--refine") ? REFINE : null;
  const ladder = refine ?? LADDER;
  printLadder("Δdewpoint chain: held-out bits/period (5-fold by location; escape +6b payload included)",
    ladder.map((c) => rung(c, S)));
  if (!refine)
    printLadder("Δdepression chain (temp − dewpoint) under the same contexts", ladder.map((c) => rung(c, SD)));
  const occ = new Array<number>(5).fill(0);
  for (let i = 0; i < n; i++) occ[WC.buf[i]]++;
  console.log("\nwc5 share: " + ["dry", "rain", "freezing", "snow", "fog"].map((l, k) => `${l} ${(occ[k] / n * 100).toFixed(1)}%`).join("  "));
}

runStandalone(import.meta.url, analyze);
