/**
 * Derive the cloud band's delta Huffman codebooks — ONE PER (RESOLUTION, PRESSURE LEVEL), over
 * the corpus's period-over-period quantized cover deltas at that level and span. Same method as
 * derive-freeze-delta-codebooks.ts. The quantized cover step (0..7, 3-bit — see the cloud band
 * column in v3.ts) is bounded, so the full delta range -7..7 (15 symbols) fits directly in the
 * alphabet — no escape/raw-payload fallback needed.
 *
 * WHAT IS COUNTED. The v3 wire carries coverage at each CLOUD_BAND_LEVELS_HPA level, and what
 * lands in those slots is not any raw upstream field: fillCloudBand (forecast.ts) recomputes each
 * level from `relative_humidity_XhPa` via Sundqvist, synthesizes low/mid cover from the model's
 * own layer cloud wherever the diagnostic reads empty, and folds the model's high-cloud integral
 * into the top slot. toFullPeriod applies exactly that correction before aggregation, so these
 * tables train on the stack production sends.
 *
 * WHY PER LEVEL. Persistence is not constant with height, and three tables over eight levels put
 * 400 hPa (7 km, free troposphere) and 700 hPa (3 km, within reach of the boundary layer) on one
 * distribution. Each level gets its own row; the level index IS the CLOUD_BAND_LEVELS_HPA index,
 * so v3.ts indexes the codec by level with no mapping table in between.
 *
 * WHY PER RESOLUTION. A period's band is the per-level MAX over the hours it spans, so span
 * changes the delta distribution wholesale (1h deltas are 82% zero; 24h nowhere near). The
 * level-only predecessor was trained at 1h and used everywhere; measured over the train corpus,
 * bits/period summed over the eight levels:
 *
 *                        24h     12h      6h      3h      1h
 *   retired trio       23.44   20.95   18.40   15.08   12.11
 *   per-level only     23.78   21.22   18.44   15.10   12.08
 *   per-level × res    22.56   20.45   18.16   14.99   12.08
 *
 * [res][level] wins or ties everywhere, and is what every other delta column in this codec
 * already does (v3.ts hands each column resTableIdx(periodHours) for free). NOTE the wire now
 * clamps band symbols to periods at ≤3h resolution (cloudBandPeriodCount in v3.ts), so only the
 * 3h and 1h rows ever serve; the coarser rows are trained anyway to keep the [res][level][sym]
 * shape uniform with the other resolution-keyed tables — the same reason freeze keeps its dead
 * 24h row. The elevation clamp (cloudBandLevelCount) likewise means summit messages skip their
 * sub-ground levels; training still counts every level at every site — the low-level tables are
 * dominated by the low-country sites that actually send them.
 *
 * Still true, and not re-litigated here: per-message k-means selection of cloud tables does not
 * pay. A held-out check (split by location) on the old trio found cheapest-of-16 with a 4-bit
 * selector within 0.01 b/period of one shared table per level (low 1.688 vs 1.696, mid 1.826 vs
 * 1.826, high 1.908 vs 1.915) — a wash that doesn't justify 48 tables and three selectors.
 * Conditioning stays (resolution, previous value at the same level); the vertical-neighbor chain
 * (level l keyed on level l-1's delta) is a later derive.
 *
 * Tables land in packages/protocol/src/codebooks.gen.ts via `pnpm generate`; run standalone
 * (below) to derive and print without writing:
 *
 *   pnpm exec tsx packages/codec-server/scripts/derive-cloud-delta-codebooks.ts
 */
import { toFullPeriod } from "../src/forecast.ts";
import { CLOUD_BAND_LEVELS_HPA, VARS_BIT, quantCover } from "@weather/protocol";
import {
  deriveCounts, tableOffsets, rowAt, rowCostBits, huffmanLengths, scaledWeights, runStandalone,
  type CellCounter, type DerivedTables,
} from "./derive-lib.ts";

const LEVELS = CLOUD_BAND_LEVELS_HPA;
const NLEVEL = LEVELS.length;      // 8, highest first (300 hPa … 1000 hPa)
const STEP_BITS = 3;               // matches the cloud band column width in v3.ts (steps 0..7)
const STEP_MAX = (1 << STEP_BITS) - 1;
const NSYM = 2 * STEP_MAX + 1;     // 15: deltas -7..7, no escape needed (already bounded)
const NRES = 5;                    // 24h/12h/6h/3h/1h — only 3h/1h serve post-clamp (see header)
const RAW_BITS = STEP_BITS;        // cost of the fixed-width fallback
const CLOUD_MASK = 1 << VARS_BIT.cch; // v3: the whole band rides this one bit

const deltaSym = (delta: number): number => delta + STEP_MAX; // -7..7 -> 0..14

