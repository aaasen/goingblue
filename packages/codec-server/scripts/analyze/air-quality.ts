/**
 * Air-quality conditioning scan, held-out (5-fold by location), answering the questions that
 * decided how the thirteen AQ columns go on the wire:
 *
 *  A. WHAT DOES EACH INDEX COST as its own anchor+delta column under the two contexts the
 *     shipped columns use: res × prevΔ, and res × tod8 × prevΔ (the temp column's ladder, for
 *     the photochemical constituents)?
 *  B. IS THE HEADLINE A RESIDUAL? Each index is defined as the max over its sub-indices, so with
 *     the constituents on the wire the headline codes as `headline − max(carried subset)`. Priced
 *     per presence mask over the three constituents that ever lead (PM2.5, ozone, PM10).
 *  C. WHICH CONSTITUENT DRIVES EACH HEADLINE, ranking the columns worth shipping: a sub-index
 *     that is never the max buys nothing for the residual.
 *  D. THE DOMINANT-POLLUTANT COLUMN, naming which constituent the headline reports: its cost
 *     under contexts of increasing richness, how often the carried subset determines it (the
 *     field is then free), and how often two sub-indices share a band.
 *
 * OUTCOME (2026-08-15): ozone and NO2 took the tod ladder, the rest res × prevΔ; both headlines
 * equal their max in 100.00% of periods, so they ship as residuals keyed by the presence mask;
 * only PM2.5/ozone/PM10 ever lead (US 56.9/40.3/2.8%, EU 23.1/68.6/8.3%); the dominant column
 * ships order-1 on the previous answer (AQ_DOMINANT_* in entropy.ts).
 *
 * Aggregation is maxOf over each period's hours (rowsFromWindows), clamped to the horizon the
 * wire encodes (AQ_HORIZON_HOURS), matching derive-air-quality-codebooks.ts. The `cams` corpus
 * source is joined onto the weather lattice by eachForecast (EXTRA_SOURCE_VARS).
 *
 *   pnpm exec tsx packages/codec-server/scripts/analyze/air-quality.ts [--stride N]
 */
import type { Row } from "../../src/forecast.ts";
import {
  AQI_US_LOWER, AQI_EU_LOWER, AQI_DELTA_NSYM, AQI_DELTA_ESCAPE_BITS, AQI_RESIDUAL_MAX, AQI_NO_DATA,
  AQ_HORIZON_HOURS, aqiDeltaSym, quantAqi, tempDeltaBucket, tempTodBucket,
  TEMP_DELTA_PREV_BUCKETS, TEMP_DELTA_TOD_BUCKETS,
} from "@weather/protocol";
import { EXTRA_SOURCE_VARS } from "../derive-lib.ts";
import {
  NRES, argStride, eachColumn, heldOut, localMidHalfHours, printLadder, runStandalone, type HeldOut, type Rung,
} from "./lib.ts";

const NDELTA = AQI_DELTA_NSYM;         // 16
const ESCAPE_SYM = NDELTA - 1;
const NPREV = TEMP_DELTA_PREV_BUCKETS; // 5
const NTOD = TEMP_DELTA_TOD_BUCKETS;   // 8
const NRESID = AQI_RESIDUAL_MAX + 1;   // 26
const escapeBits = (s: number) => (s === ESCAPE_SYM ? AQI_DELTA_ESCAPE_BITS : 0);

// Every index column, by corpus name. `sub` columns are listed in WIRE order: the dominant
// symbol is a position in that list and ties break toward the lowest, so both sides need the
// same order; PM2.5, ozone and PM10 lead because they are the only ones that ever do.
interface Col { key: keyof Row & string; name: string; lower: readonly number[] }
interface Scale { label: string; head: Col; subs: Col[] }
const us = (key: keyof Row & string, name: string): Col => ({ key, name, lower: AQI_US_LOWER });
const eu = (key: keyof Row & string, name: string): Col => ({ key, name, lower: AQI_EU_LOWER });
const SCALES: Scale[] = [
  { label: "US", head: us("us_aqi", "US headline"), subs: [
    us("us_aqi_pm2_5", "pm2.5"), us("us_aqi_ozone", "ozone"), us("us_aqi_pm10", "pm10"),
    us("us_aqi_nitrogen_dioxide", "no2"), us("us_aqi_sulphur_dioxide", "so2"), us("us_aqi_carbon_monoxide", "co"),
  ] },
  { label: "EU", head: eu("european_aqi", "EU headline"), subs: [
    eu("european_aqi_pm2_5", "pm2.5"), eu("european_aqi_ozone", "ozone"), eu("european_aqi_pm10", "pm10"),
    eu("european_aqi_nitrogen_dioxide", "no2"), eu("european_aqi_sulphur_dioxide", "so2"),
  ] },
];
const ALL_COLS = SCALES.flatMap((s) => [...s.subs, s.head]);

