/**
 * Derive temperature-delta Huffman codebooks by k-means clustering the corpus's per-(forecast ×
 * resolution) hour-to-hour temp_c delta distributions. Samples are pooled across ALL resolutions
 * (1h/3h/6h/12h/24h) — the encoder doesn't know resolution in advance (it's off the wire, and a
 * message can even mix resolutions in a future dynamic-duration scheme), so the codebook selector
 * must earn its keep on the actual delta shape, not a hardcoded resolution. Alphabet: deltas -7..7
 * (15 symbols) map to indices 0..14, plus an ESCAPE symbol (index 15) for |delta|>7, followed by a
 * raw 6-bit signed (bias 32) field. k=TEMP_DELTA_TABLE_COUNT clusters → that many codebooks.
 *
 * Tables land in packages/protocol/src/codebooks.gen.ts via `pnpm generate`; run standalone
 * (below) to derive and print without writing:
 *
 *   node packages/server/scripts/derive-temp-delta-codebooks.ts
 */
import { aggregateHourly, toFullPeriod, HOURS_PER_PERIOD } from "../src/forecast.ts";
import { VARS_BIT } from "@weather/protocol";
import { eachForecast, huffmanLengths, WEIGHT_SCALE, runStandalone, type DerivedTables } from "./derive-lib.ts";

const K = 16;                    // codebook count — fills a 4-bit table selector
const CORE_RADIUS = 7;           // symbols 0..14 = deltas -7..7
const NSYM = 2 * CORE_RADIUS + 2; // 16: 15 core + 1 escape
const ESCAPE_SYM = NSYM - 1;     // 15
const ESCAPE_BITS = 6;           // raw payload width when escape fires (bias 32, range -32..31)
const RES_IDXS = [0, 1, 2, 3, 4]; // 24h, 12h, 6h, 3h, 1h
const RAW_BITS = 8;              // cost of the fixed-width fallback (current 8-bit raw field)

