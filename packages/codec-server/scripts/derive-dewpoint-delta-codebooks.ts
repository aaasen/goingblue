/**
 * Derive dewpoint-delta codebooks keyed by (resolution, SAME-period temp delta, PREVIOUS
 * period's depression) — see the dewpoint section of entropy.ts for the contexts and the
 * held-out ladder behind them (analyze-dewpoint-entropy.ts). Both contexts are free: temp
 * decodes first, and the depression is the difference of two reconstructions the decoder holds.
 *
 * Training mirrors the wire exactly: local-midnight-aligned uniform windows per resolution, the
 * dewpoint sampled at the temp's hour (rowsFromWindows), 1 °C quantization, both chains clamped
 * and diffed against their reconstructions, the temp alphabet's escape charged its raw bits.
 * Only the resolutions layouts emit are trained — TABLE_RES_IDXS (12h/6h/3h/1h) in table-row
 * order, the same mapping resTableIdx applies at the codec.
 *
 * Tables land in packages/protocol/src/codebooks.gen.ts via `pnpm generate`; run standalone
 * (below) to derive and print without writing:
 *
 *   pnpm exec tsx packages/codec-server/scripts/derive-dewpoint-delta-codebooks.ts
 */
import { toFullPeriod } from "../src/forecast.ts";
import {
  VAR, type Variable, TEMP_DELTA_MIN, TEMP_DELTA_MAX, TEMP_DELTA_CORE_RADIUS, TEMP_DELTA_ESCAPE_BITS,
  DEWPOINT_TEMP_CTX, dewpointTempCtx, DEWPOINT_DEPRESSION_BUCKETS, dewpointDepressionBucket,
  TABLE_RES_IDXS,
} from "@weather/protocol";
import {
  deriveCounts, tableOffsets, rowAt, rowCostBits, scaledWeights, runStandalone,
  type CellCounter, type DerivedTables,
} from "./derive-lib.ts";

const NSYM = 2 * TEMP_DELTA_CORE_RADIUS + 2; // 15 core + escape
const ESCAPE_SYM = NSYM - 1;
const NRES = TABLE_RES_IDXS.length;
const NCTX = DEWPOINT_TEMP_CTX * DEWPOINT_DEPRESSION_BUCKETS; // 75 rows per resolution
const DEWPOINT_VARS: ReadonlySet<Variable> = new Set([VAR.temp, VAR.dewpoint]);

// Same quantizer as wire.ts quantTemp (8-bit, -100 °C offset), for both chains.
const quant = (c: number): number => Math.min(Math.max(Math.round(c + 100), 0), 255);
const deltaSym = (d: number): number => (Math.abs(d) <= TEMP_DELTA_CORE_RADIUS ? d + TEMP_DELTA_CORE_RADIUS : ESCAPE_SYM);
const clampDelta = (d: number): number => Math.min(Math.max(d, TEMP_DELTA_MIN), TEMP_DELTA_MAX);
const ctxOf = (tempDelta: number, prevDepression: number): number =>
  dewpointTempCtx(tempDelta) * DEWPOINT_DEPRESSION_BUCKETS + dewpointDepressionBucket(prevDepression);

