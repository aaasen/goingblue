/**
 * Surface-wind + gust coding scan: held-out (5-fold by location) bits/period for each
 * (speed scale × conditioning direction) candidate, over the same wire-shaped chains the
 * derive scripts train on. Motivated by the 2026-07-31 re-baseline: the 5 kph linear refinement
 * plus real gust data cost ~5.7 seq on denali, and wind+gust are 34% of the base body.
 *
 * Axes:
 *   scale     — how sfc/gust kph quantize: linear 5 mph, linear 5 kph (shipped), sqrt-companded
 *               (Beaufort-shaped: fine at low speeds, bands widen with speed; reuses the
 *               compandSqrt idea from snow/rain). Sqrt caps cover the full corpus range
 *               (sfc 155, gust 315 kph) in 5 or 6 bits with no storm clipping.
 *   direction — which column decodes first and lends its same-period delta as free context:
 *               fwd = sfc first, gust | B(sfcΔ)  (shipped)
 *               rev = gust first, sfc | B(gustΔ) (gust has the wider range — more signal?)
 *   context   — B = upperDeltaBucket on the conditioning column's quantized delta; Bw halves
 *               the delta first (wider bands, for scales whose deltas spread further).
 *
 * The reported TOTAL (sfc + gust b/period) is the decision metric; per-scale band widths at
 * reference speeds are printed so the precision trade is visible next to the bit cost.
 *
 * OUTCOME (2026-07-31): extended Beaufort (forces 0..17) on BOTH columns won — 2.638 total vs
 * 3.595 shipped-linear-5kph and 2.687 old-linear-5mph; every mixed/sqrt/lin-log variant landed
 * between. Direction was a wash on every scale (±0.02), and the user chose REV (gust decodes
 * first, sfc | gustΔB) anyway for the option to make surface wind non-always-on later. The
 * user then extended Beaufort to the jet columns too (unmeasured here — optional-mask, not
 * base-body). Shipped in v1: quantWind/beaufortMidKph in entropy.ts.
 *
 *   node --max-old-space-size=12288 packages/codec-server/scripts/analyze-wind-scale-heldout.ts
 */
import { rowsFromWindows, toFullPeriod, HOURS_PER_PERIOD } from "../src/forecast.ts";
import { VARS_BIT, upperDeltaBucket } from "@weather/protocol";
import { eachForecast, foldOf, N_FOLDS, scaledWeights } from "./derive-lib.ts";

const RES_IDXS = [1, 2, 3, 4]; // 12h/6h/3h/1h — layouts never emit 24h
const NRES = RES_IDXS.length;
const resPos: Record<number, number> = Object.fromEntries(RES_IDXS.map((r, i) => [r, i]));
const MASK = (1 << VARS_BIT.wind) | (1 << VARS_BIT.gust);

// One (forecast × resolution) column of raw aggregated speeds; quantization happens per scheme.
interface Chain { fold: number; res: number; n: number; sfc: Float32Array; gust: Float32Array }

const chains: Chain[] = [];
await eachForecast((h, _startHour, loc, pos) => {
  if (!pos || !h.time?.length) return;
  if (!h.wind_gusts_10m?.some((v: number | null) => v != null)) return; // pre-add-pass cell
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
    const periods = rowsFromWindows(h, h.time, windows, off).map((r) => toFullPeriod(r, MASK, "US"));
    chains.push({
      fold, res, n,
      sfc: Float32Array.from(periods, (p) => p.wind_sfc_kph ?? 0),
      gust: Float32Array.from(periods, (p) => p.wind_gust_kph ?? 0),
    });
  }
});
console.log(`Columns (forecast × resolution): ${chains.length}`);

// ── Scales ──────────────────────────────────────────────────────────────────────
interface Scale {
  name: string;
  qSfc(kph: number): number; sfcMax: number;
  qGust(kph: number): number; gustMax: number;
  band(kph: number, col: "sfc" | "gust"): number; // decoded band width (kph) around a speed
}
const linQ = (step: number, max: number) => (kph: number) =>
  Math.min(Math.floor(kph / step + 1e-9), max);
const sqrtQ = (k: number, max: number) => (kph: number) =>
  Math.min(Math.round(k * Math.sqrt(Math.max(kph, 0))), max);
// A sqrt level q spans kph ((q-0.5)/k)^2 .. ((q+0.5)/k)^2 — width 2q/k².
const sqrtBand = (k: number) => (kph: number) => (2 * Math.max(1, Math.round(k * Math.sqrt(kph)))) / (k * k);
const MPH = 1.609344;
const kS5 = 31 / Math.sqrt(155), kG5 = 31 / Math.sqrt(315), kG6 = 63 / Math.sqrt(315);

// Lin-log compander: exact 5 kph bands up to `knee` kph (matching the shipped linear low end,
// where the probability mass is), then bands grow ∝ v/alpha — Beaufort-shaped where it saves
// bits, never finer than shipped anywhere. q(v) is continuous at the knee.
const linlogQ = (knee: number, alpha: number, cap: number) => {
  const kneeQ = knee / 5;
  const maxQ = Math.round(kneeQ + alpha * Math.log(cap / knee));
  const q = (kph: number) => {
    const v = Math.min(Math.max(kph, 0), cap);
    return Math.min(Math.round(v <= knee ? v / 5 : kneeQ + alpha * Math.log(v / knee)), maxQ);
  };
  const band = (kph: number) => Math.max(5, Math.min(kph, cap) / alpha);
  return { q, max: maxQ, band };
};

