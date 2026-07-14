/**
 * Cross-variable conditioning scan: held-out (5-fold by location) bits/period for each column
 * under its CURRENT shipped context vs current + a candidate same-period cross-variable signal.
 * Columns decode in a fixed order (weathercode → temp → freeze → clouds → precip → snow → rain →
 * wind), so a later column may key its codebooks on any earlier column's already-decoded
 * same-period value — free context, exactly like the 600/700 hPa wind columns' upper-level
 * conditioning. This scan produces the ranked shopping list; winners then get the full
 * derive + wire treatment.
 *
 * Candidates (all same-period, all decoded before the target):
 *   precip   ← weathercode class {dry, rain, freezing, snow}
 *   snow     ← weathercode class; precip-chance bucket {0, 1-4, 5-7}
 *   rain     ← weathercode class; snow ≠ 0
 *   clouds   ← resolution (pooled at scan time); weathercode class
 *   freeze   ← resolution (pooled at scan time); same-period temp-delta bucket
 *   wcode    ← resolution (order-1 table trained at 1h and applied everywhere)
 *
 * Deliberately skipped: temp (already 160 contexts; × anything is too thin at this corpus size)
 * and wind (already conditioned on res × level × upper-level).
 *
 * OUTCOME — this is now a historical scan; its "baseline" rows for the three wet columns measure
 * the context they had BEFORE it ran:
 *   SHIPPED: precip / snow / rain + wcClass (0.978 → 0.876, 0.708 → 0.445, 1.101 → 0.770 b/period).
 *     Stacked candidates (rain also on snow ≠ 0, snow also on the precip bucket) were redundant
 *     with the class. See derive-precip-accum-codebooks.ts and WEATHERCODE_CLASS in entropy.ts.
 *   REJECTED: clouds × anything (-0.03), weathercode × res (-0.033) — too small to pay for.
 *   SHIPPED: freeze × (res × same-period tempΔ bucket). Initially deferred (-0.131 under the old
 *     4-bit anchor, whose 15,000 ft cap real forecasts clipped at); re-scanned after the anchor
 *     widened to 5 bits and the gain held: pooled 1.445 → res 1.393 → res × tempΔ 1.308 b/period
 *     (-0.136, occ min=858). See derive-freeze-delta-codebooks.ts and freezeDeltaBook in
 *     entropy.ts.
 *
 *   node packages/server/scripts/analyze-cross-var-heldout.ts
 */
import { rowsFromWindows, toFullPeriod, HOURS_PER_PERIOD } from "../src/forecast.ts";
import {
  WMO2IDX, VARS_BIT, compandSqrt, SNOW_K, RAIN_K, ACCUM_BITS,
  WEATHERCODE_CLASS, WC_CLASSES,
  tempDeltaBucket, TEMP_DELTA_PREV_BUCKETS, TEMP_DELTA_MIN, TEMP_DELTA_MAX,
  type Period,
} from "@weather/protocol";
import { eachForecast, foldOf, N_FOLDS, scaledWeights } from "./derive-lib.ts";

const RES_IDXS = [1, 2, 3, 4]; // 12h/6h/3h/1h — layouts never emit 24h
const NRES = RES_IDXS.length;
const resPos: Record<number, number> = Object.fromEntries(RES_IDXS.map((r, i) => [r, i]));

const clampInt = (v: number, width: number) => Math.min(Math.max(v, 0), (1 << width) - 1);
// must match entropy.ts ACCUM_BUCKET_EDGES
const ACCUM_EDGES = [1, 4, 10, 21];
const accumBucket = (v: number) => { let b = 0; for (const e of ACCUM_EDGES) { if (v < e) break; b++; } return b; };
const N_ACCUM_B = ACCUM_EDGES.length + 1;

// Same-period weathercode class: dry (clear/cloud/fog) | rain-ish (drizzle/rain/showers/thunder) |
// freezing (freezing drizzle/rain) | snow-ish (snow/snow showers). Now wire format — imported from
// the protocol (WEATHERCODE_CLASS) rather than restated here, so the scan can't drift from what
// the wet columns actually key on. Indexed by WMO symbol, as the codecs are.
const N_WC_CLASS = WC_CLASSES;

// Precip-chance bucket for the snow candidate: 0 | 1-4 | 5-7 (of the 3-bit chance domain).
const precipBucket = (sym: number) => (sym === 0 ? 0 : sym <= 4 ? 1 : 2);
const N_PRECIP_B = 3;

const ALL_MASK = ((1 << 13) - 1) & ~(1 << 8);