export function counter(): CellCounter {
  const tables = [{ name: "cloudBandDelta", dims: [NRES, NLEVEL, NSYM] }];
  const { nSlots } = tableOffsets(tables);
  const sum = (r: number[]) => r.reduce((a, b) => a + b, 0);

  // counts[res][level][sym], plus each LEVEL's pooled-over-res marginal to back an empty
  // (res, level) row — level identity dominates the delta shape (see header), so a sparse
  // coarse-res row borrows from its own level, never from its neighbors.
  const resRows = (counts: ArrayLike<number>): { rows: number[][][]; levelMarginal: number[][] } => {
    const rows = Array.from({ length: NRES }, (_, res) =>
      Array.from({ length: NLEVEL }, (_, li) => rowAt(counts, (res * NLEVEL + li) * NSYM, NSYM)));
    const levelMarginal = Array.from({ length: NLEVEL }, (_, li) => {
      const m = new Array<number>(NSYM).fill(0);
      for (let res = 0; res < NRES; res++)
        for (let s = 0; s < NSYM; s++) m[s] += rows[res][li][s];
      return m;
    });
    return { rows, levelMarginal };
  };

  return {
    tables, nSlots,
    countCell(ctx, add) {
      for (let res = 0; res < NRES; res++) {
        // Periods anchored to the cell's first local midnight, aggregated once per cell and
        // shared with every other counter that wants this anchoring — the alignment layoutFor
        // produces, so training mirrors the wire's period boundaries.
        const slice = ctx.atMidnight(res);
        if (!slice) continue;
        // toFullPeriod fills cloud_band through repairCloudBand, so levels a center leaves
        // empty are bridged here exactly as they are on the wire.
        const periods = slice.rows.map((r) => toFullPeriod(r, CLOUD_MASK, "US"));
        for (let li = 0; li < NLEVEL; li++) {
          let prev = quantCover(periods[0].cloud_band?.[li]);
          for (let p = 1; p < periods.length; p++) {
            const cur = quantCover(periods[p].cloud_band?.[li]);
            add((res * NLEVEL + li) * NSYM + deltaSym(cur - prev));
            prev = cur;
          }
        }
      }
    },
    tablesFrom(counts): DerivedTables {
      const { rows, levelMarginal } = resRows(counts);
      return {
        CLOUD_BAND_DELTA_WEIGHTS_BY_RES_LEVEL: rows.map((byLevel, res) =>
          byLevel.map((row, li) => scaledWeights(sum(row) > 0 ? row : levelMarginal[li]))),
      };
    },
    costBits(counts) {
      const { rows, levelMarginal } = resRows(counts);
      const L = new Float64Array(nSlots);
      rows.forEach((byLevel, res) => byLevel.forEach((row, li) => {
        const c = rowCostBits(scaledWeights(sum(row) > 0 ? row : levelMarginal[li]));
        for (let s = 0; s < NSYM; s++) L[(res * NLEVEL + li) * NSYM + s] = c[s];
      }));
      return L;
    },
  };
}

export async function derive(precounted?: Float64Array): Promise<DerivedTables> {
  const c = counter();
  const counts = precounted ?? await deriveCounts(c);
  const sum = (r: number[]) => r.reduce((a, b) => a + b, 0);
  const rows = Array.from({ length: NRES }, (_, res) =>
    Array.from({ length: NLEVEL }, (_, li) => rowAt(counts, (res * NLEVEL + li) * NSYM, NSYM)));

  // Training-set mean bits/period per resolution, summed over the levels, beside what a
  // res-less per-level table (the pooled-over-res marginal) would have charged — the shipped
  // predecessor, so the delta is what the res axis buys.
  console.log(`  CLOUD_BAND_DELTA_WEIGHTS_BY_RES_LEVEL — mean bits/period over the 8 levels, training set (raw = ${8 * RAW_BITS})`);
  for (let res = 0; res < NRES; res++) {
    let bits = 0, resless = 0, n = 0;
    for (let li = 0; li < NLEVEL; li++) {
      const row = rows[res][li];
      const pooled = new Array<number>(NSYM).fill(0);
      for (let r = 0; r < NRES; r++) for (let s = 0; s < NSYM; s++) pooled[s] += rows[r][li][s];
      const own = huffmanLengths(scaledWeights(sum(row) > 0 ? row : pooled));
      const was = huffmanLengths(scaledWeights(pooled));
      bits += row.reduce((s, cnt, sym) => s + cnt * own[sym], 0);
      resless += row.reduce((s, cnt, sym) => s + cnt * was[sym], 0);
      n = Math.max(n, sum(row));
    }
    const label = ["24h", "12h", "6h", "3h", "1h"][res];
    const served = res >= 3 ? "" : "  (dead post-clamp, kept for shape)";
    console.log(`    ${label.padStart(3)}: n=${n} mean=${(bits / Math.max(1, n)).toFixed(2)}` +
      ` (per-level-only ${(resless / Math.max(1, n)).toFixed(2)})${served}`);
  }
  return c.tablesFrom(counts);
}

runStandalone(import.meta.url, derive);
