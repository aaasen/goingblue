/**
 * Dewpoint context ladder: held-out (5-fold by location) bits/period for a 1 °C delta chain of
 * dewpoint AND of dewpoint depression (temp - dewpoint), each under the same decoder-available
 * contexts. Temp's alphabet (|Δ|≤7 core + 6-bit escape), local-
 * midnight uniform windows, dewpoint sampled at the hour representativeTemps picked, so a
 * depression would reconstruct dewpoint at the temp's instant.
 *
 * Contexts (all keyed by resolution):
 *   ΔT5     same-period temp delta bucket {≤-2,-1,0,+1,≥+2}
 *   wc4     same-period weathercode class (WEATHERCODE_CLASS: dry/rain/freezing/snow)
 *   wc5     wc4 with fog (45/48) split out of dry
 *   dep5    PREVIOUS period's decoded depression {0,1-2,3-5,6-10,11+}
 *   pΔd5    previous dewpoint delta bucket (order-1)
 *
 *   pnpm exec tsx packages/codec-server/scripts/analyze-dewpoint-entropy.ts [--refine]
 *
 * --refine costs dewpoint only, over bucket-width variants of the winning contexts.
 */
import { rowsFromWindows, HOURS_PER_PERIOD } from "../src/forecast.ts";
import { WEATHERCODE_CLASS, WMO2IDX } from "@weather/protocol";
import { eachForecast, foldOf, N_FOLDS } from "./derive-lib.ts";

const RES_IDXS = [1, 2, 3, 4];
const RES_LABEL: Record<number, string> = { 1: "12h", 2: "6h", 3: "3h", 4: "1h" };
const CORE = 7, NSYM = 2 * CORE + 2, ESC = NSYM - 1, ESC_BITS = 6;
const sym = (d: number) => (Math.abs(d) <= CORE ? d + CORE : ESC);
const b5 = (d: number) => (d <= -2 ? 0 : d === -1 ? 1 : d === 0 ? 2 : d === 1 ? 3 : 4);
const depB = (d: number) => (d <= 0 ? 0 : d <= 2 ? 1 : d <= 5 ? 2 : d <= 10 ? 3 : 4);
const FOG_IDX = new Set([WMO2IDX[45], WMO2IDX[48]]);
const wc5 = (idx: number) => (FOG_IDX.has(idx) ? 4 : WEATHERCODE_CLASS[idx]);

interface Per { fold: number; res: number; s: number; dT: number; wc: number; dep: number; pd: number }
const rows: Per[] = [];
// Compact storage: parallel typed arrays would be nicer, but the corpus fits (≈52M rows).
let n = 0;
const F = new Uint8Array(60e6), R = new Uint8Array(60e6), S = new Uint8Array(60e6), SD = new Uint8Array(60e6),
  DT = new Uint8Array(60e6), DTF = new Uint8Array(60e6), DEPR = new Uint8Array(60e6), TOD = new Uint8Array(60e6), WC = new Uint8Array(60e6), DEP = new Uint8Array(60e6), PD = new Uint8Array(60e6);

await eachForecast((h, _start, loc, pos) => {
  if (!pos) return;
  const times = h.time, temps = h.temperature_2m, dews = h.dew_point_2m as (number | null)[] | undefined;
  if (!times?.length || !temps || !dews) return;
  const off = Math.round(pos.lon / 15);
  const dataStart = Math.floor(Date.parse(`${times[0]}:00Z`) / 3600000);
  const dataEnd = dataStart + times.length;
  const fold = foldOf(loc);
  for (const res of RES_IDXS) {
    const hpp = HOURS_PER_PERIOD[res];
    const firstUtc = Math.ceil((dataStart + off) / 24) * 24 - off;
    const np = Math.floor((dataEnd - firstUtc) / hpp);
    if (np < 3) continue;
    const windows: number[][] = [];
    for (let p = 0; p < np; p++) {
      const w: number[] = [];
      for (let eh = firstUtc + p * hpp; eh < firstUtc + (p + 1) * hpp; eh++) w.push(eh - dataStart);
      windows.push(w);
    }
    const rs = rowsFromWindows(h, times, windows, off);
    if (rs.some((r) => r.temp_c == null || r.weathercode == null)) continue;
    const qD: number[] = [];
    let ok = true;
    for (let p = 0; p < np; p++) {
      const i = windows[p].find((i) => temps[i] === rs[p].temp_c);
      const d = i === undefined ? null : dews[i];
      if (d == null) { ok = false; break; }
      qD.push(Math.round(d));
    }
    if (!ok) continue;
    const qT = rs.map((r) => Math.round(r.temp_c!));
    let prevDelta = 0;
    for (let p = 1; p < np; p++) {
      const dDew = qD[p] - qD[p - 1];
      const dT = qT[p] - qT[p - 1];
      F[n] = fold; R[n] = res; S[n] = sym(dDew); SD[n] = sym(dT - dDew);
      DT[n] = b5(dT);
      DTF[n] = Math.min(Math.max(dT, -7), 7) + 7;
      DEPR[n] = Math.min(Math.max(qT[p - 1] - qD[p - 1], 0), 15);
      TOD[n] = Math.floor(((((firstUtc + p * hpp) * 2 + hpp + off * 2) % 48) + 48) % 48 / 12);
      WC[n] = wc5(WMO2IDX[rs[p].weathercode!] ?? 0);
      DEP[n] = depB(qT[p - 1] - qD[p - 1]);
      PD[n] = p === 1 ? 2 : b5(prevDelta);
      prevDelta = dDew; n++;
    }
  }
}, "train", ["temperature_2m", "dew_point_2m", "weather_code", "rain", "showers", "snowfall"]);
console.log(`${n} deltas`);

