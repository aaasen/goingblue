/**
 * Held-out (5-fold by location) scan of the air-quality constituents the 2026-08-15 CAMS pull
 * added, answering the two questions that decide how they should go on the wire:
 *
 *  1. WHAT DOES EACH NEW SUB-INDEX COST as its own anchor+delta column, under the two contexts the
 *     shipped AQ columns use — res × prevΔ (the PM2.5 shape) and res × tod8 × prevΔ (the ozone
 *     shape, for the photochemical ones)?
 *  2. DOES THE HEADLINE BECOME A RESIDUAL? The US headline already codes as `us_aqi −
 *     max(pm25, o3)` when both sub-indices are on the wire (0.15 b/period, 98.5% exactly zero).
 *     Both indices are defined as the max over their sub-indices, so with the full constituent set
 *     collected the residual should collapse to ~0 — and the EU headline, which has no residual
 *     mode at all today because only its PM2.5 sub-index existed, should gain one. The EU headline
 *     is NO2/O3/SO2-driven ~77% of the time, so this is where its 1.64 b/period could go.
 *
 * Also reports which constituent actually drives each headline, since that ranks the columns worth
 * shipping: a sub-index that is never the max buys nothing for the headline residual.
 *
 * Aggregation is maxOf over each period's hours, matching production (rowsFromWindows) and
 * derive-air-quality-codebooks.ts, so the deltas scored here are the deltas an encoder would emit.
 * Reads the `cams` corpus source directly by name rather than through Row, so it needs no
 * production plumbing — see EXTRA_SOURCE_VARS in derive-lib.ts for the routing.
 *
 *   pnpm exec tsx packages/codec-server/scripts/analyze-aq-constituents-heldout.ts
 */
import { HOURS_PER_PERIOD } from "../src/forecast.ts";
import {
  AQI_US_LOWER, AQI_EU_LOWER, AQI_DELTA_NSYM, AQI_DELTA_ESCAPE_BITS, AQI_RESIDUAL_MAX,
  AQI_NO_DATA, aqiDeltaSym, quantAqi, tempDeltaBucket, tempTodBucket,
  TEMP_DELTA_PREV_BUCKETS, TEMP_DELTA_TOD_BUCKETS,
} from "@weather/protocol";
import { eachForecast, foldOf, N_FOLDS, scaledWeights } from "./derive-lib.ts";

const RES_IDXS = [1, 2, 3, 4]; // 12h/6h/3h/1h — layouts never emit 24h
const NRES = RES_IDXS.length;
const resPos: Record<number, number> = Object.fromEntries(RES_IDXS.map((r, i) => [r, i]));

const NDELTA = AQI_DELTA_NSYM;         // 16
const ESCAPE_SYM = NDELTA - 1;
const NPREV = TEMP_DELTA_PREV_BUCKETS; // 5
const NTOD = TEMP_DELTA_TOD_BUCKETS;   // 8
const NRESID = AQI_RESIDUAL_MAX + 1;   // 26

// Every index column in the corpus, by CAMS variable name. `shipped` marks the five already on
// the wire; the rest are what this scan is pricing. `sub` lists each headline's constituents in
// the order the reports print them.
interface Col { key: string; name: string; scale: readonly number[]; shipped: boolean }
const US_SUBS: Col[] = [
  { key: "us_aqi_pm2_5", name: "us pm2.5", scale: AQI_US_LOWER, shipped: true },
  { key: "us_aqi_ozone", name: "us ozone", scale: AQI_US_LOWER, shipped: true },
  { key: "us_aqi_pm10", name: "us pm10", scale: AQI_US_LOWER, shipped: false },
  { key: "us_aqi_nitrogen_dioxide", name: "us no2", scale: AQI_US_LOWER, shipped: false },
  { key: "us_aqi_sulphur_dioxide", name: "us so2", scale: AQI_US_LOWER, shipped: false },
  { key: "us_aqi_carbon_monoxide", name: "us co", scale: AQI_US_LOWER, shipped: false },
];
const EU_SUBS: Col[] = [
  { key: "european_aqi_pm2_5", name: "eu pm2.5", scale: AQI_EU_LOWER, shipped: true },
  { key: "european_aqi_pm10", name: "eu pm10", scale: AQI_EU_LOWER, shipped: false },
  { key: "european_aqi_nitrogen_dioxide", name: "eu no2", scale: AQI_EU_LOWER, shipped: false },
  { key: "european_aqi_ozone", name: "eu ozone", scale: AQI_EU_LOWER, shipped: false },
  { key: "european_aqi_sulphur_dioxide", name: "eu so2", scale: AQI_EU_LOWER, shipped: false },
];
const US_HEAD: Col = { key: "us_aqi", name: "US headline", scale: AQI_US_LOWER, shipped: true };
const EU_HEAD: Col = { key: "european_aqi", name: "EU headline", scale: AQI_EU_LOWER, shipped: true };
const ALL_COLS = [...US_SUBS, ...EU_SUBS, US_HEAD, EU_HEAD];

