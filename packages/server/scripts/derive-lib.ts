/**
 * Shared helpers for the codebook derivation scripts (derive-*.ts). Each derive script exports
 * `derive()`, returning the integer weight tables it owns keyed by the constant name they get in
 * packages/protocol/src/codebooks.gen.ts — generate-codebooks.ts collects them all and writes
 * that file. Run standalone (`node scripts/derive-foo.ts`), a script prints its tables and stats
 * without writing anything.
 */
import { readdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { HourlyData } from "../src/forecast.ts";

export const CORPUS = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "data", "raw", "gfs");

// Tables a derive script contributes, keyed by their codebooks.gen.ts constant name.
export type DerivedTables = Record<string, number[] | number[][] | number[][][]>;

// Visits every cached forecast in the corpus (files mid-write by the collector are skipped).
// `loc` is the corpus location id — the unit held-out splits divide on.
export async function eachForecast(cb: (hourly: HourlyData, startHour: number, loc: string) => void): Promise<void> {
  for (const loc of await readdir(CORPUS)) {
    const dir = join(CORPUS, loc);
    for (const f of await readdir(dir)) {
      if (!f.endsWith(".json")) continue;
      let rec: any;
      try { rec = JSON.parse(await readFile(join(dir, f), "utf8")); } catch { continue; } // mid-write
      cb(rec.response.hourly as HourlyData, Math.floor(Date.parse(rec.meta.run + "Z") / 3600000), loc);
    }
  }
}

// Deterministic 5-fold assignment by location id, for held-out (split-by-location) checks.
export const N_FOLDS = 5;
export function foldOf(loc: string): number {
  let h = 0;
  for (let i = 0; i < loc.length; i++) h = (h * 31 + loc.charCodeAt(i)) >>> 0;
  return h % N_FOLDS;
}

// Huffman code lengths per symbol via repeated merge of the two lowest-weight nodes (mirrors
// huffman.ts huffmanLengths), for the derive scripts' bit-cost estimates.
export function huffmanLengths(weights: number[]): number[] {
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

export const WEIGHT_SCALE = 1000;

// Counts → integer frequency weights: normalized to ~WEIGHT_SCALE total, every symbol ≥ 1 so any
// outlier stays representable. All-zero counts (a symbol never observed at all) become uniform.
export function scaledWeights(counts: number[]): number[] {
  const total = counts.reduce((a, b) => a + b, 0);
  if (total === 0) return counts.map(() => 1);
  return counts.map((c) => Math.max(1, Math.round((c / total) * WEIGHT_SCALE)));
}

// Renders one table as the `export const` declaration it gets in codebooks.gen.ts.
export function renderTable(name: string, t: number[] | number[][] | number[][][]): string {
  if (Array.isArray(t[0]) && Array.isArray((t[0] as number[][])[0])) {
    const outer = (t as number[][][]).map((m, i) =>
      `  [ // ${i}\n${m.map((r) => `    [${r.join(", ")}],`).join("\n")}\n  ],`).join("\n");
    return `export const ${name}: number[][][] = [\n${outer}\n];`;
  }
  if (Array.isArray(t[0]))
    return `export const ${name}: number[][] = [\n${(t as number[][]).map((r) => `  [${r.join(", ")}],`).join("\n")}\n];`;
  return `export const ${name}: number[] = [${(t as number[]).join(", ")}];`;
}

// Direct-run guard: `node scripts/derive-foo.ts` derives and prints that script's tables (stats
// go to the console from derive() itself) without touching codebooks.gen.ts.
export function runStandalone(moduleUrl: string, derive: () => Promise<DerivedTables>): void {
  if (process.argv[1] !== fileURLToPath(moduleUrl)) return;
  derive()
    .then((tables) => { for (const [name, t] of Object.entries(tables)) console.log(`\n${renderTable(name, t)}`); })
    .catch((e) => { console.error(e); process.exit(1); });
}
