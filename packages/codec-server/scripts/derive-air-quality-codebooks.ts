/**
 * Derive the air-quality codebooks: five columns over two index scales (see the AQI ladders in
 * the protocol's entropy.ts), all trained from the `cams` corpus source, which shares the weather
 * lattice cell-for-cell (derive-lib.ts EXTRA_SOURCE_VARS does the join).
 *
 * Each column's conditioning was chosen from the corpus, not assumed (3h periods, maxOf, held-out
 * numbers printed by the ladder below):
 *
 *   US PM2.5 sub-index   delta | res, prevΔ            1.00 b/period  (1.05 unconditioned)
 *   US ozone sub-index   delta | res, tod8, prevΔ      1.48           (1.99 unconditioned)
 *   US headline          residual vs max(pm25, o3)     0.15           (98.5% exactly zero)
 *                        delta | res, tod8, prevΔ      1.27           (when a sub-index is absent)
 *   European headline    delta | res, tod8, prevΔ      1.64           (1.92 unconditioned)
 *   European PM2.5       delta | res, prevΔ            0.89           (0.95 unconditioned)
 *
 * Why those shapes:
 *
 * - OZONE IS DIURNAL (it is photochemical), so it wants the temp column's res × tod8 × prevΔ
 *   ladder. Conditioning it on the same period's PM2.5 delta instead bought 0.004 b/period —
 *   different chemistry, no shared signal — and was rejected.
 * - THE US HEADLINE IS max(pm25, o3) 98.5% of the time once quantized, so when both sub-index
 *   columns are already on the wire it codes as a residual against their max and costs a rounding
 *   error. That only works against BOTH: measured against one alone the residual costs 2.21
 *   (PM2.5) / 2.72 (ozone), worse than just coding the headline's own deltas. Hence two table
 *   sets and a context-availability switch, the same shape freezeDeltaBook (temp present/absent)
 *   and sfcSpeedBook (gust present/absent) already use.
 * - THE EUROPEAN COLUMNS DON'T COMPRESS AGAINST THE US ONES. The EU headline conditioned on the
 *   US delta costs 1.79, value-coded against the same-period US index 2.70, and as a residual
 *   against its own PM2.5 sub-index 3.27 — all worse than its own 1.64. The two scales weight
 *   pollutants differently and the EU headline is NO2/O3/SO2-driven ~77% of the time, so the
 *   often-quoted redundancy between the scales is category agreement, not codeable structure.
 *   EU PM2.5 conditioned on the US PM2.5 delta does help (0.806 vs 0.894), but 0.088 b/period is
 *   below the bar the cross-variable work set (its shipped candidates were 0.10-0.33), so it
 *   stays unconditioned.
 * - EU PM2.5 is the cheapest column because Open-Meteo's European index uses a 24h RUNNING MEAN
 *   for particulates; it is a far smoother series than the instantaneous US sub-index.
 *
 * These tables are NOT part of the codebook-class ladder — they are shared by every class (see
 * the AQ books in entropy.ts). Registering this script in extract-cell-counts.ts and re-running
 * derive-class-ladder.ts is the follow-up that would fit them per class.
 *
 * Tables land in packages/protocol/src/codebooks.gen.ts via `pnpm generate`; run standalone
 * (below) to derive and print without writing:
 *
 *   pnpm exec tsx packages/codec-server/scripts/derive-air-quality-codebooks.ts
 */
import { rowsFromWindows, HOURS_PER_PERIOD, type Row } from "../src/forecast.ts";
import {
  AQI_US_LOWER, AQI_EU_LOWER, AQI_DELTA_NSYM, AQI_DELTA_ESCAPE_BITS,
  AQI_RESIDUAL_MAX, AQI_NO_DATA, aqiDeltaSym,
  quantAqi, tempDeltaBucket, tempTodBucket, TEMP_DELTA_PREV_BUCKETS, TEMP_DELTA_TOD_BUCKETS,
} from "@weather/protocol";
import {
  deriveCounts, tableOffsets, rowAt, rowCostBits, scaledWeights, runStandalone,
  type CellCounter, type DerivedTables,
} from "./derive-lib.ts";

const NRES = 5;                              // 24h/12h/6h/3h/1h — row 0 kept for table shape
const NDELTA = AQI_DELTA_NSYM;               // 16: deltas -7..7 + escape (see entropy.ts)
const ESCAPE_SYM = NDELTA - 1;
const NRESID = AQI_RESIDUAL_MAX + 1;         // 26: residual 0..25, non-negative by construction
const NPREV = TEMP_DELTA_PREV_BUCKETS;       // 5: ≤-2 | -1 | 0 | +1 | ≥+2
const NTOD = TEMP_DELTA_TOD_BUCKETS;         // 8 uniform 3h buckets of the period's local midpoint