const VARS = ALL_COLS.map((c) => c.key);

// One (cell, resolution) chain: quantized symbols per column plus the axes the tables key on.
interface Chain {
  fold: number;
  res: number;
  n: number;
  tod: Uint8Array;
  q: Record<string, Uint8Array>;
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
    // A cell the CAMS pull didn't cover has no AQ columns at all.
    if (!pos || !h.time?.length || !(h as never as Record<string, unknown>)["us_aqi"]) return;
    const hh = h as never as Record<string, (number | null)[] | undefined>;
    const off = Math.round(pos.lon / 15);
    const dataStart = Math.floor(Date.parse(`${h.time[0]}:00Z`) / 3600000);
    const dataEnd = dataStart + h.time.length;
    const fold = foldOf(loc);
    for (const res of RES_IDXS) {
      const hpp = HOURS_PER_PERIOD[res];
      const firstUtc = Math.ceil((dataStart + off) / 24) * 24 - off; // first local midnight
      const n = Math.floor((dataEnd - firstUtc) / hpp);
      if (n < 3) continue;
      const q: Record<string, Uint8Array> = {};
      for (const c of ALL_COLS) {
        const arr = new Uint8Array(n);
        const src = hh[c.key];
        for (let p = 0; p < n; p++) {
          const a = firstUtc + p * hpp - dataStart;
          arr[p] = quantAqi(maxOf(src, a, a + hpp), c.scale);
        }
        q[c.key] = arr;
      }
      const tod = new Uint8Array(n);
      for (let p = 0; p < n; p++) tod[p] = tempTodBucket((firstUtc + p * hpp) * 2 + hpp + off * 2);
      chains.push({ fold, res: resPos[res], n, tod, q });
    }
  }, "train", VARS);
  return chains;
}

// ── Held-out evaluation (same shape as analyze-cross-var-heldout.ts) ─────────────

const zeros = (n: number) => new Array<number>(n).fill(0);
const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0);

function heldOutBits(train: number[], test: number[], fallback: number[], extra: (s: number) => number): number {
  const t = sum(train) > 0 ? train : fallback;
  const w = scaledWeights(t);
  const total = sum(w);
  let bits = 0;
  for (let s = 0; s < test.length; s++)
    if (test[s] > 0) bits += test[s] * (-Math.log2(w[s] / total) + extra(s));
  return bits;
}

// Score one scheme: nsym symbols under nctx contexts, over the cells `has` admits.
function evalScheme(
  chains: Chain[], nsym: number, nctx: number,
  symOf: (c: Chain, p: number) => number,
  ctxOf: (c: Chain, p: number) => number,
  from: (c: Chain) => number,
  extra: (s: number) => number = () => 0,
): { bpp: number; n: number } {
  const counts = Array.from({ length: N_FOLDS }, () => Array.from({ length: nctx }, () => zeros(nsym)));
  for (const c of chains)
    for (let p = from(c); p < c.n; p++) {
      const s = symOf(c, p);
      if (s < 0) continue;
      counts[c.fold][ctxOf(c, p)][s]++;
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
      bits += heldOutBits(train[ctx], counts[fold][ctx], fallback, extra);
      n += sum(counts[fold][ctx]);
    }
  }
  return { bpp: bits / Math.max(1, n), n };
}

// A column's own anchor+delta cost. prevΔ is the previous emitted delta (bucket 2 to start), as
// the shipped tables do. The escape symbol carries its raw payload.
function deltaCost(chains: Chain[], key: string, tod: boolean) {
  const nctx = NRES * NPREV * (tod ? NTOD : 1);
  const prevOf = new Map<Chain, Int8Array>();
  for (const c of chains) {
    const buf = new Int8Array(c.n).fill(2);
    const arr = c.q[key];
    for (let p = 2; p < c.n; p++) buf[p] = tempDeltaBucket(arr[p - 1] - arr[p - 2]);
    prevOf.set(c, buf);
  }
  return evalScheme(
    chains, NDELTA, nctx,
    (c, p) => aqiDeltaSym(c.q[key][p] - c.q[key][p - 1]),
    (c, p) => {
      const prev = prevOf.get(c)![p];
      return tod ? (c.res * NPREV + prev) * NTOD + c.tod[p] : c.res * NPREV + prev;
    },
    () => 1,
    (s) => (s === ESCAPE_SYM ? AQI_DELTA_ESCAPE_BITS : 0),
  );
}

