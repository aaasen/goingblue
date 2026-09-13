/**
 * Derive every wind codebook: the gust chain and the surface-given-gust tables (wind-gust.ts),
 * the direction tables (wind-direction.ts), and the speed deltas for the surface and every
 * pressure level (wind-speed.ts). Each module keeps its own counter and stats; this script lays
 * their slot spaces end to end so `pnpm generate` treats wind as one codebook file.
 *
 * Tables land in packages/protocol/src/codebooks/wind.gen.ts via `pnpm generate`; run standalone
 * (below) to derive and print without writing:
 *
 *   pnpm exec tsx packages/codec-server/scripts/derive-wind-codebooks.ts
 */
import * as gust from "./wind-gust.ts";
import * as direction from "./wind-direction.ts";
import * as speed from "./wind-speed.ts";
import {
  combineCounters, deriveCounts, runStandalone, splitCounts, type CellCounter, type DerivedTables,
} from "./derive-lib.ts";

// Table order in wind.gen.ts follows this list.
const PARTS = [gust, direction, speed];

export function counter(): CellCounter {
  return combineCounters(PARTS.map((p) => p.counter()));
}

export async function derive(precounted?: Float64Array): Promise<DerivedTables> {
  const parts = PARTS.map((p) => p.counter());
  const counts = precounted ?? await deriveCounts(combineCounters(parts));
  const vecs = splitCounts(parts, counts);
  const tables: DerivedTables = {};
  for (let i = 0; i < PARTS.length; i++) Object.assign(tables, await PARTS[i].derive(vecs[i]));
  return tables;
}

runStandalone(import.meta.url, derive);
