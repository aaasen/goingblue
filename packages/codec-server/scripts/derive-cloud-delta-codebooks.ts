/**
 * Derive the cloud band's delta Huffman codebooks — ONE PER PRESSURE LEVEL, over the corpus's
 * pooled period-over-period quantized cover deltas at that level. Same method as
 * derive-freeze-delta-codebooks.ts. The quantized cover step (0..7, 3-bit — see the cloud band
 * column in v3.ts) is bounded, so the full delta range -7..7 (15 symbols) fits directly in the
 * alphabet — no escape/raw-payload fallback needed.
 *
 * WHAT IS COUNTED. The v3 wire carries coverage at each CLOUD_BAND_LEVELS_HPA level, and what
 * lands in those slots is not any raw upstream field: fillCloudBand (forecast.ts) recomputes each
 * level from `relative_humidity_XhPa` via Sundqvist, synthesizes low/mid cover from the model's
 * own layer cloud wherever the diagnostic reads empty, and folds the model's high-cloud integral
 * into the top slot. eachForecast applies exactly that correction before aggregation, so these
 * tables train on the stack production sends. Before 2026-08-19 they did not: the eight levels
 * were coded with the v2-era low/mid/high tables mapped on by altitude, trained on the trio —
 * native model layer cloud, a different variable with different persistence (the diagnostic's
 * rhCrit floor pins a level at exactly 0 for long runs; the trio does not).
 *
 * WHY PER LEVEL. Persistence is not constant with height, and three tables over eight levels put
 * 400 hPa (7 km, free troposphere) and 700 hPa (3 km, within reach of the boundary layer) on one
 * distribution. Each level now gets its own row; the row index IS the CLOUD_BAND_LEVELS_HPA
 * index, so v3.ts indexes the codec by level with no mapping table in between. The derive log
 * prints each level's mean bits/period beside what the old altitude mapping charged.
 *
 * THE RESOLUTION AXIS IS THE NEXT PIECE OF WORK, and it is not optional for long. These tables
 * are trained at 1h (RES_IDX below) and used at every resolution, which the trio tables were too —
 * but the trio's 1h deltas are flatter (72% zero) than the filled band's (82% zero), and that
 * accidental tail mass made them forgiving where deltas are large. Measured over the train corpus,
 * bits/period summed over the eight levels:
 *
 *                        24h     12h      6h      3h      1h
 *   retired trio       23.44   20.95   18.40   15.08   12.11
 *   per-level (here)   23.78   21.22   18.44   15.10   12.08
 *   per-level × res    22.56   20.45   18.16   14.99   12.08
 *
 * So these tables win at 1h and lose at 12h/24h (worst at 700 and 1000 hPa), which the benchmark
 * sees as cband +5.2% in Auto and +7.3% in Range against −2.0% in Detail. A [res][level] table set
 * beats the trio tables at every resolution and is what every other delta column in this codec
 * already does (v3.ts hands each column resTableIdx(periodHours) for free — the cloud band is the
 * only column that ignores it).
 *
 * Still true, and not re-litigated here: per-message k-means selection of cloud tables does not
 * pay. A held-out check (split by location) on the old trio found cheapest-of-16 with a 4-bit
 * selector within 0.01 b/period of one shared table per level (low 1.688 vs 1.696, mid 1.826 vs
 * 1.826, high 1.908 vs 1.915) — a wash that doesn't justify 48 tables and three selectors.
 * Conditioning stays the previous period's value at the same level; the vertical-neighbor chain
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
const RES_IDX = 4;                 // 1h — finest, most samples
const RAW_BITS = STEP_BITS;        // cost of the fixed-width fallback
const CLOUD_MASK = 1 << VARS_BIT.cch; // v3: the whole band rides this one bit

const deltaSym = (delta: number): number => delta + STEP_MAX; // -7..7 -> 0..14

// The retired mapping, kept only so derive() can price what the per-level tables replaced:
// 300 hPa read the high table, 400–700 the mid, 850–1000 the low (cloudBandCodec in v3.ts).
const LEGACY_GROUP = LEVELS.map((hpa) => (hpa <= 300 ? 2 : hpa <= 700 ? 1 : 0));

export function counter(): CellCounter {
  const tables = [{ name: "cloudBandDelta", dims: [NLEVEL, NSYM] }];
  const { nSlots } = tableOffsets(tables);
  const sum = (r: number[]) => r.reduce((a, b) => a + b, 0);

  // counts[level][sym], plus the pooled-over-levels marginal that backs an empty level row (a
  // center that served no cloud at one level for the whole corpus — never seen, but a zero row
  // would ship a uniform table rather than a sane one).
  const levelRows = (counts: ArrayLike<number>): { rows: number[][]; marginal: number[] } => {
    const rows = Array.from({ length: NLEVEL }, (_, li) => rowAt(counts, li * NSYM, NSYM));
    const marginal = new Array<number>(NSYM).fill(0);
    for (const row of rows) for (let s = 0; s < NSYM; s++) marginal[s] += row[s];
    return { rows, marginal };
  };

  return {
    tables, nSlots,
    countCell(ctx, add) {
      // Periods anchored to the request hour, aggregated once per cell and shared with every
      // other counter using this anchoring (precip, weathercode, both wind columns).
      const slice = ctx.atRequest(RES_IDX);
      if (!slice) return;
      // toFullPeriod fills cloud_band through repairCloudBand, so levels a center leaves empty
      // are bridged here exactly as they are on the wire.
      const periods = slice.rows.map((r) => toFullPeriod(r, CLOUD_MASK, "US"));
      for (let li = 0; li < NLEVEL; li++) {
        let prev = quantCover(periods[0].cloud_band?.[li]);
        for (let p = 1; p < periods.length; p++) {
          const cur = quantCover(periods[p].cloud_band?.[li]);
          add(li * NSYM + deltaSym(cur - prev));
          prev = cur;
        }
      }
    },
    tablesFrom(counts): DerivedTables {
      const { rows, marginal } = levelRows(counts);
      return {
        CLOUD_BAND_DELTA_WEIGHTS_BY_LEVEL:
          rows.map((row) => scaledWeights(sum(row) > 0 ? row : marginal)),
      };
    },
    costBits(counts) {
      const { rows, marginal } = levelRows(counts);
      const L = new Float64Array(nSlots);
      rows.forEach((row, li) => {
        const c = rowCostBits(scaledWeights(sum(row) > 0 ? row : marginal));
        for (let s = 0; s < NSYM; s++) L[li * NSYM + s] = c[s];
      });
      return L;
    },
  };
}

export async function derive(precounted?: Float64Array): Promise<DerivedTables> {
  const c = counter();
  const counts = precounted ?? await deriveCounts(c);
  const sum = (r: number[]) => r.reduce((a, b) => a + b, 0);
  const rows = Array.from({ length: NLEVEL }, (_, li) => rowAt(counts, li * NSYM, NSYM));

  // What the retired altitude mapping would have charged: the three grouped tables it pooled
  // these levels into, priced on each level's own deltas. Training-set numbers on both sides,
  // so the comparison is like for like.
  const legacy = [0, 1, 2].map((g) => {
    const pooled = new Array<number>(NSYM).fill(0);
    rows.forEach((row, li) => {
      if (LEGACY_GROUP[li] === g) for (let s = 0; s < NSYM; s++) pooled[s] += row[s];
    });
    return sum(pooled) > 0 ? huffmanLengths(scaledWeights(pooled)) : null;
  });

  console.log(`  CLOUD_BAND_DELTA_WEIGHTS_BY_LEVEL — mean bits/period, training set (raw = ${RAW_BITS})`);
  for (let li = 0; li < NLEVEL; li++) {
    const row = rows[li];
    const n = Math.max(1, sum(row));
    const own = huffmanLengths(scaledWeights(row));
    const was = legacy[LEGACY_GROUP[li]];
    const mean = row.reduce((s, cnt, sym) => s + cnt * own[sym], 0) / n;
    const wasMean = was ? row.reduce((s, cnt, sym) => s + cnt * was[sym], 0) / n : NaN;
    console.log(`    ${String(LEVELS[li]).padStart(4)} hPa: n=${sum(row)} ` +
      `mean=${mean.toFixed(3)} (altitude-mapped ${wasMean.toFixed(3)})`);
  }
  return c.tablesFrom(counts);
}

runStandalone(import.meta.url, derive);
