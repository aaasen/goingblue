/**
 * Derive the cloud band's codebooks — ORDER-1 VALUE CODING, one table per (PRESSURE LEVEL,
 * PREVIOUS VALUE): the quantized cover step (0..7, 3-bit — see the cloud band column in wire.ts)
 * keyed by the level's own previous decoded step. The same model the precip/snow/rain columns
 * ship, and measured to be the band's dominant context: the RH-diagnostic fill pins levels at
 * exactly 0 for long runs (rhCrit floor), so "was clear" reshapes the whole next-step
 * distribution. Held-out (5-fold by location, analyze-cloud-neighbor-heldout.ts, 2026-08-20):
 * per-level pooled deltas 10.59 → per-level × prev exact 7.74 b/period over the 8 levels
 * (−27%); the vertical-neighbor delta added only −0.19 on top and was left out; res keying
 * added ~nothing (−0.09) at the resolutions that serve.
 *
 * ONLY THE SERVING RESOLUTIONS ARE TRAINED. The wire clamps band symbols to periods at ≤3h
 * resolution (cloudBandPeriodCount / CLOUD_BAND_MAX_HOURS in wire.ts), so 3h and 1h are the only
 * spans a table will ever price — both are counted, pooled (the held-out scan put the res split
 * within noise of the pool). The level clamp (cloudBandLevelCount) means summit messages skip
 * their sub-ground levels; training still counts every level at every site — the low-level
 * tables are dominated by the low-country sites that actually send them.
 *
 * WHAT IS COUNTED. The wire carries coverage at each CLOUD_BAND_LEVELS_HPA level, and what
 * lands in those slots is not any raw upstream field: fillCloudBand (forecast.ts) recomputes
 * each level from `relative_humidity_XhPa` via Sundqvist, synthesizes low/mid cover from the
 * model's own layer cloud wherever the diagnostic reads empty, and folds the model's high-cloud
 * integral into the top slot. toFullPeriod applies exactly that correction before aggregation,
 * so these tables train on the stack production sends.
 *
 * Each model's first period stays a raw 3-bit anchor on the wire (not counted here); the tables
 * price transitions only. The level index IS the CLOUD_BAND_LEVELS_HPA index and the prev index
 * IS the previous quantized step, so wire.ts indexes the books with no mapping in between.
 *
 * Tables land in packages/protocol/src/codebooks.gen.ts via `pnpm generate`; run standalone
 * (below) to derive and print without writing:
 *
 *   pnpm exec tsx packages/codec-server/scripts/derive-cloud-delta-codebooks.ts
 */
import { toFullPeriod } from "../src/forecast.ts";
import {
  CLOUD_BAND_LEVELS_HPA, VARS_BIT, quantCover,
  RESOLUTION_HOURS, TABLE_RES_IDXS, CLOUD_BAND_MAX_HOURS,
} from "@weather/protocol";
import {
  deriveCounts, tableOffsets, rowAt, rowCostBits, huffmanLengths, scaledWeights, runStandalone,
  type CellCounter, type DerivedTables,
} from "./derive-lib.ts";

const LEVELS = CLOUD_BAND_LEVELS_HPA;
const NLEVEL = LEVELS.length;      // 8, highest first (300 hPa … 1000 hPa)
const STEP_BITS = 3;               // matches the cloud band column width in wire.ts (steps 0..7)
const NSYM = 1 << STEP_BITS;       // 8 value symbols
const NPREV = NSYM;                // keyed by the previous step, exact
// The spans the band actually rides — derived from the wire's own clamp so the two can't drift.
const SERVING_RES_IDXS = TABLE_RES_IDXS.filter((r) => RESOLUTION_HOURS[r] <= CLOUD_BAND_MAX_HOURS);
const CLOUD_MASK = 1 << VARS_BIT.cch; // the whole band rides this one bit