function rng(seed: number) {
  return () => {
    seed |= 0; seed = (seed + 0x6D2B79F5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function deltaSym(delta: number): number {
  return Math.abs(delta) <= CORE_RADIUS ? delta + CORE_RADIUS : ESCAPE_SYM;
}

interface Sample { resIdx: number; hist: number[]; }

// One normalized NSYM-bin delta histogram per (forecast, resolution).
async function collectSamples(): Promise<Sample[]> {
  const out: Sample[] = [];
  await eachForecast((h, startHour) => {
    for (const resIdx of RES_IDXS) {
      const n = Math.floor(h.time.length / HOURS_PER_PERIOD[resIdx]);
      if (n < 3) continue; // need at least 2 deltas for a meaningful sample
      const periods = aggregateHourly(h, h.time, n, resIdx, startHour).map((r) => toFullPeriod(r, 1 << VARS_BIT.temp, "GFS", resIdx));
      const hist = new Array(NSYM).fill(0);
      let count = 0;
      for (let i = 1; i < periods.length; i++) {
        const prev = periods[i - 1].temp_c, cur = periods[i].temp_c;
        if (prev == null || cur == null) continue;
        hist[deltaSym(Math.round(cur) - Math.round(prev))]++;
        count++;
      }
      if (count > 0) out.push({ resIdx, hist: hist.map((c) => c / count) });
    }
  });
  return out;
}

const dist2 = (a: number[], b: number[]) => a.reduce((s, x, i) => s + (x - b[i]) ** 2, 0);
const nearest = (x: number[], cs: number[][]) => {
  let best = 0, bd = Infinity;
  for (let c = 0; c < cs.length; c++) { const d = dist2(x, cs[c]); if (d < bd) { bd = d; best = c; } }
  return best;
};

function kmeans(data: number[][], k: number, restarts = 10) {
  const rand = rng(42);
  let best: { centroids: number[][]; inertia: number } | null = null;
  for (let r = 0; r < restarts; r++) {
    const centroids: number[][] = [data[Math.floor(rand() * data.length)].slice()];
    while (centroids.length < k) {
      const d2 = data.map((x) => dist2(x, centroids[nearest(x, centroids)]));
      const sum = d2.reduce((a, b) => a + b, 0) || 1;
      let t = rand() * sum, i = 0;
      while (t > d2[i] && i < data.length - 1) t -= d2[i++];
      centroids.push(data[i].slice());
    }
    const assign = new Array(data.length).fill(-1);
    for (let it = 0; it < 100; it++) {
      let changed = false;
      for (let i = 0; i < data.length; i++) { const a = nearest(data[i], centroids); if (a !== assign[i]) { assign[i] = a; changed = true; } }
      if (!changed) break;
      const sums = centroids.map(() => new Array(NSYM).fill(0));
      const counts = new Array(k).fill(0);
      for (let i = 0; i < data.length; i++) { counts[assign[i]]++; for (let d = 0; d < NSYM; d++) sums[assign[i]][d] += data[i][d]; }
      for (let c = 0; c < k; c++) if (counts[c] > 0) centroids[c] = sums[c].map((s) => s / counts[c]);
    }
    const inertia = data.reduce((s, x) => s + dist2(x, centroids[nearest(x, centroids)]), 0);
    if (!best || inertia < best.inertia) best = { centroids, inertia };
  }
  return best!.centroids;
}

// Cost of a symbol under a length set — ESCAPE additionally pays its raw payload.
function symCost(len: number[], sym: number): number {
  return len[sym] + (sym === ESCAPE_SYM ? ESCAPE_BITS : 0);
}

export async function derive(): Promise<DerivedTables> {
  const samples = await collectSamples();
  const data = samples.map((s) => s.hist);
  console.log(`Samples (forecast × resolution): ${data.length}`);

  const centroids = kmeans(data, K);
  const weights = centroids.map((c) => c.map((v) => Math.max(1, Math.round(v * WEIGHT_SCALE))));

  const lengths = () => weights.map(huffmanLengths);
  const uniform = new Array(NSYM).fill(1 / NSYM);
  const costUnder = (len: number[], hist: number[]) =>
    hist.reduce((s, p, sym) => s + p * symCost(len, sym), 0);
  const cheapest = (hist: number[], lens: number[][]) => Math.min(...lens.map((l) => costUnder(l, hist)));
  if (cheapest(uniform, lengths()) > RAW_BITS + 1e-9) {
    const flattest = weights
      .map((w, i) => [i, Math.max(...w) / Math.min(...w)] as const)
      .sort((a, b) => a[1] - b[1])[0][0];
    weights[flattest] = new Array(NSYM).fill(1);
  }
  const uniformIdx = weights.findIndex((w) => w.every((v) => v === w[0]));
  if (uniformIdx > 0) weights.unshift(weights.splice(uniformIdx, 1)[0]);

  const lens = lengths();
  const meanBits = data.reduce((s, h) => s + cheapest(h, lens), 0) / data.length;
  console.log(`Mean bits/period (cheapest-of-${K}, escape-aware): ${meanBits.toFixed(3)}  (raw = ${RAW_BITS})`);

  // Report per-resolution breakdown so we can see whether pooling actually serves every resolution.
  console.log(`Per-resolution mean bits/period (cheapest-of-${K}):`);
  const RES_LABEL: Record<number, string> = { 0: "24h", 1: "12h", 2: "6h", 3: "3h", 4: "1h" };
  for (const resIdx of RES_IDXS) {
    const forRes = samples.filter((s) => s.resIdx === resIdx).map((s) => s.hist);
    const mean = forRes.reduce((s, h) => s + cheapest(h, lens), 0) / forRes.length;
    console.log(`  ${RES_LABEL[resIdx]}: n=${forRes.length} mean=${mean.toFixed(3)}`);
  }

  return { TEMP_DELTA_WEIGHTS: weights };
}

runStandalone(import.meta.url, derive);
