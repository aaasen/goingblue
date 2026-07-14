/**
 * Derive order-1 codebooks for precip chance and the rain/snow accumulations — the columns that
 * used the adaptive best-of (raw / FOR / sparse / empty + 2-bit selector) scheme. Dry runs are
 * highly persistent, so a value conditioned on the *previous decoded value* — context both sides
 * already have, costing no wire bits — beats every adaptive mode: sparse charges a full bit per
 * zero period where P(0|prev=0) makes it cost a small fraction of one. On top of that, the SAME
 * period's weathercode class (dry / rain-ish / freezing / snow-ish — see WEATHERCODE_CLASS in
 * entropy.ts) is free context too: the weathercode column decodes first and is always present.
 *
 * Contexts (previous value, not previous delta — zero is an absorbing regime, and delta=0
 * conflates "still dry" with "steady heavy snow"):
 *   - precip chance (3-bit, symbols 0..7): full order-1, keyed by (resolution, prev symbol,
 *     same-period weathercode class).
 *   - rain/snow (6-bit sqrt-companded, symbols 0..63): keyed by (resolution, BUCKET(prev),
 *     same-period weathercode class) — the full 64×64 transition matrix has far too little corpus
 *     signal per cell (~5k forecasts), so the previous value is bucketed; see ACCUM_BUCKET_EDGES.
 *   - one bootstrap table per variable for a column's first symbol (no predecessor; fires once
 *     per message, so it is pooled across resolutions and classes).
 *
 * Resolution keying matters here for two reasons: dry persistence falls with the aggregation
 * step (like wind direction), and rain/snow are per-period *sums*, so their whole scale grows
 * with the step. Held-out (5-fold by location, all resolutions pooled), bits/period:
 *
 *   precip: adaptive 2.121 | order-0 1.960 | order-1 1.078 | ×res 1.002 | ×res×wc 0.894  ← shipped
 *   snow:   adaptive 1.302 | order-0 1.084 | bucket5 0.766 | ×res 0.741 | ×res×wc 0.470  ← shipped
 *   rain:   adaptive 1.983 | order-0 1.632 | bucket5 1.192 | ×res 1.153 | ×res×wc 0.814  ← shipped
 *
 * analyze-cross-var-heldout.ts, which ranked wcClass against the other cross-variable candidates,
 * reports the same win a shade larger (0.876 / 0.445 / 0.770) because it scans transitions only,
 * over the four resolutions layouts actually emit. Stacking a second cross-variable signal on top
 * — rain on snow≠0, snow on the precip-chance bucket — measured redundant with the class.
 *
 * Full 64-context order-1 × res edges bucket5 × res by only ~0.02 b/period held-out (0.719 snow,
 * 1.129 rain) — not worth 40k more table entries. Run standalone to re-print the comparison
 * (build the protocol first — WEATHERCODE_CLASS is imported from it, so derivation and wire can't
 * drift):
 *
 *   node packages/server/scripts/derive-precip-accum-codebooks.ts
 */
import { aggregateHourly, toFullPeriod, HOURS_PER_PERIOD } from "../src/forecast.ts";
import {
  VARS_BIT, VAR_BITS_V1, compandSqrt, SNOW_K, RAIN_K, ACCUM_BITS,
  WMO2IDX, WEATHERCODE_CLASS, WC_CLASSES, type Period,
} from "@weather/protocol";
import { eachForecast, foldOf, N_FOLDS, scaledWeights, runStandalone, type DerivedTables } from "./derive-lib.ts";

const NRES = 5;
const PRECIP_NSYM = 8;
const ACCUM_NSYM = 1 << ACCUM_BITS; // 64

// Previous-value buckets for the accumulation columns (companded domain 0..63). Must match
// accumBucket in entropy.ts. Bucket 0 is exactly "dry" — the absorbing state the whole scheme
// leans on; the rest split light/moderate/heavy/extreme.
export const ACCUM_BUCKET_EDGES = [1, 4, 10, 21]; // buckets: 0 | 1-3 | 4-9 | 10-20 | 21+
const NBUCKET = ACCUM_BUCKET_EDGES.length + 1;
const bucketOf = (v: number, edges: number[]): number => {
  let b = 0;
  for (const e of edges) if (v >= e) b++; else break;
  return b;
};

const clampInt = (v: number, width: number) => Math.min(Math.max(v, 0), (1 << width) - 1);

interface Var {
  name: string;
  bit: number;
  nsym: number;
  quant(p: Period): number;
}
const VARS: Var[] = [
  { name: "precip", bit: VARS_BIT.precip, nsym: PRECIP_NSYM,
    quant: (p) => clampInt(Math.round((p.precip ?? 0) * 7 / 100), 3) },
  { name: "snow", bit: VARS_BIT.snow, nsym: ACCUM_NSYM,
    quant: (p) => compandSqrt(p.snow_cm ?? 0, SNOW_K, ACCUM_BITS) },
  { name: "rain", bit: VARS_BIT.rain, nsym: ACCUM_NSYM,
    quant: (p) => compandSqrt(p.rain_mm ?? 0, RAIN_K, ACCUM_BITS) },
];
const VARS_MASK = VARS.reduce((m, v) => m | (1 << v.bit), 0);