type Ctx = { label: string; nctx: number; f: (i: number) => number };
const wc4 = (i: number) => (WC[i] === 4 ? 0 : WC[i]);
const dep3 = (i: number) => (DEP[i] === 0 ? 0 : DEP[i] <= 2 ? 1 : 2);
const dep4 = (i: number) => (DEP[i] === 0 ? 0 : DEP[i] === 1 ? 1 : DEP[i] === 2 ? 2 : 3);
const dt3 = (i: number) => (DT[i] <= 1 ? 0 : DT[i] === 2 ? 1 : 2);
const dt7 = (i: number) => Math.min(Math.max(DTF[i] - 7, -3), 3) + 3;
const dep8 = (i: number) => Math.min(DEPR[i], 7);
const wet2 = (i: number) => (WC[i] === 0 ? 0 : 1);
const pd3 = (i: number) => (PD[i] <= 1 ? 0 : PD[i] === 2 ? 1 : 2);
const dt11 = (i: number) => Math.min(Math.max(DTF[i] - 7, -5), 5) + 5;
const refine: Ctx[] = process.argv.includes("--refine2") ? [
  { label: "ΔT15 × dep5 (ref)", nctx: 75, f: (i) => DTF[i] * 5 + DEP[i] },
  { label: "ΔT11 × dep5", nctx: 55, f: (i) => dt11(i) * 5 + DEP[i] },
  { label: "ΔT15 × dep3", nctx: 45, f: (i) => DTF[i] * 3 + dep3(i) },
  { label: "ΔT15 × dep8", nctx: 120, f: (i) => DTF[i] * 8 + dep8(i) },
  { label: "ΔT15 × dep5 × wet2", nctx: 150, f: (i) => (DTF[i] * 5 + DEP[i]) * 2 + wet2(i) },
  { label: "ΔT15 × dep5 × pΔd3", nctx: 225, f: (i) => (DTF[i] * 5 + DEP[i]) * 3 + pd3(i) },
  { label: "ΔT15 × dep5 × pΔd5", nctx: 375, f: (i) => (DTF[i] * 5 + DEP[i]) * 5 + PD[i] },
] : [
  { label: "ΔT5 × dep5 (ref)", nctx: 25, f: (i) => DT[i] * 5 + DEP[i] },
  { label: "ΔT3 × dep5", nctx: 15, f: (i) => dt3(i) * 5 + DEP[i] },
  { label: "ΔT7 × dep5", nctx: 35, f: (i) => dt7(i) * 5 + DEP[i] },
  { label: "ΔT15 × dep5", nctx: 75, f: (i) => DTF[i] * 5 + DEP[i] },
  { label: "ΔT5 × dep3", nctx: 15, f: (i) => DT[i] * 3 + dep3(i) },
  { label: "ΔT5 × dep4", nctx: 20, f: (i) => DT[i] * 4 + dep4(i) },
  { label: "ΔT5 × dep8", nctx: 40, f: (i) => DT[i] * 8 + dep8(i) },
  { label: "ΔT5 × dep16", nctx: 80, f: (i) => DT[i] * 16 + DEPR[i] },
  { label: "ΔT7 × dep8", nctx: 56, f: (i) => dt7(i) * 8 + dep8(i) },
  { label: "ΔT5 × dep5 × wet2", nctx: 50, f: (i) => (DT[i] * 5 + DEP[i]) * 2 + wet2(i) },
  { label: "ΔT5 × dep5 × pΔd3", nctx: 75, f: (i) => (DT[i] * 5 + DEP[i]) * 3 + pd3(i) },
  { label: "ΔT5 × dep5 × tod4", nctx: 100, f: (i) => (DT[i] * 5 + DEP[i]) * 4 + TOD[i] },
  { label: "ΔT5 × dep5 × pΔd5", nctx: 125, f: (i) => (DT[i] * 5 + DEP[i]) * 5 + PD[i] },
  { label: "ΔT7 × dep8 × pΔd3", nctx: 168, f: (i) => (dt7(i) * 8 + dep8(i)) * 3 + pd3(i) },
];
const ladder: Ctx[] = process.argv.some((a) => a.startsWith("--refine")) ? refine : [
  { label: "res only", nctx: 1, f: () => 0 },
  { label: "ΔT5", nctx: 5, f: (i) => DT[i] },
  { label: "wc4", nctx: 4, f: (i) => wc4(i) },
  { label: "wc5 (fog)", nctx: 5, f: (i) => WC[i] },
  { label: "dep5", nctx: 5, f: (i) => DEP[i] },
  { label: "pΔd5", nctx: 5, f: (i) => PD[i] },
  { label: "ΔT5 × wc4", nctx: 20, f: (i) => DT[i] * 4 + wc4(i) },
  { label: "ΔT5 × wc5", nctx: 25, f: (i) => DT[i] * 5 + WC[i] },
  { label: "ΔT5 × dep5", nctx: 25, f: (i) => DT[i] * 5 + DEP[i] },
  { label: "ΔT5 × pΔd5", nctx: 25, f: (i) => DT[i] * 5 + PD[i] },
  { label: "wc5 × dep5", nctx: 25, f: (i) => WC[i] * 5 + DEP[i] },
  { label: "ΔT5 × wc5 × dep5", nctx: 125, f: (i) => (DT[i] * 5 + WC[i]) * 5 + DEP[i] },
  { label: "ΔT5 × dep5 × pΔd5", nctx: 125, f: (i) => (DT[i] * 5 + DEP[i]) * 5 + PD[i] },
  { label: "ΔT5 × wc5 × pΔd5", nctx: 125, f: (i) => (DT[i] * 5 + WC[i]) * 5 + PD[i] },
  { label: "ΔT5 × wc5 × dep5 × pΔd5", nctx: 625, f: (i) => ((DT[i] * 5 + WC[i]) * 5 + DEP[i]) * 5 + PD[i] },
];

