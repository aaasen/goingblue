/**
 * Held-out (5-fold by location) scan of the DOMINANT POLLUTANT column: naming which constituent
 * the headline index is currently reporting, so a reader who asks for AQI alone gets "150, PM2.5"
 * rather than a bare number.
 *
 * The identity is the argmax over the scale's sub-indices — the same argmax the headline residual
 * already relies on (each headline equals that max in 100.00% of corpus periods). So the questions
 * this answers are:
 *
 *  1. WHAT DOES IT COST as its own symbol, under contexts of increasing richness? It should be
 *     cheap: the distribution is skewed (US PM2.5 56.9% / ozone 40.3%) and strongly persistent
 *     period-to-period, so an order-1 table keyed on the previous dominant should beat its ~1.15
 *     bit marginal entropy substantially.
 *  2. HOW OFTEN IS IT FREE? When PM2.5, ozone and PM10 are all on the wire the decoder can take
 *     the argmax itself and the field need not be sent at all. This reports the share of periods
 *     where the carried set determines the answer, per presence mask.
 *  3. TIES. Two sub-indices landing in the same band is a real event at ladder resolution, and
 *     both sides must break it identically. Reported here so the wire rule is chosen from data.
 *
 * Aggregation is maxOf over each period's hours, matching production and the AQ derive.
 *
 *   pnpm exec tsx packages/codec-server/scripts/analyze-aq-dominant-heldout.ts
 */
import { HOURS_PER_PERIOD } from "../src/forecast.ts";
import {
  AQI_US_LOWER, AQI_EU_LOWER, AQI_NO_DATA, quantAqi, tempTodBucket, TEMP_DELTA_TOD_BUCKETS,
} from "@weather/protocol";
import { eachForecast, foldOf, N_FOLDS, scaledWeights } from "./derive-lib.ts";

const RES_IDXS = [1, 2, 3, 4]; // 12h/6h/3h/1h — layouts never emit 24h
const NRES = RES_IDXS.length;
const resPos: Record<number, number> = Object.fromEntries(RES_IDXS.map((r, i) => [r, i]));
const NTOD = TEMP_DELTA_TOD_BUCKETS;

// Each scale's constituents IN WIRE ORDER — the index emitted is a position in this list, and
// ties break toward the LOWEST index, so both sides need the same order. PM2.5, ozone and PM10
// lead first because they are the only ones that ever do (and the three the residual keys on).
const US_SUBS = [
  { key: "us_aqi_pm2_5", name: "pm2.5" },
  { key: "us_aqi_ozone", name: "ozone" },
  { key: "us_aqi_pm10", name: "pm10" },
  { key: "us_aqi_nitrogen_dioxide", name: "no2" },
  { key: "us_aqi_sulphur_dioxide", name: "so2" },
  { key: "us_aqi_carbon_monoxide", name: "co" },
];
const EU_SUBS = [
  { key: "european_aqi_pm2_5", name: "pm2.5" },
  { key: "european_aqi_ozone", name: "ozone" },
  { key: "european_aqi_pm10", name: "pm10" },
  { key: "european_aqi_nitrogen_dioxide", name: "no2" },
  { key: "european_aqi_sulphur_dioxide", name: "so2" },
];
const SCALES = [
  { label: "US", head: "us_aqi", subs: US_SUBS, ladder: AQI_US_LOWER },
  { label: "EU", head: "european_aqi", subs: EU_SUBS, ladder: AQI_EU_LOWER },
];
const VARS = [...new Set(SCALES.flatMap((s) => [s.head, ...s.subs.map((x) => x.key)]))];

// One (cell, resolution) chain per scale: the dominant index per period, plus the axes a table
// could key on. -1 marks a period with no usable data.
interface Chain {
  fold: number;
  res: number;
  n: number;
  tod: Uint8Array;
  dom: Record<string, Int8Array>;   // scale label -> dominant sub-index position
  tied: Record<string, Uint8Array>; // scale label -> 1 if the max was shared
  // Whether the argmax is determined by a given presence mask over {pm2.5, ozone, pm10}.
  derivable: Record<string, Uint8Array[]>; // scale label -> [mask][period]
}

const maxOf = (vals: (number | null)[] | undefined, from: number, to: number): number | null => {
  if (!vals) return null;
  let m: number | null = null;
  for (let i = from; i < to; i++) {
    const v = vals[i];
    if (v == null || Number.isNaN(v)) continue;
    if (m == null || v > m) m = v;
  }
  return m;
};

