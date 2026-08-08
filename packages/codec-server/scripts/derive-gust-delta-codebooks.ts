/**
 * Derive the gust-delta codebooks (res-keyed) and the surface-wind-delta codebooks keyed by
 * (resolution, SAME-period gust delta bucket). The conditioning runs gust → surface (reversed
 * 2026-07-31, was surface → gust): gust decodes FIRST (WIND_COLUMNS order in v1.ts) and lends
 * its already-decoded same-period delta to the surface column for free — chosen so surface wind
 * can become an optional variable later (gusts are the column worth keeping; a gust envelope
 * implies most of the sustained story). Direction of conditioning is bit-neutral (held-out
 * 2.638 fwd vs 2.641 rev — analyze-wind-scale-heldout.ts); the option value decided it.
 *
 * Quantization is the shared extended Beaufort scale (forces 0..17, quantWind in derive-lib.ts,
 * must match v1.ts): deltas -17..17 (35 symbols), no escape needed. The surface fallback for
 * messages without gust in vars_mask is the [res][level 0] table in
 * derive-wind-speed-delta-codebooks.ts (which charges no wire cost for it — sfc's corpus cost
 * lives HERE, in the conditioned tables, since gust is always present when counting).
 *
 * Held-out numbers are the scan's job; this script prints training-set means for the
 * generation log only.
 *
 * Cells whose windows rolled off the live lattice before the 2026-07-31 gust add-pass have no
 * wind_gusts_10m series and are skipped.
 *
 * Training mirrors the wire exactly: local-midnight-aligned uniform windows per resolution, the
 * same quantizer as v1.ts. The 24h row (resolution index 0) is trained even though fill layouts
 * never emit 24h periods — it keeps the [res][ctx][sym] shape uniform.
 *
 * Tables land in packages/protocol/src/codebooks.gen.ts via `pnpm generate`; run standalone
 * (below) to derive and print without writing:
 *
 *   pnpm exec tsx packages/codec-server/scripts/derive-gust-delta-codebooks.ts
 */
import { rowsFromWindows, toFullPeriod, HOURS_PER_PERIOD } from "../src/forecast.ts";
import { VARS_BIT, upperDeltaBucket, type Period } from "@weather/protocol";
import {
  deriveCounts, tableOffsets, rowAt, rowCostBits, scaledWeights, runStandalone, quantWind,
  type CellCounter, type DerivedTables,
} from "./derive-lib.ts";

const FORCE_MAX = 17;              // extended Beaufort domain, must match v1.ts
const NSYM = 2 * FORCE_MAX + 1;    // 35: deltas -17..17
const NRES = 5; // 24h/12h/6h/3h/1h — row 0 (24h) is dead in fill layouts but kept for shape
const NBUCKET = 5;                 // upperDeltaBucket domain: ≤-2, -1, 0, +1, ≥+2
const MASK = (1 << VARS_BIT.wind) | (1 << VARS_BIT.gust);

const deltaSym = (delta: number): number => delta + FORCE_MAX; // -17..17 -> 0..34