// The adaptive scheme this replaces, re-costed on the same columns for the comparison print:
// 2-bit selector + cheapest of raw / FOR / sparse / empty (the scheme v1.ts used before this).
function adaptiveCost(vals: number[], width: number): number {
  let maxV = 0, min = vals[0], nonzero = 0;
  for (const v of vals) { if (v > 0) { nonzero++; if (v > maxV) maxV = v; } if (v < min) min = v; }
  if (maxV === 0) return 2;
  const bw = (n: number) => (n <= 0 ? 0 : 32 - Math.clz32(n));
  const raw = vals.length * width;
  const forC = width + 3 + vals.length * bw(maxV - min);
  const sparse = 3 + vals.length + nonzero * bw(maxV);
  return 2 + Math.min(raw, forC, sparse);
}

// -log2 model cost of `testCounts` under scaledWeights(trainCounts), the same weight flooring
// the shipped tables get (empty train rows fall back to `fallback`, mirroring emission).
function heldOutBits(trainCounts: number[], testCounts: number[], fallback: number[]): number {
  const train = trainCounts.reduce((a, b) => a + b, 0) > 0 ? trainCounts : fallback;
  const w = scaledWeights(train);
  const total = w.reduce((a, b) => a + b, 0);
  let bits = 0;
  for (let s = 0; s < testCounts.length; s++) {
    if (testCounts[s] > 0) bits += testCounts[s] * -Math.log2(w[s] / total);
  }
  return bits;
}

const zeros = (n: number) => new Array<number>(n).fill(0);
const grid = (...dims: number[]): any =>
  dims.length === 1 ? zeros(dims[0]) : Array.from({ length: dims[0] }, () => grid(...dims.slice(1)));
const addInto = (a: number[], b: number[]) => { for (let i = 0; i < b.length; i++) a[i] += b[i]; };