// A headline's residual against max(subset), keyed by resolution alone (as the shipped US
// residual is). Periods where the headline or any subset member is missing are skipped — those
// encode through the no-data symbol, not this table.
function residualCost(chains: Chain[], head: Col, subset: Col[]) {
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
  for (const c of chains) for (let p = 0; p < c.n; p++) {
    const b = baseline(c, p);
    if (b < 0) continue;
    tot++;
    if (c.q[head.key][p] - b === 0) zero++;
  }
  const r = evalScheme(
    chains, NRESID, NRES,
    (c, p) => {
      const b = baseline(c, p);
      return b < 0 ? -1 : Math.min(Math.max(c.q[head.key][p] - b, 0), AQI_RESIDUAL_MAX);
    },
    (c) => c.res,
    () => 0,
  );
  return { ...r, zeroPct: (100 * zero) / Math.max(1, tot) };
}

// Which constituent is the headline's max — the ranking that says which columns a residual needs.
function drivers(chains: Chain[], head: Col, subset: Col[]) {
  const wins = zeros(subset.length);
  let tot = 0, exceeds = 0;
  for (const c of chains) for (let p = 0; p < c.n; p++) {
    const hv = c.q[head.key][p];
    if (hv === AQI_NO_DATA) continue;
    let best = -1, bi = -1;
    for (let i = 0; i < subset.length; i++) {
      const v = c.q[subset[i].key][p];
      if (v === AQI_NO_DATA) { bi = -1; break; }
      if (v > best) { best = v; bi = i; }
    }
    if (bi < 0) continue;
    tot++;
    wins[bi]++;
    if (hv > best) exceeds++;
  }
  return { wins, tot, exceedPct: (100 * exceeds) / Math.max(1, tot) };
}

async function main() {
  console.log("collecting chains…");
  const chains = await collectChains();
  console.log(`  ${chains.length} chains\n`);

  console.log("── Per-column anchor+delta cost (held-out b/period, pooled over 12h/6h/3h/1h) ──");
  console.log("  column      res×prevΔ   res×tod×prevΔ   n        status");
  for (const c of [...US_SUBS, ...EU_SUBS, US_HEAD, EU_HEAD]) {
    const plain = deltaCost(chains, c.key, false);
    const withTod = deltaCost(chains, c.key, true);
    console.log(
      `  ${c.name.padEnd(11)} ${plain.bpp.toFixed(3).padStart(8)} ${withTod.bpp.toFixed(3).padStart(14)}` +
      `   ${String(plain.n).padStart(9)}  ${c.shipped ? "shipped" : "NEW"}`,
    );
  }

  console.log("\n── Headline as a residual against max(subset) ──");
  // Every non-empty combination of each scale's top three constituents — the presence mask the
  // shipped residual tables will be keyed on. PM2.5, ozone and PM10 are the top three on BOTH
  // scales (only their dominance order differs), so both get the same 7-subset shape. The other
  // five constituents never lead a headline and are deliberately not part of the key; `all` is
  // printed as the ceiling those 7 are chasing.
  const TOP3: [string, Col, Col[]][] = [
    ["US", US_HEAD, [US_SUBS[0], US_SUBS[1], US_SUBS[2]]], // pm2.5, ozone, pm10
    ["EU", EU_HEAD, [EU_SUBS[0], EU_SUBS[3], EU_SUBS[1]]], // pm2.5, ozone, pm10
  ];
  const subsets: [string, Col, Col[]][] = [];
  for (const [scale, head, top3] of TOP3) {
    for (let mask = 1; mask < 8; mask++) {
      const members = top3.filter((_, i) => mask & (1 << i));
      const label = `${scale} vs ${members.map((m) => m.name.split(" ")[1]).join("+")}`;
      subsets.push([label, head, members]);
    }
    subsets.push([`${scale} vs all (ceiling)`, head, scale === "US" ? US_SUBS : EU_SUBS]);
  }
  console.log("  subset                    b/period   zero%      n");
  for (const [label, head, subset] of subsets) {
    const r = residualCost(chains, head, subset);
    console.log(
      `  ${label.padEnd(25)} ${r.bpp.toFixed(3).padStart(8)} ${r.zeroPct.toFixed(2).padStart(8)}` +
      `  ${String(r.n).padStart(9)}`,
    );
  }

  console.log("\n── Which constituent is the headline's max ──");
  for (const [head, subset] of [[US_HEAD, US_SUBS], [EU_HEAD, EU_SUBS]] as [Col, Col[]][]) {
    const d = drivers(chains, head, subset);
    const parts = subset.map((s, i) => `${s.name}=${((100 * d.wins[i]) / Math.max(1, d.tot)).toFixed(1)}%`);
    console.log(`  ${head.name}: ${parts.join("  ")}`);
    console.log(`    headline > max(all subs) in ${d.exceedPct.toFixed(2)}% of periods (n=${d.tot})`);
  }
}

main();