// Extended Beaufort (forces 0..17): the standard 13 forces top out at 118+ kph, which would
// re-introduce storm clipping (corpus gust max 225) — the extension keeps hurricane-force bands.
// Lower bounds in km/h; force = index of the band containing v.
const BFT = [0, 1, 6, 12, 20, 29, 39, 50, 62, 75, 89, 103, 118, 134, 150, 167, 184, 202];
const BFT_MAX = BFT.length - 1; // 17
const bftQ = (kph: number) => {
  let f = 0;
  while (f < BFT_MAX && kph >= BFT[f + 1]) f++;
  return f;
};
const bftBand = (kph: number) => {
  const f = bftQ(kph);
  return f >= BFT_MAX ? 19 : BFT[f + 1] - BFT[f];
};

const SCALES: Scale[] = [
  { name: "lin 5mph (old wire)      ", qSfc: linQ(5 * MPH, 31), sfcMax: 31, qGust: linQ(5 * MPH, 31), gustMax: 31,
    band: () => 5 * MPH },
  { name: "lin 5kph (shipped)       ", qSfc: linQ(5, 31), sfcMax: 31, qGust: linQ(5, 63), gustMax: 63,
    band: () => 5 },
  ...((): Scale[] => {
    const g8 = linlogQ(40, 8, 315);
    return [
      { name: "sfc lin5 + gust linlog8  ", qSfc: linQ(5, 31), sfcMax: 31, qGust: g8.q, gustMax: g8.max,
        band: (kph, col) => (col === "sfc" ? 5 : g8.band(kph)) },
      { name: "beaufort-ext both        ", qSfc: bftQ, sfcMax: BFT_MAX, qGust: bftQ, gustMax: BFT_MAX,
        band: (kph) => bftBand(kph) },
      { name: "sfc beaufort + gust llog8", qSfc: bftQ, sfcMax: BFT_MAX, qGust: g8.q, gustMax: g8.max,
        band: (kph, col) => (col === "sfc" ? bftBand(kph) : g8.band(kph)) },
      { name: "sfc lin5 + gust beaufort ", qSfc: linQ(5, 31), sfcMax: 31, qGust: bftQ, gustMax: BFT_MAX,
        band: (kph, col) => (col === "sfc" ? 5 : bftBand(kph)) },
    ];
  })(),
];

// ── Held-out machinery (as in analyze-cross-var-heldout.ts) ─────────────────────
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

// Evaluate one column: symbol = target delta, context = res × bucket(conditioning delta) (or
// res-only when bucketOf is null). Quantized per chain on the fly — no per-scheme corpus scan.
function evalCol(
  scale: Scale, target: "sfc" | "gust", cond: "sfc" | "gust" | null,
  bucketOf: ((d: number) => number) | null, nBuckets: number,
): number {
  const qT = target === "sfc" ? scale.qSfc : scale.qGust;
  const maxT = target === "sfc" ? scale.sfcMax : scale.gustMax;
  const nsym = 2 * maxT + 1;
  const nctx = NRES * (bucketOf ? nBuckets : 1);
  const counts = Array.from({ length: N_FOLDS }, () => Array.from({ length: nctx }, () => zeros(nsym)));
  for (const c of chains) {
    const R = resPos[c.res];
    const qC = cond === null ? null : cond === "sfc" ? scale.qSfc : scale.qGust;
    const condArr = cond === null ? null : cond === "sfc" ? c.sfc : c.gust;
    const tgtArr = target === "sfc" ? c.sfc : c.gust;
    let prevT = qT(tgtArr[0]);
    let prevC = qC ? qC(condArr![0]) : 0;
    for (let p = 1; p < c.n; p++) {
      const t = qT(tgtArr[p]);
      const ctx = bucketOf && qC
        ? R * nBuckets + bucketOf(qC(condArr![p]) - prevC)
        : R;
      counts[c.fold][ctx][t - prevT + maxT]++;
      prevT = t;
      if (qC) prevC = qC(condArr![p]);
    }
  }
  let bits = 0, n = 0;
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
      bits += heldOutBits(train[ctx], counts[fold][ctx], fallback);
      n += sum(counts[fold][ctx]);
    }
  }
  return bits / n;
}

const B5 = upperDeltaBucket;
const B5w = (d: number) => upperDeltaBucket(Math.round(d / 2)); // wider bands for spread deltas

console.log(`\nHeld-out b/period, sfc + gust (5-fold by location; transitions only).`);
console.log(`fwd = sfc first, gust | B(sfcΔ) (shipped direction); rev = gust first, sfc | B(gustΔ).\n`);
for (const scale of SCALES) {
  const sfcAlone = evalCol(scale, "sfc", null, null, 1);
  const gustAlone = evalCol(scale, "gust", null, null, 1);
  const rows: [string, number, number][] = [
    ["fwd B ", sfcAlone, evalCol(scale, "gust", "sfc", B5, 5)],
    ["fwd Bw", sfcAlone, evalCol(scale, "gust", "sfc", B5w, 5)],
    ["rev B ", evalCol(scale, "sfc", "gust", B5, 5), gustAlone],
    ["rev Bw", evalCol(scale, "sfc", "gust", B5w, 5), gustAlone],
  ];
  console.log(scale.name);
  for (const [dir, s, g] of rows) {
    console.log(`  ${dir}  sfc ${s.toFixed(3)}  gust ${g.toFixed(3)}  TOTAL ${(s + g).toFixed(3)}`);
  }
  const at = (mph: number, col: "sfc" | "gust") => scale.band(mph * MPH, col) / MPH;
  console.log(`  band width (mph) @ 10/30/60/100 mph — sfc: ${[10, 30, 60].map((m) => at(m, "sfc").toFixed(1)).join("/")}` +
    `  gust: ${[10, 30, 60, 100].map((m) => at(m, "gust").toFixed(1)).join("/")}\n`);
}
