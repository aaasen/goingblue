/**
 * Derive freezing-level-delta codebooks keyed by (resolution, SAME-period temp-delta bucket) —
 * context both sides already have, so none of it costs wire bits: temp decodes before freeze,
 * and the bucket is taken from the CLAMPED reconstruction delta the decoder actually sees (the
 * same tempDeltaBucket the temp column keys its own tables on). The freezing level is where the
 * 0°C isotherm sits, so it moves with the airmass temperature — a warming period pulls it up, a
 * cooling one down. Held-out (5-fold by location, analyze-cross-var-heldout.ts, post 5-bit
 * widening): pooled 1.445 → res 1.393 → res × tempΔ 1.308 b/period.
 *
 * Temp is not guaranteed in vars_mask, so a res-keyed fallback table set (the tempΔ marginal)
 * ships alongside — the same present/absent split the 600/700 hPa wind columns use for their
 * upper-level context.
 *
 * The quantized freeze-level step (0..31, 304.8 m / 1000 ft steps — see the freeze column in
 * wire.ts) is bounded, so the full delta range -31..31 (63 symbols) fits directly in the alphabet —
 * no escape/raw-payload fallback needed. Earlier versions k-means clustered per-forecast
 * histograms into 16 per-message-selected tables; held-out that LOST to a single shared table
 * (1.371 vs 1.340 b/period) — freeze deltas have no distinct per-location regimes, but they do
 * follow the same-period temp delta, which is free.
 *
 * Training mirrors the wire exactly: local-midnight-aligned uniform windows per resolution (the
 * alignment layoutFor produces), the same quantizers as wire.ts, temp deltas clamped and diffed
 * against the reconstruction. Only the resolutions layouts emit are trained — TABLE_RES_IDXS
 * (12h/6h/3h/1h) in table-row order, the same mapping resTableIdx applies at the codec.
 *
 * Tables land in packages/protocol/src/codebooks.gen.ts via `pnpm generate`; run standalone
 * (below) to derive and print without writing:
 *
 *   pnpm exec tsx packages/codec-server/scripts/derive-freeze-delta-codebooks.ts
 */
import { rowsFromWindows, toFullPeriod, HOURS_PER_PERIOD } from "../src/forecast.ts";
import {
  VARS_BIT, tempDeltaBucket, TEMP_DELTA_PREV_BUCKETS, TEMP_DELTA_MIN, TEMP_DELTA_MAX,
  TABLE_RES_IDXS,
} from "@weather/protocol";
import {
  deriveCounts, tableOffsets, rowAt, rowCostBits, scaledWeights, runStandalone,
  type CellCounter, type DerivedTables,
} from "./derive-lib.ts";

const STEP_BITS = 5;               // matches the freeze column width in wire.ts (steps 0..31)
const STEP_MAX = (1 << STEP_BITS) - 1;
const NSYM = 2 * STEP_MAX + 1;     // 63: deltas -31..31, no escape needed (already bounded)
const STEP_M = 304.8;              // 1000 ft, must match wire.ts
const NRES = TABLE_RES_IDXS.length; // 12h/6h/3h/1h — the resolutions layouts emit, in row order
const NBUCKET = TEMP_DELTA_PREV_BUCKETS;
const MASK = (1 << VARS_BIT.temp) | (1 << VARS_BIT.freeze);

// Same float-dust epsilon AND clamp as wire.ts quantFreeze (clampInt: [0, STEP_MAX]) — training
// must quantize exactly like the wire. The lower clamp is load-bearing: the corpus holds
// below-sea-level freezing levels (polar winter) and −100000 missing-data sentinels, and an
// unclamped negative step lets a delta exceed ±STEP_MAX, indexing past the 63-symbol count
// array (undefined++ → NaN) — which silently knocked whole context rows back to the marginal.
const quantFreeze = (m: number): number =>
  Math.min(Math.max(Math.floor(m / STEP_M + 1e-9), 0), STEP_MAX);
const quantTemp = (c: number): number => Math.min(Math.max(Math.round(c + 100), 0), 255);
const deltaSym = (delta: number): number => delta + STEP_MAX; // -31..31 -> 0..62