export function counter(): CellCounter {
  const tables = [{ name: "cloudBand", dims: [NLEVEL, NPREV, NSYM] }];
  const { nSlots } = tableOffsets(tables);
  const sum = (r: number[]) => r.reduce((a, b) => a + b, 0);

  // counts[level][prev][sym], plus each LEVEL's pooled-over-prev marginal to back an empty
  // (level, prev) row — a thin context degrades to the level's own distribution, never a
  // neighbor's.
  const levelRows = (counts: ArrayLike<number>): { rows: number[][][]; marginal: number[][] } => {
    const rows = Array.from({ length: NLEVEL }, (_, li) =>
      Array.from({ length: NPREV }, (_, prev) => rowAt(counts, (li * NPREV + prev) * NSYM, NSYM)));
    const marginal = rows.map((byPrev) => {
      const m = new Array<number>(NSYM).fill(0);
      for (const row of byPrev) for (let s = 0; s < NSYM; s++) m[s] += row[s];
      return m;
    });
    return { rows, marginal };
  };

  return {
    tables, nSlots,
    countCell(ctx, add) {
      for (const res of SERVING_RES_IDXS) {
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
            add((li * NPREV + prev) * NSYM + cur);
            prev = cur;
          }
        }
      }
    },
    tablesFrom(counts): DerivedTables {
      const { rows, marginal } = levelRows(counts);
      return {
        CLOUD_BAND_WEIGHTS_BY_LEVEL_PREV: rows.map((byPrev, li) =>
          byPrev.map((row) => scaledWeights(sum(row) > 0 ? row : marginal[li]))),
      };
    },
    costBits(counts) {
      const { rows, marginal } = levelRows(counts);
      const L = new Float64Array(nSlots);
      rows.forEach((byPrev, li) => byPrev.forEach((row, prev) => {
        const c = rowCostBits(scaledWeights(sum(row) > 0 ? row : marginal[li]));
        for (let s = 0; s < NSYM; s++) L[(li * NPREV + prev) * NSYM + s] = c[s];
      }));
      return L;
    },
  };
}

export async function derive(precounted?: Float64Array): Promise<DerivedTables> {
  const c = counter();
  const counts = precounted ?? await deriveCounts(c);
  const sum = (r: number[]) => r.reduce((a, b) => a + b, 0);

  // Training-set mean bits/period per level under the prev-keyed tables, beside the level's
  // unconditioned (order-0 value) table — the delta is what the order-1 context buys.
  console.log(`  CLOUD_BAND_WEIGHTS_BY_LEVEL_PREV — mean bits/period, training set, ${SERVING_RES_IDXS.map((r) => `${RESOLUTION_HOURS[r]}h`).join("+")} pooled (raw = ${STEP_BITS})`);
  let total = 0, flatTotal = 0, totalN = 0;
  for (let li = 0; li < NLEVEL; li++) {
    const byPrev = Array.from({ length: NPREV }, (_, prev) =>
      rowAt(counts, (li * NPREV + prev) * NSYM, NSYM));
    const marginal = new Array<number>(NSYM).fill(0);
    for (const row of byPrev) for (let s = 0; s < NSYM; s++) marginal[s] += row[s];
    const flat = huffmanLengths(scaledWeights(marginal));
    let bits = 0, flatBits = 0;
    for (const row of byPrev) {
      if (sum(row) === 0) continue;
      const own = huffmanLengths(scaledWeights(row));
      bits += row.reduce((s, cnt, sym) => s + cnt * own[sym], 0);
      flatBits += row.reduce((s, cnt, sym) => s + cnt * flat[sym], 0);
    }
    const n = Math.max(1, sum(marginal));
    total += bits; flatTotal += flatBits; totalN = Math.max(totalN, n);
    console.log(`    ${String(LEVELS[li]).padStart(4)} hPa: n=${sum(marginal)} ` +
      `mean=${(bits / n).toFixed(3)} (order-0 ${(flatBits / n).toFixed(3)})`);
  }
  console.log(`    band total: ${(total / Math.max(1, totalN)).toFixed(2)} b/period ` +
    `(order-0 ${(flatTotal / Math.max(1, totalN)).toFixed(2)})`);
  return c.tablesFrom(counts);
}

runStandalone(import.meta.url, derive);
