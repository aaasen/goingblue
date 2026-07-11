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
 *   node packages/server/scripts/derive-weathercode-codebooks.ts
 */
import { aggregateHourly, toFullPeriod, HOURS_PER_PERIOD } from "../src/forecast.ts";
import { WMO2IDX, WMO_CODES } from "@weather/protocol";
import { eachForecast, huffmanLengths, scaledWeights, runStandalone, type DerivedTables } from "./derive-lib.ts";

const NSYM = WMO_CODES.length; // 28
const RES_IDX = 4;              // 1h — finest, most samples
const RAW_BITS = Math.ceil(Math.log2(NSYM)); // 5 — cost of a fixed-width fallback

// One sequence of WMO indices per forecast, in order.
async function collectSequences(): Promise<number[][]> {
  const out: number[][] = [];
  await eachForecast((h, startHour) => {
    const n = Math.min(128, Math.floor(h.time.length / HOURS_PER_PERIOD[RES_IDX]));
    const periods = aggregateHourly(h, h.time, n, RES_IDX, startHour).map((r) => toFullPeriod(r, 0, "GFS", RES_IDX));
    if (periods.length > 0) out.push(periods.map((p) => WMO2IDX[p.weathercode] ?? 0));
  });
  return out;
}

export async function derive(): Promise<DerivedTables> {
  const sequences = await collectSequences();
  const totalSymbols = sequences.reduce((s, seq) => s + seq.length, 0);
  console.log(`Forecasts: ${sequences.length}, symbols: ${totalSymbols}`);

  // Marginal (order-0) counts — the fallback for a prev-symbol that's never actually seen as a
  // predecessor in the corpus (still needs a representable codebook).
  const marginal = new Array(NSYM).fill(0);
  for (const seq of sequences) for (const s of seq) marginal[s]++;

  // First-symbol distribution — what the bootstrap table encodes (no predecessor exists yet).
  const firstCounts = new Array(NSYM).fill(0);
  for (const seq of sequences) if (seq.length > 0) firstCounts[seq[0]]++;

  // Transition counts: transitions[prev][next].
  const transitions: number[][] = Array.from({ length: NSYM }, () => new Array(NSYM).fill(0));
  for (const seq of sequences) for (let i = 1; i < seq.length; i++) transitions[seq[i - 1]][seq[i]]++;

  const bootstrapWeights = scaledWeights(firstCounts);
  const weights = transitions.map((row) => {
    const total = row.reduce((a, b) => a + b, 0);
    return scaledWeights(total > 0 ? row : marginal);
  });

  // Sanity check: every table beats the raw 5-bit fallback on its own training distribution.
  const bootstrapLens = huffmanLengths(bootstrapWeights);
  const lens = weights.map(huffmanLengths);
  const costUnder = (len: number[], hist: number[]) => {
    const total = hist.reduce((a, b) => a + b, 0) || 1;
    return hist.reduce((s, c, i) => s + (c / total) * len[i], 0);
  };
  console.log(`Bootstrap table cost on its own distribution: ${costUnder(bootstrapLens, firstCounts).toFixed(3)} bits (raw = ${RAW_BITS})`);
  for (let s = 0; s < NSYM; s++) {
    const c = costUnder(lens[s], transitions[s]);
    if (c > RAW_BITS) console.warn(`  prev=${s}: ${c.toFixed(3)} bits > raw fallback (${RAW_BITS}) — thin/noisy row`);
  }

  // Overall mean bits/symbol: bootstrap for each sequence's first symbol, order-1 table (keyed by
  // the true previous symbol) for the rest.
  let bits = 0;
  for (const seq of sequences) {
    for (let i = 0; i < seq.length; i++) {
      bits += i === 0 ? bootstrapLens[seq[0]] : lens[seq[i - 1]][seq[i]];
    }
  }
  console.log(`Mean bits/weathercode (order-1): ${(bits / totalSymbols).toFixed(3)}  (raw = ${RAW_BITS.toFixed(3)})`);

  return { WEATHERCODE_BOOTSTRAP_WEIGHTS: bootstrapWeights, WEATHERCODE_WEIGHTS: weights };
}

runStandalone(import.meta.url, derive);