export async function derive(): Promise<DerivedTables> {
  // Full transition counts per variable: [fold][res][prevSym][wcClass][sym], where wcClass is the
  // ARRIVING period's class — schemes below collapse the prev axis (buckets, pooled) and/or the
  // res and class axes without another corpus pass.
  const trans = VARS.map((v) => grid(N_FOLDS, NRES, v.nsym, WC_CLASSES, v.nsym) as number[][][][][]);
  const boot = VARS.map((v) => grid(N_FOLDS, v.nsym) as number[][]);
  const oldBits = VARS.map(() => zeros(NRES));  // adaptive-scheme cost per res
  const nPeriods = VARS.map(() => zeros(NRES)); // total periods per res (both schemes' denominator)
  let forecasts = 0;

  await eachForecast((h, startHour, loc) => {
    const fold = foldOf(loc);
    forecasts++;
    for (let resIdx = 0; resIdx < NRES; resIdx++) {
      const hpp = HOURS_PER_PERIOD[resIdx];
      const start = Math.floor(startHour / hpp) * hpp;
      const n = Math.floor(h.time.length / hpp);
      if (n < 2) continue;
      const rows = aggregateHourly(h, h.time, n, resIdx, start);
      const periods: Period[] = rows.map((r) => toFullPeriod(r, VARS_MASK, "GFS"));
      // Class of the symbol the encoder would emit, not of the raw code — WMO2IDX maps an
      // unknown code to index 0, exactly as v1.ts's weathercode column does.
      const wc = periods.map((p) => WEATHERCODE_CLASS[WMO2IDX[p.weathercode] ?? 0]);
      for (let v = 0; v < VARS.length; v++) {
        const syms = periods.map((p) => VARS[v].quant(p));
        boot[v][fold][syms[0]]++;
        for (let p = 1; p < n; p++) trans[v][fold][resIdx][syms[p - 1]][wc[p]][syms[p]]++;
        oldBits[v][resIdx] += adaptiveCost(syms, VAR_BITS_V1[VARS[v].bit]);
        nPeriods[v][resIdx] += n;
      }
    }
  });
  console.log(`Forecasts: ${forecasts}`);

  // ── Held-out scheme comparison (5-fold by location) ──────────────────────────
  // ctx collapses a prev symbol to a context id; res=false pools resolutions, wc=false pools the
  // same-period weathercode classes.
  interface Scheme { label: string; nctx: number; ctx: (prev: number) => number; res: boolean; wc: boolean }
  const schemesFor = (v: Var): Scheme[] => {
    const common: Scheme[] = [
      { label: "order-0 pooled", nctx: 1, ctx: () => 0, res: false, wc: false },
      { label: "order-0 × res", nctx: 1, ctx: () => 0, res: true, wc: false },
    ];
    if (v.nsym === PRECIP_NSYM) {
      return [...common,
        { label: "order-1", nctx: v.nsym, ctx: (p) => p, res: false, wc: false },
        { label: "order-1 × res", nctx: v.nsym, ctx: (p) => p, res: true, wc: false },
        { label: "order-1 × res × wc", nctx: v.nsym, ctx: (p) => p, res: true, wc: true },
      ];
    }
    const b3 = [1, 8];
    const bucket = (p: number) => bucketOf(p, ACCUM_BUCKET_EDGES);
    return [...common,
      { label: "bucket3", nctx: b3.length + 1, ctx: (p) => bucketOf(p, b3), res: false, wc: false },
      { label: `bucket${NBUCKET}`, nctx: NBUCKET, ctx: bucket, res: false, wc: false },
      { label: `bucket${NBUCKET} × res`, nctx: NBUCKET, ctx: bucket, res: true, wc: false },
      { label: `bucket${NBUCKET} × res × wc`, nctx: NBUCKET, ctx: bucket, res: true, wc: true },
      { label: "full order-1 × res", nctx: v.nsym, ctx: (p) => p, res: true, wc: false },
    ];
  };

  for (let v = 0; v < VARS.length; v++) {
    const { name, nsym } = VARS[v];
    const totalPeriods = nPeriods[v].reduce((a, b) => a + b, 0);
    console.log(`\n${name}: held-out bits/period (adaptive best-of today: ${
      (oldBits[v].reduce((a, b) => a + b, 0) / totalPeriods).toFixed(3)})`);
    for (const scheme of schemesFor(VARS[v])) {
      let bits = 0, transitions = 0;
      const nres = scheme.res ? NRES : 1;
      const nwc = scheme.wc ? WC_CLASSES : 1;
      for (let fold = 0; fold < N_FOLDS; fold++) {
        // train[res][ctx][sym] summed over the other folds; test likewise for this fold. `ctx`
        // is prev-major over the class axis, as the emitted tables are.
        const train = grid(nres, scheme.nctx * nwc, nsym) as number[][][];
        const test = grid(nres, scheme.nctx * nwc, nsym) as number[][][];
        const fallback = grid(nres, nsym) as number[][];
        for (let f = 0; f < N_FOLDS; f++) {
          for (let r = 0; r < NRES; r++) {
            const rr = scheme.res ? r : 0;
            for (let prev = 0; prev < nsym; prev++) {
              for (let c = 0; c < WC_CLASSES; c++) {
                const row = trans[v][f][r][prev][c];
                const ctx = scheme.ctx(prev) * nwc + (scheme.wc ? c : 0);
                addInto((f === fold ? test : train)[rr][ctx], row);
                if (f !== fold) addInto(fallback[rr], row);
              }
            }
          }
        }
        for (let r = 0; r < nres; r++) {
          for (let c = 0; c < scheme.nctx * nwc; c++) {
            bits += heldOutBits(train[r][c], test[r][c], fallback[r]);
            transitions += test[r][c].reduce((a, b) => a + b, 0);
          }
        }
      }
      console.log(`  ${scheme.label.padEnd(24)} ${(bits / transitions).toFixed(3)} b/transition`);
    }
  }

  // ── Emission: bootstrap per var (pooled), plus (res × context × class)-keyed tables ──
  // Context rows are prev-major: ctxOf(prev) × WC_CLASSES + wcClass, matching makeValueCodec.
  const sum2 = (rows: number[][]) => rows.reduce((acc, r) => (addInto(acc, r), acc), zeros(rows[0].length));
  const out: DerivedTables = {};
  for (let v = 0; v < VARS.length; v++) {
    const { name, nsym } = VARS[v];
    const isAccum = nsym === ACCUM_NSYM;
    const nctx = (isAccum ? NBUCKET : nsym) * WC_CLASSES;
    const ctxOf = (prev: number, wc: number) =>
      (isAccum ? bucketOf(prev, ACCUM_BUCKET_EDGES) : prev) * WC_CLASSES + wc;
    const tables: number[][][] = grid(NRES, nctx, nsym);
    const marginal: number[][] = grid(NRES, nsym);
    for (let f = 0; f < N_FOLDS; f++) {
      for (let r = 0; r < NRES; r++) {
        for (let prev = 0; prev < nsym; prev++) {
          for (let c = 0; c < WC_CLASSES; c++) {
            addInto(tables[r][ctxOf(prev, c)], trans[v][f][r][prev][c]);
            addInto(marginal[r], trans[v][f][r][prev][c]);
          }
        }
      }
    }
    const NAME = name.toUpperCase();
    out[`${NAME}_BOOTSTRAP_WEIGHTS`] = scaledWeights(sum2(boot[v]));
    // A context the corpus never filled (snow-class × heavy-prev at 12h and the like are
    // structurally rare) falls back to that resolution's marginal — never an empty table.
    out[`${NAME}_WEIGHTS_BY_RES`] = tables.map((ctxRows, r) =>
      ctxRows.map((row) => scaledWeights(row.reduce((a, b) => a + b, 0) > 0 ? row : marginal[r])));
  }
  return out;
}

runStandalone(import.meta.url, derive);