export function counter(): CellCounter {
  const tables = [
    { name: "gustDelta", dims: [NRES, NSYM] },
    { name: "sfcDeltaGust", dims: [NRES, NBUCKET, NSYM] },
  ];
  const { offsets, nSlots } = tableOffsets(tables);
  const GUST = offsets.gustDelta, SFC = offsets.sfcDeltaGust;
  const sum = (r: number[]) => r.reduce((a, b) => a + b, 0);

  // sfc counts[res][gustΔ bucket][sym] plus the per-res pooled marginal (empty-row fallback).
  const sfcRows = (counts: ArrayLike<number>): { rows: number[][]; marginal: number[] }[] =>
    Array.from({ length: NRES }, (_, res) => {
      const rows = Array.from({ length: NBUCKET }, (_, b) =>
        rowAt(counts, SFC + (res * NBUCKET + b) * NSYM, NSYM));
      const marginal = new Array<number>(NSYM).fill(0);
      for (const row of rows) for (let s = 0; s < NSYM; s++) marginal[s] += row[s];
      return { rows, marginal };
    });

  return {
    tables, nSlots,
    countCell(h, _startHour, pos, add) {
      if (!pos || !h.time?.length) return;
      if (!h.wind_gusts_10m?.some((v: number | null) => v != null)) return; // pre-add-pass cell
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
        const periods = rowsFromWindows(h, h.time, windows, off).map((r) => toFullPeriod(r, MASK, "US"));

        let prevGust = quantWind(periods[0].wind_gust_kph);
        let prevSfc = quantWind(periods[0].wind_sfc_kph);
        for (let p = 1; p < n; p++) {
          const gust = quantWind(periods[p].wind_gust_kph);
          const sfc = quantWind(periods[p].wind_sfc_kph);
          add(GUST + res * NSYM + deltaSym(gust - prevGust));
          add(SFC + (res * NBUCKET + upperDeltaBucket(gust - prevGust)) * NSYM + deltaSym(sfc - prevSfc));
          prevGust = gust;
          prevSfc = sfc;
        }
      }
    },
    tablesFrom(counts): DerivedTables {
      return {
        GUST_DELTA_WEIGHTS_BY_RES: Array.from({ length: NRES }, (_, res) =>
          scaledWeights(rowAt(counts, GUST + res * NSYM, NSYM))),
        SFC_DELTA_GUST_WEIGHTS_BY_RES: sfcRows(counts).map(({ rows, marginal }) =>
          rows.map((row) => scaledWeights(sum(row) > 0 ? row : marginal))),
      };
    },
    costBits(counts) {
      // Both tables carry wire cost: gust always encodes under [res]; sfc encodes under the
      // conditioned tables whenever gust is present, which in corpus counting is always.
      const L = new Float64Array(nSlots);
      const put = (start: number, row: number[]) => {
        const c = rowCostBits(scaledWeights(row));
        for (let s = 0; s < NSYM; s++) L[start + s] = c[s];
      };
      for (let res = 0; res < NRES; res++) put(GUST + res * NSYM, rowAt(counts, GUST + res * NSYM, NSYM));
      sfcRows(counts).forEach(({ rows, marginal }, res) =>
        rows.forEach((row, b) =>
          put(SFC + (res * NBUCKET + b) * NSYM, sum(row) > 0 ? row : marginal)));
      return L;
    },
  };
}

export async function derive(): Promise<DerivedTables> {
  const c = counter();
  const counts = await deriveCounts(c);
  const sum = (r: number[]) => r.reduce((a, b) => a + b, 0);
  const bitsUnder = (row: number[], table: number[]): number => {
    const cost = rowCostBits(scaledWeights(table));
    let bits = 0;
    for (let s = 0; s < NSYM; s++) if (row[s] > 0) bits += row[s] * cost[s];
    return bits;
  };
  const { offsets } = tableOffsets(c.tables);
  for (let res = 0; res < NRES; res++) {
    const gustRow = rowAt(counts, offsets.gustDelta + res * NSYM, NSYM);
    const sfcRowsRes = Array.from({ length: NBUCKET }, (_, b) =>
      rowAt(counts, offsets.sfcDeltaGust + (res * NBUCKET + b) * NSYM, NSYM));
    const sfcMarginal = new Array<number>(NSYM).fill(0);
    for (const row of sfcRowsRes) for (let s = 0; s < NSYM; s++) sfcMarginal[s] += row[s];
    let sfcBits = 0;
    for (const row of sfcRowsRes) sfcBits += bitsUnder(row, sum(row) > 0 ? row : sfcMarginal);
    const n = Math.max(1, sum(gustRow));
    const label = ["24h", "12h", "6h", "3h", "1h"][res];
    console.log(`  ${label}: n=${sum(gustRow)} gust=${(bitsUnder(gustRow, gustRow) / n).toFixed(3)}` +
      ` sfc|gustΔ=${(sfcBits / Math.max(1, sum(sfcMarginal))).toFixed(3)} b/period (training-set)`);
  }
  return c.tablesFrom(counts);
}

runStandalone(import.meta.url, derive);
