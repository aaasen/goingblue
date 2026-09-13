/**
 * Wind conditioning scans, held-out (5-fold by location), over the same wire-shaped chains
 * derive-wind-codebooks.ts trains on: local-midnight windows per resolution, extended-Beaufort
 * quantization (quantWind), calm-gated direction symbols.
 *
 * A. SPEED SCALE (surface + gust). How sfc/gust kph quantize: linear 5 mph (the first wire),
 *    linear 5 kph, sqrt- and lin-log-companded, extended Beaufort (forces 0..17) ← shipped; and
 *    which column decodes first and lends its same-period delta bucket as free context
 *    (fwd = sfc first, gust | B(sfcΔ); rev = gust first, sfc | B(gustΔ) ← shipped). The TOTAL
 *    (sfc + gust b/period) is the decision metric; band widths at reference speeds are printed
 *    so the precision trade sits next to the bit cost.
 *
 *    OUTCOME (2026-07-31): extended Beaufort on both columns won, 2.638 total vs 3.595 linear
 *    5 kph and 2.687 linear 5 mph; every mixed variant landed between. Direction was a wash on
 *    every scale (±0.02) and REV was chosen for the option to make surface wind optional later.
 *
 * B. DIRECTION CONTEXTS. Order-1 on the previous encoded direction: pooled over resolution,
 *    per resolution ← shipped (surface and the topmost served level), and for the pressure
 *    levels below the topmost, plus the level above's same-period displayed direction ← shipped
 *    (windDirUpper, keyed by the ladder gap; the adjacent gap is what corpus conditions serve)
 *    or its circular distance to prev (a compact variant).
 *
 * C. SPEED CONTEXTS. Delta tables pooled over levels, per (res, level) ← shipped for the
 *    topmost level, and for the levels below, keyed by the level above's same-period delta
 *    bucket ← shipped (windSpeedUpperDelta, adjacent gap).
 *
 *    OUTCOME (2026-07, re-measured on Beaufort): resolution keying pays for direction because
 *    persistence falls sharply with the aggregation step; the full prev × upper table beat the
 *    circular-distance variant at every resolution; level keying pays for speed because the
 *    pooled table taxed the peaked surface column hardest, and the level above's delta beats
 *    even that for the lower levels (adjacent pressure levels move together).
 *
 * Cells whose windows rolled off the lattice before the 2026-07-31 gust add-pass have no
 * wind_gusts_10m series and are skipped in section A.
 *
 *   pnpm exec tsx packages/codec-server/scripts/analyze/wind.ts [--stride N] [--only scale|direction|speed]
 */
import { toFullPeriod } from "../../src/forecast.ts";
import {
  VAR, type Variable, WIND_LEVELS_HPA, WIND_LEVEL_VARS, BEAUFORT_KPH_LOWER, BEAUFORT_MAX, CALM_MAX_FORCE,
  quantWind, upperDeltaBucket, type Period,
} from "@weather/protocol";
import {
  NRES, argStride, argValue, eachColumn, heldOut, printLadder, runStandalone, type HeldOut, type Rung,
} from "./lib.ts";

const NLEVEL = 1 + WIND_LEVELS_HPA.length; // sfc, then the ladder (300 hPa … 1000 hPa)
const NDIR = 8;
const NBUCKET = 5; // upperDeltaBucket domain
const GUST_VARS: ReadonlySet<Variable> = new Set([VAR.wind, VAR.gust]);
const LEVEL_VARS: ReadonlySet<Variable> = new Set([VAR.wind, ...WIND_LEVEL_VARS]);
const LEVEL_HOURLY = [
  "wind_speed_10m", "wind_direction_10m",
  ...WIND_LEVELS_HPA.flatMap((l) => [`wind_speed_${l}hPa`, `wind_direction_${l}hPa`]),
];
const speedOf = (p: Period, L: number) => (L === 0 ? p.wind_sfc_kph : p.wind_aloft?.[L - 1]?.kph);
const dirOf = (p: Period, L: number) => (L === 0 ? p.wind_sfc_dir : p.wind_aloft?.[L - 1]?.dir);

// ── A. Speed scale ───────────────────────────────────────────────────────────────

interface GustChain { fold: number; res: number; n: number; sfc: Float32Array; gust: Float32Array }