// One counted column: where its values come from, which ladder they sit on, and whether its
// tables carry a time-of-day axis. `tod: false` collapses that axis to a single bucket, so every
// column shares one [res][ctx][sym] shape and one counting loop.
interface Column {
  name: string;                      // count-table name (and the axis label in the log)
  table: string;                     // the constant it becomes in codebooks.gen.ts
  of: (r: Row) => number | null;     // the raw index value on this row
  lower: readonly number[];          // which AQI ladder quantizes it
  tod: boolean;
}
const COLUMNS: Column[] = [
  { name: "usPm25", table: "AQ_PM25_DELTA_WEIGHTS_BY_RES", of: (r) => r.us_aqi_pm2_5, lower: AQI_US_LOWER, tod: false },
  { name: "usO3", table: "AQ_O3_DELTA_WEIGHTS_BY_RES", of: (r) => r.us_aqi_ozone, lower: AQI_US_LOWER, tod: true },
  { name: "usAqi", table: "AQI_DELTA_WEIGHTS_BY_RES", of: (r) => r.us_aqi, lower: AQI_US_LOWER, tod: true },
  { name: "euAqi", table: "AQI_EU_DELTA_WEIGHTS_BY_RES", of: (r) => r.european_aqi, lower: AQI_EU_LOWER, tod: true },
  { name: "euPm25", table: "AQI_EU_PM25_DELTA_WEIGHTS_BY_RES", of: (r) => r.european_aqi_pm2_5, lower: AQI_EU_LOWER, tod: false },
];
const ctxCount = (c: Column) => NPREV * (c.tod ? NTOD : 1);

export function counter(): CellCounter {
  const tables = [
    ...COLUMNS.map((c) => ({ name: c.name, dims: [NRES, ctxCount(c), NDELTA] })),
    // The headline's residual against max(pm25, o3), keyed by resolution alone — the residual is
    // zero almost everywhere, so a richer context would only split a spike.
    { name: "usResidual", dims: [NRES, NRESID] },
  ];
  const { offsets, nSlots } = tableOffsets(tables);

  // Structurally empty contexts fall back to their resolution's marginal — a 12h period's
  // midpoint only ever lands in two time-of-day buckets, so most tod rows at coarse resolutions
  // never see a sample. Mirrored by tablesFrom and costBits.
  const resRows = (counts: ArrayLike<number>, c: Column) => {
    const nctx = ctxCount(c);
    return Array.from({ length: NRES }, (_, res) => {
      const rows = Array.from({ length: nctx }, (_, ctx) =>
        rowAt(counts, offsets[c.name] + (res * nctx + ctx) * NDELTA, NDELTA));
      const marginal = new Array<number>(NDELTA).fill(0);
      for (const row of rows) for (let s = 0; s < NDELTA; s++) marginal[s] += row[s];
      return { rows, marginal };
    });
  };
  const sum = (r: number[]) => r.reduce((a, b) => a + b, 0);

  return {
    tables, nSlots,
    countCell(h, _startHour, pos, add) {
      // Air quality rides a second corpus source; a cell the CAMS pull didn't cover has no AQ
      // columns at all and contributes nothing.
      if (!pos || !h.time?.length || !h.us_aqi) return;
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
        // Aggregated exactly as production aggregates (maxOf over the period's hours), so the
        // deltas counted here are the deltas the encoder will emit.
        const rows = rowsFromWindows(h, h.time, windows, off);
        const tods = rows.map((_, p) => tempTodBucket((firstUtc + p * hpp) * 2 + hpp + off * 2));

        const quantized: Record<string, number[]> = {};
        for (const c of COLUMNS) {
          const q = rows.map((r) => quantAqi(c.of(r), c.lower));
          quantized[c.name] = q;
          const nctx = ctxCount(c);
          let prevDelta: number | null = null;
          for (let p = 1; p < n; p++) {
            const delta = q[p] - q[p - 1];
            // The column's first delta has no predecessor; bucket 2 is "no change", the
            // distribution a fresh column looks most like. (There is no separate bootstrap
            // table: unlike temp, an AQ column's first delta is one symbol in a hundred.)
            const prev = tempDeltaBucket(prevDelta ?? 0);
            const ctx = c.tod ? prev * NTOD + tods[p] : prev;
            add(offsets[c.name] + (res * nctx + ctx) * NDELTA + aqiDeltaSym(delta));
            prevDelta = delta;
          }
        }

        // The headline residual, counted only where all three US values exist — a period missing
        // one of them encodes through the no-data symbol, not through this table.
        const a = quantized.usAqi, pm = quantized.usPm25, o3 = quantized.usO3;
        for (let p = 0; p < n; p++) {
          if (a[p] === AQI_NO_DATA || pm[p] === AQI_NO_DATA || o3[p] === AQI_NO_DATA) continue;
          const resid = a[p] - Math.max(pm[p], o3[p]);
          // Clamped, not skipped: the headline is the max over sub-indices the wire may not
          // carry (PM10, CO, NO2, SO2), so it is ≥ max(pm25, o3) by construction — a negative
          // here would be a quantization artifact at a band edge, and coding it as 0 costs one
          // band, which is what the encoder does too.
          add(offsets.usResidual + res * NRESID + Math.min(Math.max(resid, 0), AQI_RESIDUAL_MAX));
        }
      }
    },
    tablesFrom(counts): DerivedTables {
      const out: DerivedTables = {};
      for (const c of COLUMNS) {
        out[c.table] = resRows(counts, c).map(({ rows, marginal }) =>
          rows.map((row) => scaledWeights(sum(row) > 0 ? row : marginal)));
      }
      out.AQI_RESIDUAL_WEIGHTS_BY_RES = Array.from({ length: NRES }, (_, res) =>
        scaledWeights(rowAt(counts, offsets.usResidual + res * NRESID, NRESID)));
      return out;
    },
    costBits(counts) {
      const L = new Float64Array(nSlots);
      for (const c of COLUMNS) {
        const nctx = ctxCount(c);
        resRows(counts, c).forEach(({ rows, marginal }, res) =>
          rows.forEach((row, ctx) => {
            const cost = rowCostBits(scaledWeights(sum(row) > 0 ? row : marginal));
            const start = offsets[c.name] + (res * nctx + ctx) * NDELTA;
            // The escape symbol's wire cost includes its raw payload, or the class clustering
            // would under-price the columns that use it most.
            for (let s = 0; s < NDELTA; s++)
              L[start + s] = cost[s] + (s === ESCAPE_SYM ? AQI_DELTA_ESCAPE_BITS : 0);
          }));
      }
      for (let res = 0; res < NRES; res++) {
        const start = offsets.usResidual + res * NRESID;
        const cost = rowCostBits(scaledWeights(rowAt(counts, start, NRESID)));
        for (let s = 0; s < NRESID; s++) L[start + s] = cost[s];
      }
      return L;
    },
  };
}