// One uniform-resolution column: per-period quantized symbols/features, aligned by period index.
interface Chain {
  fold: number;
  res: number;
  n: number;
  wcSym: number[];    // WMO index 0..27 (order-1 target + wcClass source)
  wcClass: number[];
  precip: number[];   // 0..7 value symbols
  snow: number[];     // 0..63 companded value symbols
  rain: number[];
  cch: number[]; ccm: number[]; ccl: number[]; // quantized 0..7 levels (deltas derived)
  freezeQ: number[];  // quantized 0..31 (deltas derived)
  tempDB: number[];   // same-period temp-delta bucket (0..4), p ≥ 1; -1 at p = 0
}

async function collectChains(): Promise<Chain[]> {
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
        .map((r) => toFullPeriod(r, ALL_MASK, "GFS"));

      const c: Chain = {
        fold, res, n,
        wcSym: periods.map((p) => WMO2IDX[p.weathercode] ?? 0),
        wcClass: periods.map((p) => WEATHERCODE_CLASS[WMO2IDX[p.weathercode] ?? 0]),
        precip: periods.map((p) => clampInt(Math.round((p.precip ?? 0) * 7 / 100), 3)),
        snow: periods.map((p) => compandSqrt(p.snow_cm ?? 0, SNOW_K, ACCUM_BITS)),
        rain: periods.map((p) => compandSqrt(p.rain_mm ?? 0, RAIN_K, ACCUM_BITS)),
        cch: periods.map((p) => clampInt(Math.round((p.cloud_high ?? 0) * 7 / 100), 3)),
        ccm: periods.map((p) => clampInt(Math.round((p.cloud_mid ?? 0) * 7 / 100), 3)),
        ccl: periods.map((p) => clampInt(Math.round((p.cloud_low ?? 0) * 7 / 100), 3)),
        freezeQ: periods.map((p) => clampInt(Math.floor((p.freeze_m ?? 0) / 304.8 + 1e-9), 5)),
        tempDB: [-1],
      };
      // Same-period temp-delta bucket, from the clamped wire chain (temp decodes before freeze).
      let recon = clampInt(Math.round((periods[0].temp_c ?? 0) + 100), 8);
      for (let p = 1; p < n; p++) {
        const q = clampInt(Math.round((periods[p].temp_c ?? 0) + 100), 8);
        const delta = Math.min(Math.max(q - recon, TEMP_DELTA_MIN), TEMP_DELTA_MAX);
        recon += delta;
        c.tempDB.push(tempDeltaBucket(delta));
      }
      chains.push(c);
    }
  });
  return chains;
}

// ── Held-out evaluation ──────────────────────────────────────────────────────────

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

// Evaluate one (target symbol, context) scheme over transitions (p ≥ 1). Returns overall
// b/period and per-context training occupancy stats.
function evalScheme(
  chains: Chain[], nsym: number, nctx: number,
  symOf: (c: Chain, p: number) => number, ctxOf: (c: Chain, p: number) => number,
): { bpp: number; occMin: number; occMed: number } {
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
  const perFold = occ.map((o) => Math.round(o / N_FOLDS)).sort((a, b) => a - b);
  return { bpp: bits / n, occMin: perFold[0], occMed: perFold[perFold.length >> 1] };
}

// ── Targets ──────────────────────────────────────────────────────────────────────

const chains = await collectChains();
console.log(`Columns (forecast × resolution): ${chains.length}`);

interface Scheme { label: string; nctx: number; ctx: (c: Chain, p: number) => number }
interface Target { name: string; nsym: number; sym: (c: Chain, p: number) => number; schemes: Scheme[] }

const R = (c: Chain) => resPos[c.res];

// Baseline context builders mirroring the shipped codecs (transitions only; the per-column
// bootstrap is out of scope for a Δ-vs-baseline scan).
const precipBase = (c: Chain, p: number) => R(c) * 8 + c.precip[p - 1];
const accumBase = (key: "snow" | "rain") => (c: Chain, p: number) => R(c) * N_ACCUM_B + accumBucket(c[key][p - 1]);
const cloudDelta = (key: "cch" | "ccm" | "ccl") => (c: Chain, p: number) => c[key][p] - c[key][p - 1] + 7;

