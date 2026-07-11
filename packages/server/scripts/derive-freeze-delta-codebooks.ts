/**
 * Derive a single freezing-level-delta Huffman codebook from the corpus's pooled hour-to-hour
 * quantized freeze-level delta distribution. The quantized freeze-level step (0..15, 304.8 m /
 * 1000 ft steps — see the freeze column in v1.ts) is bounded, so like wind speed the full delta
 * range -15..15 (31 symbols) fits directly in the alphabet — no escape/raw-payload fallback needed.
 *
 * Earlier versions of this script k-means clustered per-forecast delta histograms into 16 tables
 * selected per message (like weathercode/wind direction). That doesn't pay off here: unlike
 * weathercode and wind direction, freeze-level deltas don't have genuinely distinct regimes across
 * locations/seasons — they're dominated everywhere by "usually 0, occasionally ±1", so the 16
 * clusters were only picking up local volatility, not real distributional differences. A held-out
 * check confirmed cheapest-of-16 (1.371 b/period, including the 4-bit selector) is actually WORSE
 * than a single shared table (1.340 b/period, no selector) — so this script now just builds the one
 * table. The integer weight vector is printed for pasting into packages/protocol/src/huffman.ts.
 *
 *   node packages/server/scripts/derive-freeze-delta-codebooks.ts
 */
import { readdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { aggregateHourly, toFullPeriod, HOURS_PER_PERIOD, type HourlyData } from "../src/forecast.ts";
import { VARS_BIT } from "@weather/protocol";

const CORPUS = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "data", "raw", "gfs");
const STEP_BITS = 4;               // matches the freeze column width in v1.ts (steps 0..15)
const STEP_MAX = (1 << STEP_BITS) - 1;
const NSYM = 2 * STEP_MAX + 1;     // 31: deltas -15..15, no escape needed (already bounded)
const STEP_M = 304.8;              // 1000 ft, must match v1.ts
const RES_IDX = 4;                 // 1h — finest, most samples
const WEIGHT_SCALE = 1000;
const RAW_BITS = STEP_BITS;        // cost of the fixed-width fallback

const quantFreeze = (m: number): number => Math.min(Math.floor(m / STEP_M), STEP_MAX);
const deltaSym = (delta: number): number => delta + STEP_MAX; // -15..15 -> 0..30

// Pooled delta counts across the whole corpus.
async function collectCounts(): Promise<number[]> {
  const counts = new Array(NSYM).fill(0);
  for (const loc of await readdir(CORPUS)) {
    const dir = join(CORPUS, loc);
    for (const f of await readdir(dir)) {
      if (!f.endsWith(".json")) continue;
      let rec: any;
      try { rec = JSON.parse(await readFile(join(dir, f), "utf8")); } catch { continue; } // mid-write
      const h = rec.response.hourly as HourlyData;
      const startHour = Math.floor(Date.parse(rec.meta.run + "Z") / 3600000);
      const n = Math.min(128, Math.floor(h.time.length / HOURS_PER_PERIOD[RES_IDX]));
      const periods = aggregateHourly(h, h.time, n, RES_IDX, startHour).map((r) => toFullPeriod(r, 1 << VARS_BIT.freeze, "GFS", RES_IDX));
      for (let i = 1; i < periods.length; i++) {
        const prev = quantFreeze(periods[i - 1].freeze_m ?? 0);
        const cur = quantFreeze(periods[i].freeze_m ?? 0);
        counts[deltaSym(cur - prev)]++;
      }
    }
  }
  return counts;
}

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
  const counts = await collectCounts();
  const total = counts.reduce((a, b) => a + b, 0);
  console.log(`Delta samples: ${total}`);

  const weights = counts.map((c) => Math.max(1, Math.round((c / total) * WEIGHT_SCALE)));
  const lens = huffmanLengths(weights);
  const meanBits = counts.reduce((s, c, sym) => s + c * lens[sym], 0) / total;
  console.log(`Mean bits/period (single table): ${meanBits.toFixed(3)}  (raw = ${RAW_BITS})`);

  console.log(`\n// Paste into packages/protocol/src/huffman.ts as FREEZE_DELTA_WEIGHTS:`);
  console.log(`const FREEZE_DELTA_WEIGHTS: number[] = [${weights.join(", ")}];`);
}

main().catch((e) => { console.error(e); process.exit(1); });
