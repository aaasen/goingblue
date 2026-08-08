/**
 * Derive single cloud-cover-delta Huffman codebooks from the corpus's pooled hour-to-hour
 * quantized cloud-cover delta distributions — same method as derive-freeze-delta-codebooks.ts.
 * The quantized cloud-cover step (0..7, 3-bit — see the cloud columns in v1.ts) is bounded, so the
 * full delta range -7..7 (15 symbols) fits directly in the alphabet — no escape/raw-payload
 * fallback needed. Low/mid/high clouds are derived SEPARATELY (not pooled): low clouds are
 * local/convective and change quickly, high clouds are broad cirrus sheets that persist for hours,
 * so a shared codebook would blur two genuinely different persistence regimes.
 *
 * Earlier versions of this script k-means clustered per-forecast delta histograms into 16 tables
 * per level, selected per message. Like freezing level and wind speed, that doesn't pay off: a
 * held-out check (split by location) found cheapest-of-16 with a 4-bit selector within 0.01
 * b/period of one shared table per level (low 1.688 vs 1.696, mid 1.826 vs 1.826, high 1.908 vs
 * 1.915) — a wash that doesn't justify 48 tables and three selectors.
 *
 * Tables land in packages/protocol/src/codebooks.gen.ts via `pnpm generate`; run standalone
 * (below) to derive and print without writing:
 *
 *   pnpm exec tsx packages/codec-server/scripts/derive-cloud-delta-codebooks.ts
 */
import { aggregateHourly, toFullPeriod, HOURS_PER_PERIOD } from "../src/forecast.ts";
import { VARS_BIT } from "@weather/protocol";
import {
  deriveCounts, tableOffsets, rowAt, rowCostBits, huffmanLengths, scaledWeights, runStandalone,
  type CellCounter, type DerivedTables,
} from "./derive-lib.ts";

const STEP_BITS = 3;               // matches the cloud column width in v1.ts (steps 0..7)
const STEP_MAX = (1 << STEP_BITS) - 1;
const NSYM = 2 * STEP_MAX + 1;     // 15: deltas -7..7, no escape needed (already bounded)
const RES_IDX = 4;                 // 1h — finest, most samples
const RAW_BITS = STEP_BITS;        // cost of the fixed-width fallback

const CLOUD_FIELDS = [
  { field: "cloud_low", bit: VARS_BIT.ccl, name: "CLOUD_LOW_DELTA_WEIGHTS" },
  { field: "cloud_mid", bit: VARS_BIT.ccm, name: "CLOUD_MID_DELTA_WEIGHTS" },
  { field: "cloud_high", bit: VARS_BIT.cch, name: "CLOUD_HIGH_DELTA_WEIGHTS" },
] as const;
const CLOUD_MASK = CLOUD_FIELDS.reduce((m, f) => m | (1 << f.bit), 0);

const quantCloud = (pct: number): number => Math.min(Math.max(Math.round(pct * 7 / 100), 0), STEP_MAX);
const deltaSym = (delta: number): number => delta + STEP_MAX; // -7..7 -> 0..14

export function counter(): CellCounter {
  const tables = CLOUD_FIELDS.map((f) => ({ name: f.field, dims: [NSYM] }));
  const { offsets, nSlots } = tableOffsets(tables);

  return {
    tables, nSlots,
    countCell(h, startHour, _pos, add) {
      const n = Math.min(128, Math.floor(h.time.length / HOURS_PER_PERIOD[RES_IDX]));
      const periods = aggregateHourly(h, h.time, n, RES_IDX, startHour).map((r) =>
        toFullPeriod(r, CLOUD_MASK, "US", RES_IDX));
      for (const { field } of CLOUD_FIELDS) {
        const base = offsets[field];
        for (let i = 1; i < periods.length; i++) {
          const prev = quantCloud((periods[i - 1] as any)[field] ?? 0);
          const cur = quantCloud((periods[i] as any)[field] ?? 0);
          add(base + deltaSym(cur - prev));
        }
      }
    },
    tablesFrom(counts): DerivedTables {
      const out: DerivedTables = {};
      for (const { field, name } of CLOUD_FIELDS)
        out[name] = scaledWeights(rowAt(counts, offsets[field], NSYM));
      return out;
    },
    costBits(counts) {
      const L = new Float64Array(nSlots);
      for (const { field } of CLOUD_FIELDS) {
        const c = rowCostBits(scaledWeights(rowAt(counts, offsets[field], NSYM)));
        for (let s = 0; s < NSYM; s++) L[offsets[field] + s] = c[s];
      }
      return L;
    },
  };
}

export async function derive(): Promise<DerivedTables> {
  const c = counter();
  const counts = await deriveCounts(c);
  const { offsets } = tableOffsets(c.tables);
  for (const { field, name } of CLOUD_FIELDS) {
    const row = rowAt(counts, offsets[field], NSYM);
    const total = row.reduce((a, b) => a + b, 0);
    const lens = huffmanLengths(scaledWeights(row));
    const meanBits = row.reduce((s, cnt, sym) => s + cnt * lens[sym], 0) / total;
    console.log(`${name}: delta samples = ${total}, mean bits/period (single table) = ${meanBits.toFixed(3)}  (raw = ${RAW_BITS})`);
  }
  return c.tablesFrom(counts);
}

runStandalone(import.meta.url, derive);