interface Scale {
  name: string;
  qSfc(kph: number): number; sfcMax: number;
  qGust(kph: number): number; gustMax: number;
  band(kph: number, col: "sfc" | "gust"): number; // decoded band width (kph) around a speed
}
const MPH = 1.609344;
const linQ = (step: number, max: number) => (kph: number) => Math.min(Math.floor(kph / step + 1e-9), max);
const sqrtQ = (k: number, max: number) => (kph: number) => Math.min(Math.round(k * Math.sqrt(Math.max(kph, 0))), max);
// A sqrt level q spans kph ((q-0.5)/k)^2 .. ((q+0.5)/k)^2, width 2q/k².
const sqrtBand = (k: number) => (kph: number) => (2 * Math.max(1, Math.round(k * Math.sqrt(kph)))) / (k * k);
const kS5 = 31 / Math.sqrt(155), kG6 = 63 / Math.sqrt(315);
// Lin-log compander: exact 5 kph bands up to `knee`, then bands grow ∝ v/alpha.
const linlogQ = (knee: number, alpha: number, cap: number) => {
  const kneeQ = knee / 5;
  const maxQ = Math.round(kneeQ + alpha * Math.log(cap / knee));
  return {
    q: (kph: number) => {
      const v = Math.min(Math.max(kph, 0), cap);
      return Math.min(Math.round(v <= knee ? v / 5 : kneeQ + alpha * Math.log(v / knee)), maxQ);
    },
    max: maxQ,
    band: (kph: number) => Math.max(5, Math.min(kph, cap) / alpha),
  };
};
const bftBand = (kph: number) => {
  const f = quantWind(kph);
  return f >= BEAUFORT_MAX ? 19 : BEAUFORT_KPH_LOWER[f + 1] - BEAUFORT_KPH_LOWER[f];
};
const g8 = linlogQ(40, 8, 315);
const SCALES: Scale[] = [
  { name: "lin 5mph (first wire)", qSfc: linQ(5 * MPH, 31), sfcMax: 31, qGust: linQ(5 * MPH, 31), gustMax: 31, band: () => 5 * MPH },
  { name: "lin 5kph", qSfc: linQ(5, 31), sfcMax: 31, qGust: linQ(5, 63), gustMax: 63, band: () => 5 },
  { name: "sqrt both", qSfc: sqrtQ(kS5, 31), sfcMax: 31, qGust: sqrtQ(kG6, 63), gustMax: 63,
    band: (kph, col) => (col === "sfc" ? sqrtBand(kS5)(kph) : sqrtBand(kG6)(kph)) },
  { name: "sfc lin5 + gust linlog8", qSfc: linQ(5, 31), sfcMax: 31, qGust: g8.q, gustMax: g8.max,
    band: (kph, col) => (col === "sfc" ? 5 : g8.band(kph)) },
  { name: "beaufort-ext both ← shipped", qSfc: quantWind, sfcMax: BEAUFORT_MAX, qGust: quantWind, gustMax: BEAUFORT_MAX, band: bftBand },
  { name: "sfc beaufort + gust linlog8", qSfc: quantWind, sfcMax: BEAUFORT_MAX, qGust: g8.q, gustMax: g8.max,
    band: (kph, col) => (col === "sfc" ? bftBand(kph) : g8.band(kph)) },
  { name: "sfc lin5 + gust beaufort", qSfc: linQ(5, 31), sfcMax: 31, qGust: quantWind, gustMax: BEAUFORT_MAX,
    band: (kph, col) => (col === "sfc" ? 5 : bftBand(kph)) },
];

// One column's cost: symbol = target delta, context = res × bucket(conditioning column's
// same-period delta), or res alone. Quantized per chain on the fly.
function scaleCost(
  chains: GustChain[], scale: Scale, target: "sfc" | "gust", cond: "sfc" | "gust" | null,
  bucketOf: (d: number) => number = upperDeltaBucket,
): HeldOut {
  const qT = target === "sfc" ? scale.qSfc : scale.qGust;
  const maxT = target === "sfc" ? scale.sfcMax : scale.gustMax;
  const qC = cond === null ? null : cond === "sfc" ? scale.qSfc : scale.qGust;
  return heldOut({ nsym: 2 * maxT + 1, nctx: NRES * (cond ? NBUCKET : 1) }, (add) => {
    for (const c of chains) {
      const tgt = target === "sfc" ? c.sfc : c.gust;
      const cnd = cond === "sfc" ? c.sfc : c.gust;
      let prevT = qT(tgt[0]), prevC = qC ? qC(cnd[0]) : 0;
      for (let p = 1; p < c.n; p++) {
        const t = qT(tgt[p]);
        const ctx = qC ? c.res * NBUCKET + bucketOf(qC(cnd[p]) - prevC) : c.res;
        add(c.fold, c.res, ctx, t - prevT + maxT);
        prevT = t;
        if (qC) prevC = qC(cnd[p]);
      }
    }
  });
}

