/**
 * Derive a single wind-speed-delta Huffman codebook from the corpus's pooled hour-to-hour
 * quantized-speed delta distribution. The quantized speed step (0..15, see
 * WIND_SPEED_BITS/KPH_PER_STEP in v1.ts) is bounded, so like freezing level the full delta range
 * -15..15 (31 symbols) fits directly in the alphabet — no escape/raw-payload fallback needed.
 * Counts are pooled across all four wind levels (surface + 500/600/700 hPa) — same call as wind
 * direction (see derive-wind-dir-codebooks.ts): pooling barely changes the bit cost vs. deriving
 * separate tables per level.
 *
 * Earlier versions of this script k-means clustered per-(forecast × wind level) delta histograms
 * into 16 tables selected per message. Like freezing level (see
 * derive-freeze-delta-codebooks.ts), that doesn't pay off: wind-speed deltas are dominated
 * everywhere by "usually 0, occasionally ±1", so the clusters only picked up local volatility. A
 * held-out check (split by location) found cheapest-of-16 with a 4-bit selector at 1.529 b/period
 * vs 1.514 b/period for one shared table — the single table actually generalizes better. The
 * integer weight vector is printed for pasting into packages/protocol/src/huffman.ts.
 *
 *   node packages/server/scripts/derive-wind-speed-delta-codebooks.ts
 */
import { readdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { aggregateHourly, toFullPeriod, HOURS_PER_PERIOD, type HourlyData } from "../src/forecast.ts";
import { VARS_BIT } from "@weather/protocol";

const CORPUS = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "data", "raw", "gfs");
const SPEED_BITS = 4;              // matches WIND_SPEED_BITS in v1.ts (steps 0..15)
const SPEED_MAX = (1 << SPEED_BITS) - 1;
const NSYM = 2 * SPEED_MAX + 1;    // 31: deltas -15..15, no escape needed (already bounded)
const KPH_PER_STEP = 5 * 1.609344; // must match v1.ts
const WIND_MASK = (1 << VARS_BIT.wind) | (1 << VARS_BIT.w500) | (1 << VARS_BIT.w600) | (1 << VARS_BIT.w700);
const SPEED_FIELDS = ["wind_sfc_kph", "wind_500_kph", "wind_600_kph", "wind_700_kph"] as const;
const RES_IDX = 4;                 // 1h — finest, most samples
const WEIGHT_SCALE = 1000;
const RAW_BITS = SPEED_BITS;       // cost of the fixed-width fallback

const quantSpeed = (kph: number): number => Math.min(Math.floor(kph / KPH_PER_STEP), SPEED_MAX);
const deltaSym = (delta: number): number => delta + SPEED_MAX; // -15..15 -> 0..30

// Pooled delta counts across the whole corpus (all forecasts × wind levels).
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
      const periods = aggregateHourly(h, h.time, n, RES_IDX, startHour).map((r) => toFullPeriod(r, WIND_MASK, "GFS", RES_IDX));
      for (const field of SPEED_FIELDS) {
        for (let i = 1; i < periods.length; i++) {
          const prev = quantSpeed(((periods[i - 1] as any)[field] as number) ?? 0);
          const cur = quantSpeed(((periods[i] as any)[field] as number) ?? 0);
          counts[deltaSym(cur - prev)]++;
        }
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

  console.log(`\n// Paste into packages/protocol/src/huffman.ts as WIND_SPEED_DELTA_WEIGHTS:`);
  console.log(`const WIND_SPEED_DELTA_WEIGHTS: number[] = [${weights.join(", ")}];`);
}

main().catch((e) => { console.error(e); process.exit(1); });
