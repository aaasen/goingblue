/**
 * Derive temperature-delta codebooks keyed by (resolution, previous-delta bucket, time-of-day
 * bucket) — context both sides already have, so none of it costs wire bits. This replaced the
 * cheapest-of-16 k-means tables + 4-bit per-message selector: the selector was mostly
 * re-discovering resolution (which is free), and the held-out ladder (5-fold by location, see
 * analyze-temp-heldout.ts) found
 *
 *   shipped ×16 + selector 2.648 b/period
 *   res only               2.678
 *   tod8 × res             2.388
 *   prevΔ × tod8 × res     2.335   ← shipped (prevΔ's ~0.05 was sign-consistent in all 5 folds)
 *
 * Alphabet: deltas -7..7 (indices 0..14) + ESCAPE (15) followed by a raw 6-bit signed field.
 * Contexts: 5 prevΔ buckets (tempDeltaBucket) × 8 uniform 3h time-of-day buckets of the arriving
 * period's local midpoint (tempTodBucket) per resolution row, plus one pooled bootstrap table
 * for a column's first delta (no predecessor). Both context functions are imported from the
 * protocol package so derivation and wire can't drift.
 *
 * Training mirrors the wire exactly: local-midnight-aligned uniform windows per resolution (the
 * alignment layoutFor produces), representativeTemps sampling, 1 °C quantization, clamp-to-±32
 * deltas diffed against the reconstruction. The 24h row (resolution index 0) is trained too even
 * though fill layouts never emit 24h periods — it keeps the [res][ctx][sym] shape uniform with
 * the other resolution-keyed tables.
 *
 * Tables land in packages/protocol/src/codebooks.gen.ts via `pnpm generate`; run standalone
 * (below) to derive and print without writing:
 *
 *   pnpm exec tsx packages/codec-server/scripts/derive-temp-delta-codebooks.ts
 */
import { rowsFromWindows, HOURS_PER_PERIOD } from "../src/forecast.ts";
import {
  tempDeltaBucket, tempTodBucket, TEMP_DELTA_PREV_BUCKETS, TEMP_DELTA_TOD_BUCKETS,
  TEMP_DELTA_CORE_RADIUS, TEMP_DELTA_MIN, TEMP_DELTA_MAX, TEMP_DELTA_ESCAPE_BITS,
} from "@weather/protocol";
import {
  deriveCounts, tableOffsets, rowAt, rowCostBits, scaledWeights, runStandalone,
  type CellCounter, type DerivedTables,
} from "./derive-lib.ts";

const NSYM = 2 * TEMP_DELTA_CORE_RADIUS + 2; // 16: 15 core + escape
const ESCAPE_SYM = NSYM - 1;
const NRES = 5; // 24h/12h/6h/3h/1h — row 0 (24h) is dead in fill layouts but kept for shape
const NCTX = TEMP_DELTA_PREV_BUCKETS * TEMP_DELTA_TOD_BUCKETS; // 40

const deltaSym = (d: number) => (Math.abs(d) <= TEMP_DELTA_CORE_RADIUS ? d + TEMP_DELTA_CORE_RADIUS : ESCAPE_SYM);