// One column: quantized symbols per index plus the axes the tables key on, and per scale the
// dominant constituent (argmax over RAW values, as the encoder picks; -1 with any missing).
interface Chain {
  fold: number; res: number; n: number;
  tod: Uint8Array;
  q: Record<string, Uint8Array>;
  dom: Int8Array[];      // [scale][period]
  bandTied: Uint8Array[]; // [scale][period]: two sub-indices share the top band
}

async function collectChains(stride: number): Promise<Chain[]> {
  const chains: Chain[] = [];
  await eachColumn({ vars: EXTRA_SOURCE_VARS.cams, stride }, (col) => {
    if (!col.ctx.hourly.us_aqi) return; // a cell the CAMS pull didn't cover
    const { rows, hpp } = col.slice;
    const n = Math.min(col.slice.n, Math.ceil(AQ_HORIZON_HOURS / hpp));
    if (n < 3) return;
    const q: Record<string, Uint8Array> = {};
    for (const c of ALL_COLS) q[c.key] = Uint8Array.from({ length: n }, (_, p) => quantAqi(rows[p][c.key] as number | null, c.lower));
    const chain: Chain = {
      fold: col.fold, res: col.res, n,
      tod: Uint8Array.from({ length: n }, (_, p) => tempTodBucket(localMidHalfHours(col, p))),
      q, dom: [], bandTied: [],
    };
    for (const sc of SCALES) {
      const dom = new Int8Array(n).fill(-1), tied = new Uint8Array(n);
      for (let p = 0; p < n; p++) {
        let best = -Infinity, bi = -1, bandBest = -1, bandTies = 0;
        for (let i = 0; i < sc.subs.length; i++) {
          const v = rows[p][sc.subs[i].key] as number | null;
          if (v == null || Number.isNaN(v)) { bi = -1; break; }
          if (v > best) { best = v; bi = i; }
          const band = q[sc.subs[i].key][p];
          if (band > bandBest) { bandBest = band; bandTies = 1; } else if (band === bandBest) bandTies++;
        }
        dom[p] = bi;
        tied[p] = bi >= 0 && bandTies > 1 ? 1 : 0;
      }
      chain.dom.push(dom);
      chain.bandTied.push(tied);
    }
    chains.push(chain);
  });
  return chains;
}

// ── A. per-column delta cost ─────────────────────────────────────────────────────

// prevΔ is the previous emitted delta (bucket 2 for a column's first delta), as the shipped
// tables key; the escape carries its raw payload.
function deltaCost(chains: Chain[], key: string, tod: boolean): HeldOut {
  const nctx = NRES * NPREV * (tod ? NTOD : 1);
  return heldOut({ nsym: NDELTA, nctx, extraBits: escapeBits }, (add) => {
    for (const c of chains) {
      const arr = c.q[key];
      let prevDelta: number | null = null;
      for (let p = 1; p < c.n; p++) {
        const delta = arr[p] - arr[p - 1];
        const prev = tempDeltaBucket(prevDelta ?? 0);
        add(c.fold, c.res, tod ? (c.res * NPREV + prev) * NTOD + c.tod[p] : c.res * NPREV + prev, aqiDeltaSym(delta));
        prevDelta = delta;
      }
    }
  });
}

// ── B. headline residual against max(subset) ────────────────────────────────────

// Keyed by resolution alone, as the shipped residual tables are. Periods where the headline or
// any subset member is missing encode through the no-data symbol, not this table.
function residualCost(chains: Chain[], head: Col, subset: Col[]): HeldOut & { zeroPct: number } {
  const baseline = (c: Chain, p: number): number => {
    if (c.q[head.key][p] === AQI_NO_DATA) return -1;
    let m = 0;
    for (const s of subset) {
      const v = c.q[s.key][p];
      if (v === AQI_NO_DATA) return -1;
      if (v > m) m = v;
    }
    return m;
  };
  let zero = 0, tot = 0;
  const r = heldOut({ nsym: NRESID, nctx: NRES }, (add) => {
    for (const c of chains) for (let p = 0; p < c.n; p++) {
      const b = baseline(c, p);
      if (b < 0) continue;
      const resid = c.q[head.key][p] - b;
      tot++;
      if (resid === 0) zero++;
      add(c.fold, c.res, c.res, Math.min(Math.max(resid, 0), AQI_RESIDUAL_MAX));
    }
  });
  return { ...r, zeroPct: (100 * zero) / Math.max(1, tot) };
}

