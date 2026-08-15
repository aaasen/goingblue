/**
 * Derive the air-quality codebooks: thirteen columns over two index scales (see the AQI ladders in
 * the protocol's entropy.ts), all trained from the `cams` corpus source, which shares the weather
 * lattice cell-for-cell (derive-lib.ts EXTRA_SOURCE_VARS does the join). Both indices are carried
 * in full — each headline plus every constituent the scale defines.
 *
 * Each column's conditioning was chosen from the corpus, not assumed. Held-out b/period pooled
 * over 12h/6h/3h/1h (analyze-aq-constituents-heldout.ts), `tod` where it earned its place:
 *
 *   US    pm2.5 0.800   ozone 1.083   pm10 0.528   no2 0.204   so2 0.124
 *   EU    pm2.5 0.703   ozone 1.319   pm10 0.621   no2 0.263   so2 0.061
 *   headlines, own deltas:  US 0.935   EU 1.180
 *
 * Why those shapes:
 *
 * - OZONE IS DIURNAL (it is photochemical) and so is NO2 (it follows the traffic cycle), so those
 *   columns want the temp column's res × tod8 × prevΔ ladder. Conditioning ozone on the same
 *   period's PM2.5 delta instead bought 0.004 b/period — different chemistry, no shared signal —
 *   and was rejected.
 * - EACH HEADLINE IS EXACTLY THE MAX over its own constituents: across 52M corpus periods it
 *   exceeds that max in 0.00% of them, on both scales. So a headline codes as a residual against
 *   the max of whichever constituents the wire carries. Only PM2.5, ozone and PM10 ever lead
 *   (US 56.9/40.3/2.8%, EU 23.1/68.6/8.3%), so only those three key the residual tables — NO2 in
 *   the US baseline measured 0.275, bit-for-bit identical to leaving it out. The tables are keyed
 *   by the 3-bit presence mask; which masks the wire actually codes as residuals is pinned in
 *   entropy.ts, because a single-constituent baseline is 2-3x WORSE than the headline's own
 *   deltas. See AQI_US_RESIDUAL_MASKS there for the full ladder.
 * - THE TWO SCALES INVERT EACH OTHER. Ozone leads the European index (68.6%) where PM2.5 leads
 *   the US one (56.9%), which is why the European headline had no usable residual until its ozone
 *   sub-index was collected: against PM2.5 alone the residual costs 3.269 b/period.
 * - THE EUROPEAN COLUMNS DON'T COMPRESS AGAINST THE US ONES. The EU headline conditioned on the
 *   US delta costs 1.79, value-coded against the same-period US index 2.70 — both worse than its
 *   own deltas. The two scales weight pollutants differently, so the often-quoted redundancy
 *   between them is category agreement, not codeable structure. EU PM2.5 conditioned on the US
 *   PM2.5 delta does help (0.806 vs 0.894), but 0.088 b/period is below the bar the
 *   cross-variable work set (its shipped candidates were 0.10-0.33), so it stays unconditioned.
 * - EU PM2.5 is a cheap column because Open-Meteo's European index uses a 24h RUNNING MEAN for
 *   particulates; it is a far smoother series than the instantaneous US sub-index.
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
  { name: "usPm10", table: "AQ_PM10_DELTA_WEIGHTS_BY_RES", of: (r) => r.us_aqi_pm10, lower: AQI_US_LOWER, tod: false },
  { name: "usNo2", table: "AQ_NO2_DELTA_WEIGHTS_BY_RES", of: (r) => r.us_aqi_nitrogen_dioxide, lower: AQI_US_LOWER, tod: true },
  { name: "usSo2", table: "AQ_SO2_DELTA_WEIGHTS_BY_RES", of: (r) => r.us_aqi_sulphur_dioxide, lower: AQI_US_LOWER, tod: false },
  { name: "usAqi", table: "AQI_DELTA_WEIGHTS_BY_RES", of: (r) => r.us_aqi, lower: AQI_US_LOWER, tod: true },
  { name: "euPm25", table: "AQI_EU_PM25_DELTA_WEIGHTS_BY_RES", of: (r) => r.european_aqi_pm2_5, lower: AQI_EU_LOWER, tod: false },
  { name: "euO3", table: "AQI_EU_O3_DELTA_WEIGHTS_BY_RES", of: (r) => r.european_aqi_ozone, lower: AQI_EU_LOWER, tod: true },
  { name: "euPm10", table: "AQI_EU_PM10_DELTA_WEIGHTS_BY_RES", of: (r) => r.european_aqi_pm10, lower: AQI_EU_LOWER, tod: false },
  { name: "euNo2", table: "AQI_EU_NO2_DELTA_WEIGHTS_BY_RES", of: (r) => r.european_aqi_nitrogen_dioxide, lower: AQI_EU_LOWER, tod: true },
  { name: "euSo2", table: "AQI_EU_SO2_DELTA_WEIGHTS_BY_RES", of: (r) => r.european_aqi_sulphur_dioxide, lower: AQI_EU_LOWER, tod: false },
  { name: "euAqi", table: "AQI_EU_DELTA_WEIGHTS_BY_RES", of: (r) => r.european_aqi, lower: AQI_EU_LOWER, tod: true },
];
const ctxCount = (c: Column) => NPREV * (c.tod ? NTOD : 1);

// Each headline's residual tables: the count-table name, the generated constant, the headline's
// own column, and the three constituents that key it — in AQI_BASE_* bit order (pm2.5, ozone,
// pm10), which is what makes `mask` here the same mask v2.ts derives from vars_mask.
const RESIDUALS: { name: string; table: string; head: string; base: [string, string, string] }[] = [
  { name: "usResidual", table: "AQI_RESIDUAL_WEIGHTS_BY_MASK_RES", head: "usAqi",
    base: ["usPm25", "usO3", "usPm10"] },
  { name: "euResidual", table: "AQI_EU_RESIDUAL_WEIGHTS_BY_MASK_RES", head: "euAqi",
    base: ["euPm25", "euO3", "euPm10"] },
];
const NMASK = 8; // 3-bit presence mask; row 0 is generated but never looked up

export function counter(): CellCounter {
  const tables = [
    ...COLUMNS.map((c) => ({ name: c.name, dims: [NRES, ctxCount(c), NDELTA] })),
    // Each headline's residual against the max of its carried constituents, keyed by the 3-bit
    // presence mask and the resolution — within a mask the residual is a spike at zero, so a
    // richer context would only split it. Every mask is counted from the same periods; which of
    // them the wire actually uses is v2.ts's call (AQI_*_RESIDUAL_MASKS).
    ...RESIDUALS.map((r) => ({ name: r.name, dims: [NMASK, NRES, NRESID] })),
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

        // Each headline's residual, under every presence mask, counted only where the headline
        // and the mask's constituents all exist — a period missing one encodes through the
        // no-data symbol, not through this table. One period contributes to all 7 masks, which is
        // what lets a single pass fit every table the encoder might select.
        for (const r of RESIDUALS) {
          const a = quantized[r.head];
          const base = r.base.map((b) => quantized[b]);
          for (let p = 0; p < n; p++) {
            if (a[p] === AQI_NO_DATA) continue;
            for (let mask = 1; mask < NMASK; mask++) {
              let m = 0, ok = true;
              for (let i = 0; i < base.length; i++) {
                if (!(mask & (1 << i))) continue;
                if (base[i][p] === AQI_NO_DATA) { ok = false; break; }
                if (base[i][p] > m) m = base[i][p];
              }
              if (!ok) continue;
              // Clamped, not skipped: the headline is the max over sub-indices this mask may not
              // carry, so it is ≥ that max by construction — a negative here would be a
              // quantization artifact at a band edge, and coding it as 0 costs one band, which is
              // what the encoder does too.
              add(offsets[r.name] + (mask * NRES + res) * NRESID
                + Math.min(Math.max(a[p] - m, 0), AQI_RESIDUAL_MAX));
            }
          }
        }
      }
    },
    tablesFrom(counts): DerivedTables {
      const out: DerivedTables = {};
      for (const c of COLUMNS) {
        out[c.table] = resRows(counts, c).map(({ rows, marginal }) =>
          rows.map((row) => scaledWeights(sum(row) > 0 ? row : marginal)));
      }
      for (const r of RESIDUALS) {
        out[r.table] = Array.from({ length: NMASK }, (_, mask) =>
          Array.from({ length: NRES }, (_, res) =>
            scaledWeights(rowAt(counts, offsets[r.name] + (mask * NRES + res) * NRESID, NRESID))));
      }
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
      for (const r of RESIDUALS) {
        for (let mask = 0; mask < NMASK; mask++) {
          for (let res = 0; res < NRES; res++) {
            const start = offsets[r.name] + (mask * NRES + res) * NRESID;
            const cost = rowCostBits(scaledWeights(rowAt(counts, start, NRESID)));
            for (let s = 0; s < NRESID; s++) L[start + s] = cost[s];
          }
        }
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
  // Every residual mask, so the log shows both the ones the wire selects and the ones it rejects
  // in favour of the headline's own deltas (printed above as usAqi / euAqi).
  const MASK_LABEL = ["-", "pm2.5", "o3", "pm2.5+o3", "pm10", "pm2.5+pm10", "o3+pm10", "all3"];
  for (const r of RESIDUALS) {
    for (let mask = 1; mask < NMASK; mask++) {
      let rBits = 0, rN = 0, rZero = 0;
      for (let res = 0; res < NRES; res++) {
        for (let s = 0; s < NRESID; s++) {
          const slot = offsets[r.name] + (mask * NRES + res) * NRESID + s;
          rBits += counts[slot] * L[slot];
          rN += counts[slot];
          if (s === 0) rZero += counts[slot];
        }
      }
      console.log(
        `  ${r.name.padEnd(11)} ${MASK_LABEL[mask].padEnd(11)} n=${rN}` +
        ` mean=${(rBits / Math.max(1, rN)).toFixed(3)} b/period` +
        `  (zero ${(100 * rZero / Math.max(1, rN)).toFixed(2)}%)`);
    }
  }

  return c.tablesFrom(counts);
}

runStandalone(import.meta.url, derive);
