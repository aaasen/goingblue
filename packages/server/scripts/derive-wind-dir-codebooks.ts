/**
 * Derive wind-direction Huffman codebooks from the corpus's order-1 transition structure: wind
 * direction persists hour-to-hour far more than it varies by regime (see
 * analyze-wind-dir-transitions.ts: P(next=prev) 68-90% depending on level), so instead of k-means
 * clustering per-message regime histograms into a handful of tables selected per column, each
 * direction gets a codebook keyed by the *previously decoded* direction — context both sides
 * already have, so it costs no header bits. 8 tables (one per possible previous direction) plus one
 * bootstrap table (the first-direction-of-sequence distribution) for the start of each sequence,
 * where there is no predecessor. Pooled across all four wind levels (surface + 500/600/700 hPa):
 * held-out bits/dir barely differs from deriving separate tables per level (<0.01 b/dir), so one
 * shared codebook set keeps things simple and lets every wind column reuse it. Integer weight
 * vectors are printed for pasting into packages/protocol/src/huffman.ts.
 *
 *   node packages/server/scripts/derive-wind-dir-codebooks.ts
 */
import { readdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { aggregateHourly, toFullPeriod, HOURS_PER_PERIOD, type HourlyData } from "../src/forecast.ts";
import { VARS_BIT } from "@weather/protocol";

const CORPUS = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "data", "raw", "gfs");
const NDIR = 8;                 // 8-point compass
const RES_IDX = 4;              // 1h — finest, most samples
const WIND_MASK = (1 << VARS_BIT.wind) | (1 << VARS_BIT.w500) | (1 << VARS_BIT.w600) | (1 << VARS_BIT.w700);
const DIR_FIELDS = ["wind_sfc_dir", "wind_500_dir", "wind_600_dir", "wind_700_dir"] as const;
const WEIGHT_SCALE = 1000;      // row (sums to 1) → integer frequency weights
const RAW_BITS = 3;             // cost of a fixed-width fallback

// One sequence of direction indices per (forecast, wind level), in order.
async function collectSequences(): Promise<number[][]> {
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
      const periods = aggregateHourly(h, h.time, n, RES_IDX, startHour).map((r) => toFullPeriod(r, WIND_MASK, "GFS", RES_IDX));
      for (const field of DIR_FIELDS) out.push(periods.map((p) => (p as any)[field] as number));
    }
  }
  return out;
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

function weightsFromCounts(counts: number[]): number[] {
  const total = counts.reduce((a, b) => a + b, 0);
  if (total === 0) return new Array(NDIR).fill(1);
  return counts.map((c) => Math.max(1, Math.round((c / total) * WEIGHT_SCALE)));
}

async function main() {
  const sequences = await collectSequences();
  const totalSymbols = sequences.reduce((s, seq) => s + seq.length, 0);
  console.log(`Sequences (forecast × wind level): ${sequences.length}, symbols: ${totalSymbols}`);

  // Marginal (order-0) counts — the fallback for a prev-direction that's never actually seen as a
  // predecessor in the (pooled) corpus (still needs a representable codebook; in practice all 8
  // directions occur constantly, so this fallback is unused).
  const marginal = new Array(NDIR).fill(0);
  for (const seq of sequences) for (const d of seq) marginal[d]++;

  // First-direction distribution — what the bootstrap table encodes (no predecessor exists yet).
  const firstCounts = new Array(NDIR).fill(0);
  for (const seq of sequences) if (seq.length > 0) firstCounts[seq[0]]++;

  // Transition counts: transitions[prev][next], pooled across all sequences (all forecasts × levels).
  const transitions: number[][] = Array.from({ length: NDIR }, () => new Array(NDIR).fill(0));
  for (const seq of sequences) for (let i = 1; i < seq.length; i++) transitions[seq[i - 1]][seq[i]]++;

  const bootstrapWeights = weightsFromCounts(firstCounts);
  const weights = transitions.map((row) => {
    const total = row.reduce((a, b) => a + b, 0);
    return weightsFromCounts(total > 0 ? row : marginal);
  });

  // Sanity check: every table beats the raw 3-bit fallback on its own training distribution.
  const bootstrapLens = huffmanLengths(bootstrapWeights);
  const lens = weights.map(huffmanLengths);
  const costUnder = (len: number[], hist: number[]) => {
    const total = hist.reduce((a, b) => a + b, 0) || 1;
    return hist.reduce((s, c, i) => s + (c / total) * len[i], 0);
  };
  console.log(`Bootstrap table cost on its own distribution: ${costUnder(bootstrapLens, firstCounts).toFixed(3)} bits (raw = ${RAW_BITS})`);
  for (let s = 0; s < NDIR; s++) {
    const c = costUnder(lens[s], transitions[s]);
    if (c > RAW_BITS) console.warn(`  prev=${s}: ${c.toFixed(3)} bits > raw fallback (${RAW_BITS}) — thin/noisy row`);
  }

  // Overall mean bits/direction: bootstrap for each sequence's first direction, order-1 table
  // (keyed by the true previous direction) for the rest.
  let bits = 0;
  for (const seq of sequences) {
    for (let i = 0; i < seq.length; i++) {
      bits += i === 0 ? bootstrapLens[seq[0]] : lens[seq[i - 1]][seq[i]];
    }
  }
  console.log(`Mean bits/direction (order-1): ${(bits / totalSymbols).toFixed(3)}  (raw = ${RAW_BITS.toFixed(3)})`);

  console.log(`\n// Paste into packages/protocol/src/huffman.ts:`);
  console.log(`const WIND_DIR_BOOTSTRAP_WEIGHTS: number[] = [${bootstrapWeights.join(", ")}];\n`);
  console.log("// WIND_DIR_WEIGHTS[prevDir] is the codebook for the direction that follows `prevDir`.");
  console.log("const WIND_DIR_WEIGHTS: number[][] = [");
  for (const w of weights) console.log(`  [${w.join(", ")}],`);
  console.log("];");
}

main().catch((e) => { console.error(e); process.exit(1); });