export function counter(): CellCounter {
  const tables = [
    { name: "tempDeltaBootstrap", dims: [NSYM] },
    { name: "tempDelta", dims: [NRES, NCTX, NSYM] },
  ];
  const { offsets, nSlots } = tableOffsets(tables);
  const BOOT = offsets.tempDeltaBootstrap, MAIN = offsets.tempDelta;

  // The (res × ctx) marginal fallback for structurally empty contexts (a 12h period's midpoint
  // only ever lands in two tod buckets), mirrored by tablesFrom and costBits.
  const resRows = (counts: ArrayLike<number>): { rows: number[][]; marginal: number[] }[] =>
    Array.from({ length: NRES }, (_, res) => {
      const rows = Array.from({ length: NCTX }, (_, ctx) =>
        rowAt(counts, MAIN + (res * NCTX + ctx) * NSYM, NSYM));
      const marginal = new Array<number>(NSYM).fill(0);
      for (const row of rows) for (let s = 0; s < NSYM; s++) marginal[s] += row[s];
      return { rows, marginal };
    });
  const sum = (r: number[]) => r.reduce((a, b) => a + b, 0);

  return {
    tables, nSlots,
    countCell(h, _startHour, pos, add) {
      if (!pos || !h.time?.length || !h.temperature_2m) return;
      const off = Math.round(pos.lon / 15);
      const dataStart = Math.floor(Date.parse(`${h.time[0]}:00Z`) / 3600000);
      const dataEnd = dataStart + h.time.length;
      for (let res = 0; res < NRES; res++) {
        const hpp = HOURS_PER_PERIOD[res];
        const firstUtc = Math.ceil((dataStart + off) / 24) * 24 - off; // first local midnight
        const n = Math.floor((dataEnd - firstUtc) / hpp);
        if (n < 3) continue;
        const windows: number[][] = [];
        for (let p = 0; p < n; p++) {
          const w: number[] = [];
          for (let eh = firstUtc + p * hpp; eh < firstUtc + (p + 1) * hpp; eh++) w.push(eh - dataStart);
          windows.push(w);
        }
        const rows = rowsFromWindows(h, h.time, windows, off);
        if (rows.some((r) => r.temp_c == null)) continue;
        const q = rows.map((r) => Math.min(Math.max(Math.round(r.temp_c! + 100), 0), 255));

        let recon = q[0];
        let prevDelta: number | null = null;
        for (let p = 1; p < n; p++) {
          const delta = Math.min(Math.max(q[p] - recon, TEMP_DELTA_MIN), TEMP_DELTA_MAX);
          recon += delta;
          const sym = deltaSym(delta);
          if (prevDelta === null) add(BOOT + sym);
          else {
            const tod = tempTodBucket((firstUtc + p * hpp) * 2 + hpp + off * 2);
            add(MAIN + (res * NCTX + tempDeltaBucket(prevDelta) * TEMP_DELTA_TOD_BUCKETS + tod) * NSYM + sym);
          }
          prevDelta = delta;
        }
      }
    },
    tablesFrom(counts): DerivedTables {
      return {
        TEMP_DELTA_BOOTSTRAP_WEIGHTS: scaledWeights(rowAt(counts, BOOT, NSYM)),
        TEMP_DELTA_WEIGHTS_BY_RES: resRows(counts).map(({ rows, marginal }) =>
          rows.map((row) => scaledWeights(sum(row) > 0 ? row : marginal))),
      };
    },
    costBits(counts) {
      const L = new Float64Array(nSlots);
      const put = (start: number, row: number[]) => {
        const c = rowCostBits(scaledWeights(row));
        for (let s = 0; s < NSYM; s++) L[start + s] = c[s] + (s === ESCAPE_SYM ? TEMP_DELTA_ESCAPE_BITS : 0);
      };
      put(BOOT, rowAt(counts, BOOT, NSYM));
      resRows(counts).forEach(({ rows, marginal }, res) =>
        rows.forEach((row, ctx) => put(MAIN + (res * NCTX + ctx) * NSYM, sum(row) > 0 ? row : marginal)));
      return L;
    },
  };
}

export async function derive(): Promise<DerivedTables> {
  const c = counter();
  const counts = await deriveCounts(c);
  // Training-set mean bits/period per resolution, for the generation log (held-out numbers are
  // the ladder's job).
  const L = c.costBits(counts);
  const { offsets } = tableOffsets(c.tables);
  for (let res = 0; res < NRES; res++) {
    let bits = 0, n = 0;
    for (let i = 0; i < NCTX * NSYM; i++) {
      const slot = offsets.tempDelta + res * NCTX * NSYM + i;
      bits += counts[slot] * L[slot];
      n += counts[slot];
    }
    const label = ["24h", "12h", "6h", "3h", "1h"][res];
    console.log(`  ${label}: n=${n} mean=${(bits / Math.max(1, n)).toFixed(3)} b/period (training-set)`);
  }
  return c.tablesFrom(counts);
}

runStandalone(import.meta.url, derive);