const TARGETS: Target[] = [
  {
    name: "weathercode", nsym: 28, sym: (c, p) => c.wcSym[p],
    schemes: [
      { label: "baseline prev-code (28)", nctx: 28, ctx: (c, p) => c.wcSym[p - 1] },
      { label: "+ res (112)", nctx: 28 * NRES, ctx: (c, p) => c.wcSym[p - 1] * NRES + R(c) },
    ],
  },
  {
    name: "precip", nsym: 8, sym: (c, p) => c.precip[p],
    schemes: [
      { label: "baseline res×prev (32)", nctx: NRES * 8, ctx: precipBase },
      { label: "+ wcClass (128)", nctx: NRES * 8 * N_WC_CLASS, ctx: (c, p) => precipBase(c, p) * N_WC_CLASS + c.wcClass[p] },
    ],
  },
  {
    name: "snow", nsym: 64, sym: (c, p) => c.snow[p],
    schemes: [
      { label: "baseline res×prevB (20)", nctx: NRES * N_ACCUM_B, ctx: accumBase("snow") },
      { label: "+ wcClass (80)", nctx: NRES * N_ACCUM_B * N_WC_CLASS, ctx: (c, p) => accumBase("snow")(c, p) * N_WC_CLASS + c.wcClass[p] },
      { label: "+ precipB (60)", nctx: NRES * N_ACCUM_B * N_PRECIP_B, ctx: (c, p) => accumBase("snow")(c, p) * N_PRECIP_B + precipBucket(c.precip[p]) },
      { label: "+ wcClass × precipB (240)", nctx: NRES * N_ACCUM_B * N_WC_CLASS * N_PRECIP_B, ctx: (c, p) => (accumBase("snow")(c, p) * N_WC_CLASS + c.wcClass[p]) * N_PRECIP_B + precipBucket(c.precip[p]) },
    ],
  },
  {
    name: "rain", nsym: 64, sym: (c, p) => c.rain[p],
    schemes: [
      { label: "baseline res×prevB (20)", nctx: NRES * N_ACCUM_B, ctx: accumBase("rain") },
      { label: "+ wcClass (80)", nctx: NRES * N_ACCUM_B * N_WC_CLASS, ctx: (c, p) => accumBase("rain")(c, p) * N_WC_CLASS + c.wcClass[p] },
      { label: "+ snow≠0 (40)", nctx: NRES * N_ACCUM_B * 2, ctx: (c, p) => accumBase("rain")(c, p) * 2 + (c.snow[p] > 0 ? 1 : 0) },
      { label: "+ wcClass × snow≠0 (160)", nctx: NRES * N_ACCUM_B * N_WC_CLASS * 2, ctx: (c, p) => (accumBase("rain")(c, p) * N_WC_CLASS + c.wcClass[p]) * 2 + (c.snow[p] > 0 ? 1 : 0) },
    ],
  },
  ...(["cch", "ccm", "ccl"] as const).map((key): Target => ({
    name: key, nsym: 15, sym: cloudDelta(key),
    schemes: [
      { label: "baseline pooled (1)", nctx: 1, ctx: () => 0 },
      { label: "+ res (4)", nctx: NRES, ctx: (c) => R(c) },
      { label: "+ wcClass (4)", nctx: N_WC_CLASS, ctx: (c, p) => c.wcClass[p] },
      { label: "+ res × wcClass (16)", nctx: NRES * N_WC_CLASS, ctx: (c, p) => R(c) * N_WC_CLASS + c.wcClass[p] },
    ],
  })),
  {
    name: "freeze", nsym: 63, sym: (c, p) => c.freezeQ[p] - c.freezeQ[p - 1] + 31,
    schemes: [
      { label: "baseline pooled (1)", nctx: 1, ctx: () => 0 },
      { label: "+ res (4)", nctx: NRES, ctx: (c) => R(c) },
      { label: "+ tempΔB (5)", nctx: TEMP_DELTA_PREV_BUCKETS, ctx: (c, p) => c.tempDB[p] },
      { label: "+ res × tempΔB (20)", nctx: NRES * TEMP_DELTA_PREV_BUCKETS, ctx: (c, p) => R(c) * TEMP_DELTA_PREV_BUCKETS + c.tempDB[p] },
    ],
  },
];

console.log(`\nHeld-out bits/period (5-fold by location; transitions only, bootstraps excluded)`);
for (const t of TARGETS) {
  let baseline: number | null = null;
  for (const s of t.schemes) {
    const { bpp, occMin, occMed } = evalScheme(chains, t.nsym, s.nctx, t.sym, s.ctx);
    baseline ??= bpp;
    const delta = bpp - baseline;
    console.log(
      `${t.name.padEnd(12)} ${s.label.padEnd(28)} ${bpp.toFixed(3).padStart(7)}` +
      (delta !== 0 ? ` ${(delta > 0 ? "+" : "") + delta.toFixed(3)}` : "        ") +
      `   occ min=${occMin} med=${occMed}`);
  }
  console.log("");
}