async function collectChains(): Promise<Chain[]> {
  const chains: Chain[] = [];
  await eachForecast((h, _startHour, loc, pos) => {
    const hh = h as never as Record<string, (number | null)[] | undefined>;
    if (!pos || !h.time?.length || !hh["us_aqi"]) return;
    const off = Math.round(pos.lon / 15);
    const dataStart = Math.floor(Date.parse(`${h.time[0]}:00Z`) / 3600000);
    const dataEnd = dataStart + h.time.length;
    const fold = foldOf(loc);
    for (const res of RES_IDXS) {
      const hpp = HOURS_PER_PERIOD[res];
      const firstUtc = Math.ceil((dataStart + off) / 24) * 24 - off;
      const n = Math.floor((dataEnd - firstUtc) / hpp);
      if (n < 3) continue;
      const c: Chain = {
        fold, res: resPos[res], n,
        tod: new Uint8Array(n), dom: {}, tied: {}, derivable: {},
      };
      for (let p = 0; p < n; p++) c.tod[p] = tempTodBucket((firstUtc + p * hpp) * 2 + hpp + off * 2);

      for (const sc of SCALES) {
        const dom = new Int8Array(n).fill(-1);
        const tied = new Uint8Array(n);
        const derivable = Array.from({ length: 8 }, () => new Uint8Array(n));
        for (let p = 0; p < n; p++) {
          const a = firstUtc + p * hpp - dataStart;
          const q = sc.subs.map((s) => quantAqi(maxOf(hh[s.key], a, a + hpp), sc.ladder));
          if (q.some((v) => v === AQI_NO_DATA)) continue;
          let best = -1, bi = -1, ties = 0;
          for (let i = 0; i < q.length; i++) {
            if (q[i] > best) { best = q[i]; bi = i; ties = 1; }
            else if (q[i] === best) ties++;
          }
          dom[p] = bi;
          tied[p] = ties > 1 ? 1 : 0;
          // For each presence mask over {pm2.5, ozone, pm10}: does the argmax over the carried
          // subset equal the true argmax? If so the decoder can name it without being told.
          for (let mask = 1; mask < 8; mask++) {
            let mBest = -1, mIdx = -1;
            for (let i = 0; i < 3; i++) {
              if (!(mask & (1 << i))) continue;
              if (q[i] > mBest) { mBest = q[i]; mIdx = i; }
            }
            derivable[mask][p] = mIdx === bi ? 1 : 0;
          }
        }
        c.dom[sc.label] = dom;
        c.tied[sc.label] = tied;
        c.derivable[sc.label] = derivable;
      }
      chains.push(c);
    }
  }, "train", VARS);
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

function evalScheme(
  chains: Chain[], scale: string, nsym: number, nctx: number,
  ctxOf: (c: Chain, p: number) => number, from: number,
): { bpp: number; n: number } {
  const counts = Array.from({ length: N_FOLDS }, () => Array.from({ length: nctx }, () => zeros(nsym)));
  for (const c of chains) {
    const dom = c.dom[scale];
    for (let p = from; p < c.n; p++) {
      if (dom[p] < 0) continue;
      if (from > 0 && dom[p - 1] < 0) continue; // order-1 needs a predecessor
      counts[c.fold][ctxOf(c, p)][dom[p]]++;
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
  return { bpp: bits / Math.max(1, n), n };
}

async function main() {
  console.log("collecting chains…");
  const chains = await collectChains();
  console.log(`  ${chains.length} chains\n`);

  for (const sc of SCALES) {
    const NS = sc.subs.length;
    console.log(`── ${sc.label}: dominant-pollutant column (held-out b/period) ──`);
    const schemes: [string, number, (c: Chain, p: number) => number, number][] = [
      ["marginal", 1, () => 0, 0],
      ["res", NRES, (c) => c.res, 0],
      ["tod", NTOD, (c, p) => c.tod[p], 0],
      ["res × tod", NRES * NTOD, (c, p) => c.res * NTOD + c.tod[p], 0],
      ["prev", NS, (c, p) => c.dom[sc.label][p - 1], 1],
      ["res × prev", NRES * NS, (c, p) => c.res * NS + c.dom[sc.label][p - 1], 1],
      ["res × prev × tod", NRES * NS * NTOD,
        (c, p) => (c.res * NS + c.dom[sc.label][p - 1]) * NTOD + c.tod[p], 1],
    ];
    for (const [name, nctx, ctxOf, from] of schemes) {
      const r = evalScheme(chains, sc.label, NS, nctx, ctxOf, from);
      console.log(`  ${name.padEnd(18)} ${r.bpp.toFixed(3).padStart(7)} b/period   n=${r.n}`);
    }

    // Share of each pollutant, and how often the max is shared.
    const share = zeros(NS);
    let tot = 0, ties = 0;
    for (const c of chains) {
      const dom = c.dom[sc.label], tied = c.tied[sc.label];
      for (let p = 0; p < c.n; p++) {
        if (dom[p] < 0) continue;
        share[dom[p]]++; tot++; ties += tied[p];
      }
    }
    console.log(`  share: ${sc.subs.map((s, i) => `${s.name}=${(100 * share[i] / tot).toFixed(2)}%`).join("  ")}`);
    console.log(`  the max is SHARED by 2+ sub-indices in ${(100 * ties / tot).toFixed(2)}% of periods`);

    // When is the field free? (argmax over the carried subset == the true argmax)
    const MASK_LABEL = ["-", "pm2.5", "ozone", "pm2.5+ozone", "pm10", "pm2.5+pm10", "ozone+pm10", "all3"];
    console.log(`  derivable from the carried columns (no field needed):`);
    for (let mask = 1; mask < 8; mask++) {
      let ok = 0, m = 0;
      for (const c of chains) {
        const dom = c.dom[sc.label], d = c.derivable[sc.label][mask];
        for (let p = 0; p < c.n; p++) {
          if (dom[p] < 0) continue;
          m++; ok += d[p];
        }
      }
      console.log(`    ${MASK_LABEL[mask].padEnd(12)} ${(100 * ok / m).toFixed(2)}%`);
    }
    console.log();
  }
}

main();