// Held-out: for each fold, tables from the other folds (+1 smoothing), cost the held fold.
function heldOut(c: Ctx, S: Uint8Array): Record<number, number> {
  const rows = 5 * c.nctx * N_FOLDS;
  const cnt = new Float64Array(rows * NSYM);
  for (let i = 0; i < n; i++) cnt[((F[i] * 5 + R[i]) * c.nctx + c.f(i)) * NSYM + S[i]]++;
  const bits: Record<number, number> = {}, cnts: Record<number, number> = {};
  for (const r of RES_IDXS) { bits[r] = 0; cnts[r] = 0; }
  for (let fold = 0; fold < N_FOLDS; fold++) {
    for (const r of RES_IDXS) for (let k = 0; k < c.nctx; k++) {
      const train = new Float64Array(NSYM).fill(1);
      for (let g = 0; g < N_FOLDS; g++) if (g !== fold)
        for (let s = 0; s < NSYM; s++) train[s] += cnt[((g * 5 + r) * c.nctx + k) * NSYM + s];
      const tot = train.reduce((a, b) => a + b, 0);
      const held = ((fold * 5 + r) * c.nctx + k) * NSYM;
      for (let s = 0; s < NSYM; s++) {
        const m = cnt[held + s];
        if (!m) continue;
        bits[r] += m * (-Math.log2(train[s] / tot) + (s === ESC ? ESC_BITS : 0));
        cnts[r] += m;
      }
    }
  }
  for (const r of RES_IDXS) bits[r] /= cnts[r];
  return bits;
}

console.log("\n" + "context".padEnd(27) + "|  Δdewpoint " + RES_IDXS.map((r) => RES_LABEL[r].padStart(7)).join("")
  + "  |  Δdepression " + RES_IDXS.map((r) => RES_LABEL[r].padStart(7)).join("") + "  |  dep−dew");
const dewOnly = process.argv.some((a) => a.startsWith("--refine"));
for (const c of ladder) {
  const a = heldOut(c, S);
  if (dewOnly) { console.log(c.label.padEnd(27) + String(c.nctx).padStart(4) + RES_IDXS.map((r) => a[r].toFixed(3).padStart(8)).join("")); continue; }
  const b = heldOut(c, SD);
  console.log(c.label.padEnd(27) + "|            " + RES_IDXS.map((r) => a[r].toFixed(3).padStart(7)).join("")
    + "  |              " + RES_IDXS.map((r) => b[r].toFixed(3).padStart(7)).join("")
    + "  | " + RES_IDXS.map((r) => (b[r] - a[r]).toFixed(3).padStart(7)).join(""));
}
// Occupancy of the weathercode classes, for reading the wc rows.
const occ = new Array(5).fill(0); for (let i = 0; i < n; i++) occ[WC[i]]++;
console.log("\nwc5 share: " + ["dry", "rain", "freezing", "snow", "fog"].map((l, k) => `${l} ${(occ[k] / n * 100).toFixed(1)}%`).join("  "));