async function scanScale(stride: number): Promise<void> {
  const chains: GustChain[] = [];
  await eachColumn({ vars: ["wind_speed_10m", "wind_gusts_10m"], stride }, (col) => {
    if (!col.ctx.hourly.wind_gusts_10m?.some((v: number | null) => v != null)) return;
    const periods = col.slice.rows.map((r) => toFullPeriod(r, GUST_VARS, "US"));
    chains.push({
      fold: col.fold, res: col.res, n: col.slice.n,
      sfc: Float32Array.from(periods, (p) => p.wind_sfc_kph ?? 0),
      gust: Float32Array.from(periods, (p) => p.wind_gust_kph ?? 0),
    });
  });
  console.log(`\nA. speed scale: sfc + gust held-out b/period (${chains.length} columns; transitions only)`);
  console.log(`   fwd = sfc first, gust | B(sfcΔ); rev = gust first, sfc | B(gustΔ) (shipped); Bw halves the delta first.\n`);
  const B5w = (d: number) => upperDeltaBucket(Math.round(d / 2));
  for (const scale of SCALES) {
    const sfcAlone = scaleCost(chains, scale, "sfc", null).bpp;
    const gustAlone = scaleCost(chains, scale, "gust", null).bpp;
    const rows: [string, number, number][] = [
      ["fwd B ", sfcAlone, scaleCost(chains, scale, "gust", "sfc").bpp],
      ["fwd Bw", sfcAlone, scaleCost(chains, scale, "gust", "sfc", B5w).bpp],
      ["rev B ", scaleCost(chains, scale, "sfc", "gust").bpp, gustAlone],
      ["rev Bw", scaleCost(chains, scale, "sfc", "gust", B5w).bpp, gustAlone],
    ];
    console.log(`   ${scale.name}`);
    for (const [dir, s, g] of rows)
      console.log(`     ${dir}  sfc ${s.toFixed(3)}  gust ${g.toFixed(3)}  TOTAL ${(s + g).toFixed(3)}`);
    const at = (mph: number, col: "sfc" | "gust") => scale.band(mph * MPH, col) / MPH;
    console.log(`     band width (mph) @ 10/30/60/100 mph, sfc: ${[10, 30, 60].map((m) => at(m, "sfc").toFixed(1)).join("/")}` +
      `  gust: ${[10, 30, 60, 100].map((m) => at(m, "gust").toFixed(1)).join("/")}`);
  }
}

// ── B/C. Level contexts ──────────────────────────────────────────────────────────

// One column at every level: quantized speed and 8-point direction per period, and the
// direction the decoder displays under calm gating (the last encoded one, 0 before any).
interface LevelChain { fold: number; res: number; n: number; sp: Uint8Array[]; dr: Uint8Array[]; disp: Uint8Array[] }

async function collectLevels(stride: number): Promise<LevelChain[]> {
  const chains: LevelChain[] = [];
  await eachColumn({ vars: LEVEL_HOURLY, stride }, (col) => {
    const periods = col.slice.rows.map((r) => toFullPeriod(r, LEVEL_VARS, "US"));
    const sp = Array.from({ length: NLEVEL }, (_, L) => Uint8Array.from(periods, (p) => quantWind(speedOf(p, L) ?? 0)));
    const dr = Array.from({ length: NLEVEL }, (_, L) => Uint8Array.from(periods, (p) => (dirOf(p, L) ?? 0) % NDIR));
    const disp = sp.map((s, L) => {
      let eff = 0;
      return Uint8Array.from(periods, (_, p) => (s[p] > CALM_MAX_FORCE ? (eff = dr[L][p]) : eff));
    });
    chains.push({ fold: col.fold, res: col.res, n: col.slice.n, sp, dr, disp });
  });
  return chains;
}

const circDist = (a: number, b: number) => Math.min((a - b + NDIR) % NDIR, (b - a + NDIR) % NDIR);

