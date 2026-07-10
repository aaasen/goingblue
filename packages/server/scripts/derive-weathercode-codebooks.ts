/**
 * Derive weathercode Huffman codebooks by k-means clustering the corpus's per-forecast weathercode
 * distributions. One sample per forecast — a NSYM-bin normalized histogram of the WMO index (see
 * WMO2IDX). k=WC_TABLE_COUNT clusters → that many codebooks whose integer weight vectors are
 * printed for pasting into packages/protocol/src/huffman.ts (WEIGHTS).
 *
 *   node packages/server/scripts/derive-weathercode-codebooks.ts
 */
import { readdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { aggregateHourly, toFullPeriod, HOURS_PER_PERIOD, type HourlyData } from "../src/forecast.ts";
import { WMO2IDX } from "@weather/protocol";

const CORPUS = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "data", "raw", "gfs");
const K = 16;                   // codebook count — fills the 4-bit wc_table selector
const NSYM = Object.keys(WMO2IDX).length; // 28
const RES_IDX = 4;              // 1h — finest, most samples
const WEIGHT_SCALE = 1000;      // centroid (sums to 1) → integer frequency weights
const RAW_BITS = Math.ceil(Math.log2(NSYM)); // 5 — cost of a fixed-width fallback

// Deterministic RNG (mulberry32) so re-running yields the same codebooks.
function rng(seed: number) {
  return () => {
    seed |= 0; seed = (seed + 0x6D2B79F5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// One normalized NSYM-bin weathercode histogram per forecast.
async function collectSamples(): Promise<number[][]> {
  const out: number[][] = [];
  for (const loc of await readdir(CORPUS)) {
    const dir = join(CORPUS, loc);
    for (const f of await readdir(dir)) {
      if (!f.endsWith(".json")) continue;
      let rec: any;
      try { rec = JSON.parse(await readFile(join(dir, f), "utf8")); } catch { continue; } // mid-write
      const h = rec.response.hourly as HourlyData;
      const startHour = Math.floor(Date.parse(rec.meta.run + "Z") / 3600000);
      const n = Math.min(128, Math.floor(h.time.length / HOURS_PER_PERIOD[RES_IDX]));
      const periods = aggregateHourly(h, h.time, n, RES_IDX, startHour).map((r) => toFullPeriod(r, 0, "GFS", RES_IDX));
      const hist = new Array(NSYM).fill(0);
      for (const p of periods) hist[WMO2IDX[p.weathercode] ?? 0]++;
      const total = periods.length;
      if (total > 0) out.push(hist.map((c) => c / total));
    }
  }
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
    // k-means++ init
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

// Huffman code lengths for a weight vector (mirrors huffman.ts huffmanLengths), for the bits estimate.
function huffmanLengths(weights: number[]): number[] {
  const n = weights.length;
  interface Node { w: number; sym: number; left: number; right: number; }
  const nodes: Node[] = weights.map((w, i) => ({ w, sym: i, left: -1, right: -1 }));
  let alive = nodes.map((_, i) => i);
  while (alive.length > 1) {
    alive.sort((a, b) => nodes[a].w - nodes[b].w);
    const a = alive.shift()!, b = alive.shift()!;
    nodes.push({ w: nodes[a].w + nodes[b].w, sym: -1, left: a, right: b });
    alive.push(nodes.length - 1);
  }
  const lengths = new Array(n).fill(0);
  const walk = (i: number, depth: number) => {
    const nd = nodes[i];
    if (nd.sym >= 0) { lengths[nd.sym] = Math.max(depth, 1); return; }
    walk(nd.left, depth + 1); walk(nd.right, depth + 1);
  };
  walk(alive[0], 0);
  return lengths;
}

async function main() {
  const data = await collectSamples();
  console.log(`Samples (forecasts): ${data.length}`);

  const centroids = kmeans(data, K);
  let weights = centroids.map((c) => c.map((v) => Math.max(1, Math.round(v * WEIGHT_SCALE))));

  // Safety: guarantee a raw-equivalent option — if the cheapest-of-K expected cost ever exceeds
  // RAW_BITS on a uniform column, force the flattest codebook to uniform weights.
  const lengths = () => weights.map(huffmanLengths);
  const uniform = new Array(NSYM).fill(1 / NSYM);
  const costUnder = (len: number[], hist: number[]) => hist.reduce((s, p, d) => s + p * len[d], 0);
  const cheapest = (hist: number[], lens: number[][]) => Math.min(...lens.map((l) => costUnder(l, hist)));
  if (cheapest(uniform, lengths()) > RAW_BITS + 1e-9) {
    const flattest = weights
      .map((w, i) => [i, Math.max(...w) / Math.min(...w)] as const)
      .sort((a, b) => a[1] - b[1])[0][0];
    weights[flattest] = new Array(NSYM).fill(1);
  }
  // Convention: table 0 is the near-uniform general fallback — move it to the front.
  const uniformIdx = weights.findIndex((w) => w.every((v) => v === w[0]));
  if (uniformIdx > 0) weights.unshift(weights.splice(uniformIdx, 1)[0]);

  const lens = lengths();
  const meanBits = data.reduce((s, h) => s + cheapest(h, lens), 0) / data.length;
  console.log(`Mean bits/weathercode (cheapest-of-${K}): ${meanBits.toFixed(3)}  (raw = ${RAW_BITS.toFixed(3)})`);
  console.log(`\n// Paste into packages/protocol/src/huffman.ts as WEIGHTS:`);
  console.log("const WEIGHTS: number[][] = [");
  for (const w of weights) console.log(`  [${w.join(", ")}],`);
  console.log("];");
}

main().catch((e) => { console.error(e); process.exit(1); });
