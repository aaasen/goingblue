/**
 * Derive weathercode Huffman codebooks from the corpus's order-1 transition structure: weather
 * persists hour-to-hour far more than it varies by climate/region (see
 * analyze-weathercode-transitions.ts), so instead of k-means-clustering per-forecast regime
 * histograms into a handful of tables selected per message, each symbol gets a codebook keyed by
 * the *previously decoded* symbol — context both sides already have, so it costs no header bits.
 * NSYM tables (one per possible previous symbol) plus one bootstrap table (the first-symbol
 * distribution) for the start of each sequence, where there is no predecessor.
 *
 * Tables land in packages/protocol/src/codebooks.gen.ts via `pnpm generate`; run standalone
 * (below) to derive and print without writing:
 *
 *   pnpm exec tsx packages/codec-server/scripts/derive-weathercode-codebooks.ts
 */
import { aggregateHourly, toFullPeriod, HOURS_PER_PERIOD } from "../src/forecast.ts";
import { WMO2IDX, WMO_CODES } from "@weather/protocol";
import {
  deriveCounts, tableOffsets, rowAt, rowCostBits, huffmanLengths, scaledWeights, runStandalone,
  type CellCounter, type DerivedTables,
} from "./derive-lib.ts";

const NSYM = WMO_CODES.length; // 28
const RES_IDX = 4;              // 1h — finest, most samples
const RAW_BITS = Math.ceil(Math.log2(NSYM)); // 5 — cost of a fixed-width fallback

export function counter(): CellCounter {
  const tables = [
    { name: "weathercodeBootstrap", dims: [NSYM] },
    { name: "weathercode", dims: [NSYM, NSYM] }, // trans[prev][next]
  ];
  const { offsets, nSlots } = tableOffsets(tables);
  const BOOT = offsets.weathercodeBootstrap, TRANS = offsets.weathercode;

  // Marginal (order-0) counts — every symbol occurrence, first or not — the fallback for a
  // prev-symbol never seen as a predecessor in the corpus (still needs a representable codebook).
  const marginalOf = (counts: ArrayLike<number>): number[] => {
    const m = rowAt(counts, BOOT, NSYM);
    for (let prev = 0; prev < NSYM; prev++)
      for (let s = 0; s < NSYM; s++) m[s] += counts[TRANS + prev * NSYM + s];
    return m;
  };
  const sum = (r: number[]) => r.reduce((a, b) => a + b, 0);

  return {
    tables, nSlots,
    countCell(ctx, add) {
      // Its own aggregation: one resolution, capped at 128 periods and anchored on the raw
      // request hour, so neither shared slice fits.
      const { hourly: h, startHour } = ctx;
      const n = Math.min(128, Math.floor(h.time.length / HOURS_PER_PERIOD[RES_IDX]));
      const periods = aggregateHourly(h, h.time, n, RES_IDX, startHour).map((r) => toFullPeriod(r, new Set(), "US", RES_IDX));
      if (periods.length === 0) return;
      const seq = periods.map((p) => WMO2IDX[p.weathercode] ?? 0);
      add(BOOT + seq[0]);
      for (let i = 1; i < seq.length; i++) add(TRANS + seq[i - 1] * NSYM + seq[i]);
    },
    tablesFrom(counts): DerivedTables {
      const marginal = marginalOf(counts);
      return {
        WEATHERCODE_BOOTSTRAP_WEIGHTS: scaledWeights(rowAt(counts, BOOT, NSYM)),
        WEATHERCODE_WEIGHTS: Array.from({ length: NSYM }, (_, prev) => {
          const row = rowAt(counts, TRANS + prev * NSYM, NSYM);
          return scaledWeights(sum(row) > 0 ? row : marginal);
        }),
      };
    },
    costBits(counts) {
      const L = new Float64Array(nSlots);
      const marginal = marginalOf(counts);
      const put = (start: number, row: number[]) => {
        const c = rowCostBits(scaledWeights(row));
        for (let s = 0; s < NSYM; s++) L[start + s] = c[s];
      };
      put(BOOT, rowAt(counts, BOOT, NSYM));
      for (let prev = 0; prev < NSYM; prev++) {
        const row = rowAt(counts, TRANS + prev * NSYM, NSYM);
        put(TRANS + prev * NSYM, sum(row) > 0 ? row : marginal);
      }
      return L;
    },
  };
}

export async function derive(precounted?: Float64Array): Promise<DerivedTables> {
  const c = counter();
  const counts = precounted ?? await deriveCounts(c);
  const { offsets } = tableOffsets(c.tables);
  const BOOT = offsets.weathercodeBootstrap, TRANS = offsets.weathercode;
  const firstCounts = rowAt(counts, BOOT, NSYM);
  const out = c.tablesFrom(counts);
  const bootstrapWeights = out.WEATHERCODE_BOOTSTRAP_WEIGHTS as number[];
  const weights = out.WEATHERCODE_WEIGHTS as number[][];

  // Sanity check: every table beats the raw 5-bit fallback on its own training distribution.
  const bootstrapLens = huffmanLengths(bootstrapWeights);
  const lens = weights.map(huffmanLengths);
  const costUnder = (len: number[], hist: number[]) => {
    const total = hist.reduce((a, b) => a + b, 0) || 1;
    return hist.reduce((s, cnt, i) => s + (cnt / total) * len[i], 0);
  };
  console.log(`Bootstrap table cost on its own distribution: ${costUnder(bootstrapLens, firstCounts).toFixed(3)} bits (raw = ${RAW_BITS})`);
  let bits = 0, totalSymbols = 0;
  for (let prev = 0; prev < NSYM; prev++) {
    const row = rowAt(counts, TRANS + prev * NSYM, NSYM);
    const cost = costUnder(lens[prev], row);
    if (cost > RAW_BITS) console.warn(`  prev=${prev}: ${cost.toFixed(3)} bits > raw fallback (${RAW_BITS}) — thin/noisy row`);
    for (let s = 0; s < NSYM; s++) { bits += row[s] * lens[prev][s]; totalSymbols += row[s]; }
  }
  for (let s = 0; s < NSYM; s++) { bits += firstCounts[s] * bootstrapLens[s]; totalSymbols += firstCounts[s]; }

  // Overall mean bits/symbol: bootstrap for each sequence's first symbol, order-1 table (keyed by
  // the true previous symbol) for the rest.
  console.log(`Symbols: ${totalSymbols}; mean bits/weathercode (order-1): ${(bits / totalSymbols).toFixed(3)}  (raw = ${RAW_BITS.toFixed(3)})`);
  return out;
}

runStandalone(import.meta.url, derive);