export async function derive(precounted?: Float64Array): Promise<DerivedTables> {
  const c = counter();
  const counts = precounted ?? await deriveCounts(c);
  const { offsets } = tableOffsets(c.tables);
  const L = c.costBits(counts);
  const RES_LABEL = ["24h", "12h", "6h", "3h", "1h"];

  // Training-set mean bits/period per column at each resolution (held-out numbers are the
  // planning ladder's job; this is the generation log's sanity check).
  for (const col of COLUMNS) {
    const nctx = ctxCount(col);
    const parts: string[] = [];
    let allBits = 0, allN = 0;
    for (let res = 0; res < NRES; res++) {
      let bits = 0, n = 0;
      for (let i = 0; i < nctx * NDELTA; i++) {
        const slot = offsets[col.name] + res * nctx * NDELTA + i;
        bits += counts[slot] * L[slot];
        n += counts[slot];
      }
      allBits += bits; allN += n;
      if (n > 0) parts.push(`${RES_LABEL[res]}=${(bits / n).toFixed(3)}`);
    }
    console.log(`  ${col.name.padEnd(7)} n=${allN} mean=${(allBits / Math.max(1, allN)).toFixed(3)} b/period  [${parts.join(" ")}]`);
  }
  let rBits = 0, rN = 0, rZero = 0;
  for (let res = 0; res < NRES; res++) {
    for (let s = 0; s < NRESID; s++) {
      const slot = offsets.usResidual + res * NRESID + s;
      rBits += counts[slot] * L[slot];
      rN += counts[slot];
      if (s === 0) rZero += counts[slot];
    }
  }
  console.log(`  residual n=${rN} mean=${(rBits / Math.max(1, rN)).toFixed(3)} b/period  (zero ${(100 * rZero / Math.max(1, rN)).toFixed(2)}%)`);

  return c.tablesFrom(counts);
}

runStandalone(import.meta.url, derive);
