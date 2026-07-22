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
 * — rain on snow≠0, snow on the precip-chance bucket — measured redundant with the class. Full
 * 64-context order-1 × res edged bucket5 × res by only ~0.02 b/period held-out (0.719 snow,
 * 1.129 rain) — not worth 40k more table entries. (The full scheme ladder used to be re-costed
 * here on every generate; it lives in analyze-cross-var-heldout.ts now that this script counts at
 * emission granularity.) Run standalone to derive and print without writing (build the protocol
 * first — WEATHERCODE_CLASS is imported from it, so derivation and wire can't drift):
 *
 *   node packages/codec-server/scripts/derive-precip-accum-codebooks.ts
 */
import { aggregateHourly, toFullPeriod, HOURS_PER_PERIOD } from "../src/forecast.ts";
import {
  VARS_BIT, compandSqrt, SNOW_K, RAIN_K, ACCUM_BITS,
  WMO2IDX, WEATHERCODE_CLASS, WC_CLASSES, type Period,
} from "@weather/protocol";
import {
  deriveCounts, tableOffsets, rowAt, rowCostBits, scaledWeights, runStandalone,
  type CellCounter, type DerivedTables,
} from "./derive-lib.ts";

const NRES = 5;
const PRECIP_NSYM = 8;
const ACCUM_NSYM = 1 << ACCUM_BITS; // 64

// Previous-value buckets for the accumulation columns (companded domain 0..63). Must match
// accumBucket in entropy.ts. Bucket 0 is exactly "dry" — the absorbing state the whole scheme
// leans on; the rest split light/moderate/heavy/extreme.
export const ACCUM_BUCKET_EDGES = [1, 4, 10, 21]; // buckets: 0 | 1-3 | 4-9 | 10-20 | 21+
const NBUCKET = ACCUM_BUCKET_EDGES.length + 1;
const bucketOf = (v: number): number => {
  let b = 0;
  for (const e of ACCUM_BUCKET_EDGES) if (v >= e) b++; else break;
  return b;
};

const clampInt = (v: number, width: number) => Math.min(Math.max(v, 0), (1 << width) - 1);

interface Var {
  name: string;
  bit: number;
  nsym: number;
  nctx: number;                 // context rows per res: ctxOf(prev) × WC_CLASSES
  ctxOf(prev: number): number;  // prev symbol -> context id (identity or bucket)
  quant(p: Period): number;
}
const VARS: Var[] = [
  { name: "precip", bit: VARS_BIT.precip, nsym: PRECIP_NSYM, nctx: PRECIP_NSYM * WC_CLASSES,
    ctxOf: (p) => p, quant: (p) => clampInt(Math.round((p.precip ?? 0) * 7 / 100), 3) },
  { name: "snow", bit: VARS_BIT.snow, nsym: ACCUM_NSYM, nctx: NBUCKET * WC_CLASSES,
    ctxOf: bucketOf, quant: (p) => compandSqrt(p.snow_cm ?? 0, SNOW_K, ACCUM_BITS) },
  { name: "rain", bit: VARS_BIT.rain, nsym: ACCUM_NSYM, nctx: NBUCKET * WC_CLASSES,
    ctxOf: bucketOf, quant: (p) => compandSqrt(p.rain_mm ?? 0, RAIN_K, ACCUM_BITS) },
];
const VARS_MASK = VARS.reduce((m, v) => m | (1 << v.bit), 0);

export function counter(): CellCounter {
  const tables = VARS.flatMap((v) => [
    { name: `${v.name}Bootstrap`, dims: [v.nsym] },
    { name: v.name, dims: [NRES, v.nctx, v.nsym] },
  ]);
  const { offsets, nSlots } = tableOffsets(tables);
  const sum = (r: number[]) => r.reduce((a, b) => a + b, 0);

  // Context rows are prev-major (ctxOf(prev) × WC_CLASSES + wcClass), matching makeValueCodec.
  const resRows = (counts: ArrayLike<number>, v: Var): { rows: number[][]; marginal: number[] }[] =>
    Array.from({ length: NRES }, (_, res) => {
      const rows = Array.from({ length: v.nctx }, (_, ctx) =>
        rowAt(counts, offsets[v.name] + (res * v.nctx + ctx) * v.nsym, v.nsym));
      const marginal = new Array<number>(v.nsym).fill(0);
      for (const row of rows) for (let s = 0; s < v.nsym; s++) marginal[s] += row[s];
      return { rows, marginal };
    });

  return {
    tables, nSlots,
    countCell(h, startHour, _pos, add) {
      for (let resIdx = 0; resIdx < NRES; resIdx++) {
        const hpp = HOURS_PER_PERIOD[resIdx];
        const start = Math.floor(startHour / hpp) * hpp;
        const n = Math.floor(h.time.length / hpp);
        if (n < 2) continue;
        const rows = aggregateHourly(h, h.time, n, resIdx, start);
        const periods: Period[] = rows.map((r) => toFullPeriod(r, VARS_MASK, "US"));
        // Class of the symbol the encoder would emit, not of the raw code — WMO2IDX maps an
        // unknown code to index 0, exactly as v1.ts's weathercode column does.
        const wc = periods.map((p) => WEATHERCODE_CLASS[WMO2IDX[p.weathercode] ?? 0]);
        for (const v of VARS) {
          const syms = periods.map((p) => v.quant(p));
          add(offsets[`${v.name}Bootstrap`] + syms[0]);
          for (let p = 1; p < n; p++)
            add(offsets[v.name] + (resIdx * v.nctx + v.ctxOf(syms[p - 1]) * WC_CLASSES + wc[p]) * v.nsym + syms[p]);
        }
      }
    },
    tablesFrom(counts): DerivedTables {
      const out: DerivedTables = {};
      for (const v of VARS) {
        const NAME = v.name.toUpperCase();
        out[`${NAME}_BOOTSTRAP_WEIGHTS`] = scaledWeights(rowAt(counts, offsets[`${v.name}Bootstrap`], v.nsym));
        // A context the corpus never filled (snow-class × heavy-prev at 12h and the like are
        // structurally rare) falls back to that resolution's marginal — never an empty table.
        out[`${NAME}_WEIGHTS_BY_RES`] = resRows(counts, v).map(({ rows, marginal }) =>
          rows.map((row) => scaledWeights(sum(row) > 0 ? row : marginal)));
      }
      return out;
    },
    costBits(counts) {
      const L = new Float64Array(nSlots);
      const put = (start: number, row: number[]) => {
        const c = rowCostBits(scaledWeights(row));
        for (let s = 0; s < row.length; s++) L[start + s] = c[s];
      };
      for (const v of VARS) {
        put(offsets[`${v.name}Bootstrap`], rowAt(counts, offsets[`${v.name}Bootstrap`], v.nsym));
        resRows(counts, v).forEach(({ rows, marginal }, res) =>
          rows.forEach((row, ctx) =>
            put(offsets[v.name] + (res * v.nctx + ctx) * v.nsym, sum(row) > 0 ? row : marginal)));
      }
      return L;
    },
  };
}

export async function derive(): Promise<DerivedTables> {
  const c = counter();
  const counts = await deriveCounts(c);
  const { offsets } = tableOffsets(c.tables);
  // Training-set mean bits/transition per variable, for the generation log (the held-out scheme
  // ladder lives in analyze-cross-var-heldout.ts).
  const L = c.costBits(counts);
  for (const v of VARS) {
    let bits = 0, n = 0;
    const base = offsets[v.name], end = base + NRES * v.nctx * v.nsym;
    for (let slot = base; slot < end; slot++) { bits += counts[slot] * L[slot]; n += counts[slot]; }
    console.log(`  ${v.name}: n=${n} mean=${(bits / Math.max(1, n)).toFixed(3)} b/transition (training-set)`);
  }
  return c.tablesFrom(counts);
}

runStandalone(import.meta.url, derive);