export async function analyze(args: string[]): Promise<void> {
  const chains = await collectChains(argStride(args));
  console.log(`Columns (forecast × resolution): ${chains.length}`);

  console.log("\nA. per-column anchor+delta cost (held-out b/period, pooled over 12h/6h/3h/1h)");
  console.log("   column        res×prevΔ   res×tod×prevΔ          n");
  for (const c of ALL_COLS) {
    const plain = deltaCost(chains, c.key, false), withTod = deltaCost(chains, c.key, true);
    console.log(`   ${c.name.padEnd(12)} ${plain.bpp.toFixed(3).padStart(9)} ${withTod.bpp.toFixed(3).padStart(15)} ${String(plain.n).padStart(10)}`);
  }

  console.log("\nB. headline as a residual against max(subset)");
  console.log("   Every non-empty subset of the three constituents that ever lead (the presence mask the");
  console.log("   residual tables key on); `all` is the ceiling those seven chase.");
  console.log("   subset                    b/period    zero%          n");
  for (const sc of SCALES) {
    const top3 = sc.subs.slice(0, 3);
    for (let mask = 1; mask < 8; mask++) {
      const members = top3.filter((_, i) => mask & (1 << i));
      const r = residualCost(chains, sc.head, members);
      console.log(`   ${`${sc.label} vs ${members.map((m) => m.name).join("+")}`.padEnd(25)} ${r.bpp.toFixed(3).padStart(8)} ${r.zeroPct.toFixed(2).padStart(8)} ${String(r.n).padStart(10)}`);
    }
    const r = residualCost(chains, sc.head, sc.subs);
    console.log(`   ${`${sc.label} vs all (ceiling)`.padEnd(25)} ${r.bpp.toFixed(3).padStart(8)} ${r.zeroPct.toFixed(2).padStart(8)} ${String(r.n).padStart(10)}`);
  }

  console.log("\nC. which constituent is the headline's max");
  SCALES.forEach((sc, si) => {
    const wins = new Array<number>(sc.subs.length).fill(0);
    let tot = 0, exceeds = 0, ties = 0;
    for (const c of chains) for (let p = 0; p < c.n; p++) {
      const bi = c.dom[si][p];
      if (bi < 0 || c.q[sc.head.key][p] === AQI_NO_DATA) continue;
      tot++; wins[bi]++; ties += c.bandTied[si][p];
      let best = 0;
      for (const s of sc.subs) best = Math.max(best, c.q[s.key][p]);
      if (c.q[sc.head.key][p] > best) exceeds++;
    }
    console.log(`   ${sc.head.name}: ${sc.subs.map((s, i) => `${s.name}=${((100 * wins[i]) / Math.max(1, tot)).toFixed(1)}%`).join("  ")}`);
    console.log(`     headline > max(all subs) in ${((100 * exceeds) / Math.max(1, tot)).toFixed(2)}% of periods (n=${tot});` +
      ` the top band is shared by 2+ sub-indices in ${((100 * ties) / Math.max(1, tot)).toFixed(2)}%`);
  });

  console.log("\nD. dominant-pollutant column");
  SCALES.forEach((sc, si) => {
    const NS = sc.subs.length;
    // A period with a missing constituent carries no symbol and breaks the chain (the next one
    // starts from the bootstrap row), as the codec does.
    const rungs: [string, number, (c: Chain, p: number) => number, number][] = [
      ["marginal", 1, () => 0, 0],
      ["res", NRES, (c) => c.res, 0],
      ["tod", NTOD, (c, p) => c.tod[p], 0],
      ["res × tod", NRES * NTOD, (c, p) => c.res * NTOD + c.tod[p], 0],
      ["prev ← shipped", NS, (c, p) => c.dom[si][p - 1], 1],
      ["res × prev", NRES * NS, (c, p) => c.res * NS + c.dom[si][p - 1], 1],
      ["res × prev × tod", NRES * NS * NTOD, (c, p) => (c.res * NS + c.dom[si][p - 1]) * NTOD + c.tod[p], 1],
    ];
    const ladder: Rung[] = rungs.map(([label, nctx, ctxOf, from]) => ({
      label: `${label} (${nctx})`,
      result: heldOut({ nsym: NS, nctx }, (add) => {
        for (const c of chains) {
          const dom = c.dom[si];
          for (let p = from; p < c.n; p++) {
            if (dom[p] < 0 || (from > 0 && dom[p - 1] < 0)) continue;
            add(c.fold, c.res, ctxOf(c, p), dom[p]);
          }
        }
      }),
    }));
    printLadder(`${sc.label} dominant pollutant: held-out bits/period (5-fold by location)`, ladder);

    // When is the field free? (argmax over the carried subset == the true argmax)
    const MASK_LABEL = ["-", "pm2.5", "ozone", "pm2.5+ozone", "pm10", "pm2.5+pm10", "ozone+pm10", "all3"];
    console.log(`   derivable from the carried columns (no field needed):`);
    for (let mask = 1; mask < 8; mask++) {
      let ok = 0, m = 0;
      for (const c of chains) {
        const dom = c.dom[si];
        for (let p = 0; p < c.n; p++) {
          if (dom[p] < 0) continue;
          m++;
          let bandBest = -1, bi = -1;
          for (let i = 0; i < 3; i++) {
            if (!(mask & (1 << i))) continue;
            const band = c.q[sc.subs[i].key][p];
            if (band > bandBest) { bandBest = band; bi = i; }
          }
          if (bi === dom[p]) ok++;
        }
      }
      console.log(`     ${MASK_LABEL[mask].padEnd(12)} ${((100 * ok) / Math.max(1, m)).toFixed(2)}%`);
    }
  });
}

runStandalone(import.meta.url, analyze);