export function counter(): CellCounter {
  const tables = [{ name: "freezeDelta", dims: [NRES, NBUCKET, NSYM] }];
  const { nSlots } = tableOffsets(tables);
  const sum = (r: number[]) => r.reduce((a, b) => a + b, 0);

  // counts[res][tempΔ bucket][sym]; the fallback tables pool the bucket axis per res.
  const resRows = (counts: ArrayLike<number>): { rows: number[][]; marginal: number[] }[] =>
    Array.from({ length: NRES }, (_, res) => {
      const rows = Array.from({ length: NBUCKET }, (_, b) =>
        rowAt(counts, (res * NBUCKET + b) * NSYM, NSYM));
      const marginal = new Array<number>(NSYM).fill(0);
      for (const row of rows) for (let s = 0; s < NSYM; s++) marginal[s] += row[s];
      return { rows, marginal };
    });

  return {
    tables, nSlots,
    countCell(ctx, add) {
      const { hourly: h, pos } = ctx;
      if (!pos || !h.time?.length) return;
      const off = Math.round(pos.lon / 15);
      const dataStart = Math.floor(Date.parse(`${h.time[0]}:00Z`) / 3600000);
      const dataEnd = dataStart + h.time.length;
      for (let res = 0; res < NRES; res++) {
        // Periods anchored to the cell's first local midnight, aggregated once per cell
        // and shared with every other counter that wants this anchoring.
        const slice = ctx.atMidnight(TABLE_RES_IDXS[res]);
        if (!slice) continue;
        const { hpp, start: firstUtc, n } = slice;
        const periods = slice.rows.map((r) => toFullPeriod(r, MASK, "US"));

        let tempRecon = quantTemp(periods[0].temp_c ?? 0);
        let prevFreeze = quantFreeze(periods[0].freeze_m ?? 0);
        for (let p = 1; p < n; p++) {
          const tempDelta = Math.min(Math.max(
            quantTemp(periods[p].temp_c ?? 0) - tempRecon, TEMP_DELTA_MIN), TEMP_DELTA_MAX);
          tempRecon += tempDelta;
          const freeze = quantFreeze(periods[p].freeze_m ?? 0);
          add((res * NBUCKET + tempDeltaBucket(tempDelta)) * NSYM + deltaSym(freeze - prevFreeze));
          prevFreeze = freeze;
        }
      }
    },
    tablesFrom(counts): DerivedTables {
      const byRes = resRows(counts);
      return {
        // The tempΔ marginal per res — the fallback tables (temp absent from vars_mask), and the
        // backstop for any empty (res, bucket) context.
        FREEZE_DELTA_WEIGHTS_BY_RES: byRes.map(({ marginal }) => scaledWeights(marginal)),
        FREEZE_DELTA_TEMP_WEIGHTS_BY_RES: byRes.map(({ rows, marginal }) =>
          rows.map((row) => scaledWeights(sum(row) > 0 ? row : marginal))),
      };
    },
    costBits(counts) {
      const L = new Float64Array(nSlots);
      resRows(counts).forEach(({ rows, marginal }, res) =>
        rows.forEach((row, b) => {
          const c = rowCostBits(scaledWeights(sum(row) > 0 ? row : marginal));
          for (let s = 0; s < NSYM; s++) L[(res * NBUCKET + b) * NSYM + s] = c[s];
        }));
      return L;
    },
  };
}

export async function derive(precounted?: Float64Array): Promise<DerivedTables> {
  const c = counter();
  const counts = precounted ?? await deriveCounts(c);
  // Training-set mean bits/period per resolution, for the generation log (held-out numbers are
  // the scan's job — see analyze-cross-var-heldout.ts).
  const sum = (r: number[]) => r.reduce((a, b) => a + b, 0);
  const bitsUnder = (row: number[], table: number[]): number => {
    const cost = rowCostBits(scaledWeights(table));
    let bits = 0;
    for (let s = 0; s < NSYM; s++) if (row[s] > 0) bits += row[s] * cost[s];
    return bits;
  };
  for (let res = 0; res < NRES; res++) {
    const rows = Array.from({ length: NBUCKET }, (_, b) =>
      rowAt(counts, (res * NBUCKET + b) * NSYM, NSYM));
    const marginal = new Array<number>(NSYM).fill(0);
    for (const row of rows) for (let s = 0; s < NSYM; s++) marginal[s] += row[s];
    let bits = 0, flatBits = 0;
    for (const row of rows) {
      bits += bitsUnder(row, sum(row) > 0 ? row : marginal);
      flatBits += bitsUnder(row, marginal);
    }
    const n = Math.max(1, sum(marginal));
    const label = ["12h", "6h", "3h", "1h"][res];
    console.log(`  ${label}: n=${sum(marginal)} mean=${(bits / n).toFixed(3)} b/period` +
      ` (res-only fallback ${(flatBits / n).toFixed(3)}, training-set)`);
  }
  return c.tablesFrom(counts);
}

runStandalone(import.meta.url, derive);