// Direction symbols under calm gating over the levels `levels` admits; `ctxOf` sees the level,
// the previous encoded direction, and the level above's displayed direction (-1 at sfc/top).
function directionRung(
  chains: LevelChain[], label: string, nctx: number, levels: (L: number) => boolean,
  ctxOf: (c: LevelChain, L: number, prev: number, upper: number) => number,
): Rung {
  const result = heldOut({ nsym: NDIR, nctx }, (add) => {
    for (const c of chains) for (let L = 0; L < NLEVEL; L++) {
      if (!levels(L)) continue;
      let prev: number | null = null;
      for (let p = 0; p < c.n; p++) {
        if (c.sp[L][p] <= CALM_MAX_FORCE) continue;
        const d = c.dr[L][p];
        if (prev !== null) add(c.fold, c.res, ctxOf(c, L, prev, L >= 2 ? c.disp[L - 1][p] : -1), d);
        prev = d;
      }
    }
  });
  return { label: `${label} (${nctx})`, result };
}

// Speed deltas (-17..17) over the levels `levels` admits; `ctxOf` sees the level and the level
// above's same-period delta (0 at sfc/top).
function speedRung(
  chains: LevelChain[], label: string, nctx: number, levels: (L: number) => boolean,
  ctxOf: (c: LevelChain, L: number, upperDelta: number) => number,
): Rung {
  const result = heldOut({ nsym: 2 * BEAUFORT_MAX + 1, nctx }, (add) => {
    for (const c of chains) for (let L = 0; L < NLEVEL; L++) {
      if (!levels(L)) continue;
      const s = c.sp[L], u = L >= 2 ? c.sp[L - 1] : null;
      for (let p = 1; p < c.n; p++)
        add(c.fold, c.res, ctxOf(c, L, u ? u[p] - u[p - 1] : 0), s[p] - s[p - 1] + BEAUFORT_MAX);
    }
  });
  return { label: `${label} (${nctx})`, result };
}

const ALL = () => true;
const LOWER = (L: number) => L >= 2; // pressure levels with a served level above them

export async function analyze(args: string[]): Promise<void> {
  const stride = argStride(args);
  const only = argValue(args, "--only", "");
  if (!only || only === "scale") await scanScale(stride);
  if (only && only !== "direction" && only !== "speed") return;

  const chains = await collectLevels(stride);
  console.log(`\nColumns (forecast × resolution): ${chains.length}`);
  if (!only || only === "direction") {
    printLadder("B. direction, all levels: held-out bits/symbol (5-fold by location; calm-gated)", [
      directionRung(chains, "prev, pooled over res", NDIR, ALL, (_c, _L, prev) => prev),
      directionRung(chains, "res × prev ← shipped (sfc, top level)", NRES * NDIR, ALL, (c, _L, prev) => c.res * NDIR + prev),
    ]);
    printLadder("   direction, levels below the topmost (the level above's same-period direction is free)", [
      directionRung(chains, "res × prev", NRES * NDIR, LOWER, (c, _L, prev) => c.res * NDIR + prev),
      directionRung(chains, "res × prev × upper dir ← shipped", NRES * NDIR * NDIR, LOWER,
        (c, _L, prev, upper) => (c.res * NDIR + prev) * NDIR + upper),
      directionRung(chains, "res × prev × circ dist 0/1/2+", NRES * NDIR * 3, LOWER,
        (c, _L, prev, upper) => (c.res * NDIR + prev) * 3 + Math.min(circDist(upper, prev), 2)),
    ]);
  }
  if (!only || only === "speed") {
    printLadder("C. speed deltas, all levels: held-out bits/symbol (5-fold by location)", [
      speedRung(chains, "pooled over levels, per res", NRES, ALL, (c) => c.res),
      speedRung(chains, "res × level ← shipped (top level)", NRES * NLEVEL, ALL, (c, L) => c.res * NLEVEL + L),
    ]);
    printLadder("   speed deltas, levels below the topmost (the level above's same-period delta is free)", [
      speedRung(chains, "res × level", NRES * NLEVEL, LOWER, (c, L) => c.res * NLEVEL + L),
      speedRung(chains, "res × upperΔB ← shipped", NRES * NBUCKET, LOWER, (c, _L, d) => c.res * NBUCKET + upperDeltaBucket(d)),
      speedRung(chains, "res × level × upperΔB", NRES * NLEVEL * NBUCKET, LOWER,
        (c, L, d) => (c.res * NLEVEL + L) * NBUCKET + upperDeltaBucket(d)),
    ]);
  }
}

runStandalone(import.meta.url, analyze);