export function counter(): CellCounter {
  const tables = [{ name: "dewpointDelta", dims: [NRES, NCTX, NSYM] }];
  const { nSlots } = tableOffsets(tables);
  const sum = (r: number[]) => r.reduce((a, b) => a + b, 0);

  // counts[res][ctx][sym]. An empty context row falls back to its temp-delta marginal (the five
  // depression bands pooled), then to the resolution marginal — the corners (a ±7 temp step at
  // zero depression, 1h) are the thin ones.
  const resRows = (counts: ArrayLike<number>) =>
    Array.from({ length: NRES }, (_, res) => {
      const rows = Array.from({ length: NCTX }, (_, k) => rowAt(counts, (res * NCTX + k) * NSYM, NSYM));
      const marginal = new Array<number>(NSYM).fill(0);
      const byTemp = Array.from({ length: DEWPOINT_TEMP_CTX }, () => new Array<number>(NSYM).fill(0));
      rows.forEach((row, k) => {
        const t = Math.floor(k / DEWPOINT_DEPRESSION_BUCKETS);
        for (let s = 0; s < NSYM; s++) { marginal[s] += row[s]; byTemp[t][s] += row[s]; }
      });
      const shipped = rows.map((row, k) => {
        if (sum(row) > 0) return row;
        const t = byTemp[Math.floor(k / DEWPOINT_DEPRESSION_BUCKETS)];
        return sum(t) > 0 ? t : marginal;
      });
      return { rows, shipped, marginal };
    });

  return {
    tables, nSlots,
    countCell(ctx, add) {
      const { hourly: h, pos } = ctx;
      if (!pos || !h.time?.length || !h.dew_point_2m) return;
      for (let res = 0; res < NRES; res++) {
        const slice = ctx.atMidnight(TABLE_RES_IDXS[res]);
        if (!slice) continue;
        const periods = slice.rows.map((r) => toFullPeriod(r, DEWPOINT_VARS, "US"));
        let tempRecon = quant(periods[0].temp_c ?? 0);
        // Anchor: the depression against the temp anchor, clamped to the 6-bit field like the wire.
        let dewRecon = tempRecon - Math.min(Math.max(tempRecon - quant(periods[0].dewpoint_c ?? 0), 0), 63);
        for (let p = 1; p < slice.n; p++) {
          const tempDelta = clampDelta(quant(periods[p].temp_c ?? 0) - tempRecon);
          const prevDepression = tempRecon - dewRecon;
          tempRecon += tempDelta;
          const dewDelta = clampDelta(quant(periods[p].dewpoint_c ?? 0) - dewRecon);
          add((res * NCTX + ctxOf(tempDelta, prevDepression)) * NSYM + deltaSym(dewDelta));
          dewRecon += dewDelta;
        }
      }
    },
    tablesFrom(counts): DerivedTables {
      return {
        DEWPOINT_DELTA_WEIGHTS_BY_RES: resRows(counts).map(({ shipped }) => shipped.map(scaledWeights)),
      };
    },
    costBits(counts) {
      const L = new Float64Array(nSlots);
      resRows(counts).forEach(({ shipped }, res) =>
        shipped.forEach((row, k) => {
          const c = rowCostBits(scaledWeights(row));
          for (let s = 0; s < NSYM; s++) L[(res * NCTX + k) * NSYM + s] = c[s] + (s === ESCAPE_SYM ? TEMP_DELTA_ESCAPE_BITS : 0);
        }));
      return L;
    },
  };
}

export async function derive(precounted?: Float64Array): Promise<DerivedTables> {
  const c = counter();
  const counts = precounted ?? await deriveCounts(c);
  const cost = c.costBits(counts);
  for (let res = 0; res < NRES; res++) {
    let n = 0, bits = 0, flatBits = 0;
    const marginal = new Array<number>(NSYM).fill(0);
    for (let k = 0; k < NCTX; k++) for (let s = 0; s < NSYM; s++) marginal[s] += counts[(res * NCTX + k) * NSYM + s];
    const flat = rowCostBits(scaledWeights(marginal));
    for (let k = 0; k < NCTX; k++) for (let s = 0; s < NSYM; s++) {
      const m = counts[(res * NCTX + k) * NSYM + s];
      if (!m) continue;
      n += m; bits += m * cost[(res * NCTX + k) * NSYM + s];
      flatBits += m * (flat[s] + (s === ESCAPE_SYM ? TEMP_DELTA_ESCAPE_BITS : 0));
    }
    const label = ["12h", "6h", "3h", "1h"][res];
    console.log(`  ${label}: n=${n} mean=${(bits / Math.max(1, n)).toFixed(3)} b/period` +
      ` (res-only ${(flatBits / Math.max(1, n)).toFixed(3)}, training-set)`);
  }
  return c.tablesFrom(counts);
}

runStandalone(import.meta.url, derive);
