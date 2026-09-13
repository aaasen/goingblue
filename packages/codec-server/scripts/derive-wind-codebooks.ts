/**
 * Derive every wind codebook: the gust chain and the surface wind keyed by it, the direction
 * transitions, and the speed deltas for the surface and every pressure level. Three counters,
 * one file: their slot spaces are laid end to end (combineCounters) so `pnpm generate` treats
 * wind as one codebook file.
 *
 * Quantization is the shared extended Beaufort scale for EVERY speed column (forces 0..17,
 * quantWind in derive-lib.ts, must match wire.ts — chosen 2026-07-31 over linear and other
 * companded scales, analyze-wind-scale-heldout.ts). Deltas -17..17 (35 symbols) fit the alphabet
 * directly, no escape needed.
 *
 * GUST AND SURFACE. Gust-delta tables are res-keyed; surface-wind deltas are keyed by
 * (resolution, SAME-period gust delta bucket). The conditioning runs gust → surface (reversed
 * 2026-07-31): gust decodes FIRST (WIND_COLUMNS order in wire.ts) and lends its already-decoded
 * same-period delta to the surface column for free — chosen so surface wind can become optional
 * later (a gust envelope implies most of the sustained story). Direction of conditioning is
 * bit-neutral (held-out 2.638 fwd vs 2.641 rev); the option value decided it. The surface
 * fallback for messages without gust is the [res][level 0] speed table below, which charges no
 * wire cost — sfc's corpus cost lives in the conditioned tables, since gust is always present
 * when counting. Cells whose windows rolled off the lattice before the 2026-07-31 gust add-pass
 * have no wind_gusts_10m series and are skipped. Local-midnight-aligned windows per resolution.
 *
 * DIRECTION. Order-1 transition tables keyed by resolution, plus upper-level-conditioned tables
 * for the pressure-level columns, keyed by the ladder gap to the served level above (windGapClass
 * in entropy.ts — the reader picks any subset of the WIND_LEVELS_HPA levels, so every (lower,
 * upper) pair of the ladder is counted under its gap). Held-out (analyze-wind-heldout.ts):
 *
 *   prev only, trained at 1h, applied everywhere (old design):  3.04 (24h) … 0.76 (1h) b/dir
 *   [res][prev]:                                                2.15 (24h) … 0.76 (1h)
 *   [res][prev × same-period upper dir] (w600/w700):            1.21 (24h) … 0.64 (1h)
 *
 * Resolution keying pays because direction persistence falls sharply with the aggregation step
 * (P(next=prev) ≈ 0.85 at 1h vs ≈ 0.55 at 6h). The full 64-context upper conditioning beat a
 * compact circular-distance variant at every resolution held-out. Sequences are collected under
 * calm gating (no symbol when the quantized speed is ≤ CALM_MAX_FORCE; the context chain carries
 * the last encoded direction), matching wire.ts. The bootstrap table (a column's first encoded
 * direction) is shared across resolutions and levels. The [res][prev] counts are kept in two
 * ranges — sfc + the top level vs the levels below — because on the wire a lower level's symbol
 * is coded under the upper-conditioned table whenever a level above is served (always, in corpus
 * counting), so cost accounting must not charge it under [res][prev] too. The SHIPPED
 * [res][prev] tables still pool every level.
 *
 * SPEED. Delta tables keyed by (resolution, level), plus upper-Δ-conditioned tables for the
 * pressure-level columns, keyed by the ladder gap. Held-out (analyze-wind-heldout.ts):
 *
 *   pooled levels, trained at 1h, applied everywhere (old design): 4.45 (24h) … 1.46 (1h) b/Δ
 *   [res][level]:                                                  3.21 (24h) … 1.44 (1h)
 *   [res][bucket(upper same-period Δ)] (w600/w700):                2.99 (24h) … 1.45 (1h)
 *
 * Level keying pays because the pooled table taxed the surface column hardest (its deltas are
 * far more peaked than the jet levels'). For a level below the topmost served one, the level
 * above's already-decoded same-period delta, bucketed {≤-2, -1, 0, +1, ≥+2}, beats even the
 * level-keyed tables — adjacent pressure levels move together. Since 2026-08-22 the reader
 * selects any subset of the ladder, so the level above may sit one, two or more rungs up; the
 * conditioned tables are keyed by that gap class and trained on every (lower, upper) pair.
 * All of these contexts are known to both sides, so none cost wire bits.
 *
 * Held-out numbers are the scans' job; this script prints training-set stats for the generation
 * log only. Table order in wind.gen.ts: gust, direction, speed.
 *
 * Tables land in packages/protocol/src/codebooks/wind.gen.ts via `pnpm generate`; run standalone
 * (below) to derive and print without writing:
 *
 *   pnpm exec tsx packages/codec-server/scripts/derive-wind-codebooks.ts
 */
import { toFullPeriod } from "../src/forecast.ts";
import {
  VAR, type Variable, TABLE_RES_IDXS, WIND_LEVELS_HPA, WIND_LEVEL_VARS, N_WIND_GAPS, windGapClass,
  upperDeltaBucket, type Period,
} from "@weather/protocol";
import {
  combineCounters, deriveCounts, splitCounts, tableOffsets, rowAt, rowCostBits, scaledWeights,
  runStandalone, quantWind, CALM_MAX_FORCE, type CellCounter, type DerivedTables,
} from "./derive-lib.ts";

const FORCE_MAX = 17;              // extended Beaufort domain, must match wire.ts
const NSYM = 2 * FORCE_MAX + 1;    // 35: speed deltas -17..17
const NRES = TABLE_RES_IDXS.length; // 12h/6h/3h/1h — the resolutions layouts emit, in row order
const NBUCKET = 5;                 // upperDeltaBucket domain: ≤-2, -1, 0, +1, ≥+2
const NGAP = N_WIND_GAPS;          // ladder gap to the conditioning level: 1, 2, 3+
const NLEVEL = 1 + WIND_LEVELS_HPA.length; // sfc, then the ladder (300 hPa … 1000 hPa)
const NDIR = 8;
const RES_LABEL = ["12h", "6h", "3h", "1h"];

const GUST_VARS: ReadonlySet<Variable> = new Set([VAR.wind, VAR.gust]);
const LEVEL_VARS: ReadonlySet<Variable> = new Set([VAR.wind, ...WIND_LEVEL_VARS]);
const deltaSym = (delta: number): number => delta + FORCE_MAX; // -17..17 -> 0..34
const sum = (r: number[]) => r.reduce((a, b) => a + b, 0);
const speedOf = (p: Period, L: number): number | undefined =>
  L === 0 ? p.wind_sfc_kph : p.wind_aloft?.[L - 1]?.kph;
const dirOf = (p: Period, L: number): number | undefined =>
  L === 0 ? p.wind_sfc_dir : p.wind_aloft?.[L - 1]?.dir;

// ── Gust and surface ─────────────────────────────────────────────────────────────

function gustCounter(): CellCounter {
  const tables = [
    { name: "gustDelta", dims: [NRES, NSYM] },
    { name: "sfcDeltaGust", dims: [NRES, NBUCKET, NSYM] },
  ];
  const { offsets, nSlots } = tableOffsets(tables);
  const GUST = offsets.gustDelta, SFC = offsets.sfcDeltaGust;

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
    countCell(ctx, add) {
      const { hourly: h, pos } = ctx;
      if (!pos || !h.time?.length) return;
      if (!h.wind_gusts_10m?.some((v: number | null) => v != null)) return; // pre-add-pass cell
      for (let res = 0; res < NRES; res++) {
        // Periods anchored to the cell's first local midnight, aggregated once per cell
        // and shared with every other counter that wants this anchoring.
        const slice = ctx.atMidnight(TABLE_RES_IDXS[res]);
        if (!slice) continue;
        const periods = slice.rows.map((r) => toFullPeriod(r, GUST_VARS, "US"));
        let prevGust = quantWind(periods[0].wind_gust_kph);
        let prevSfc = quantWind(periods[0].wind_sfc_kph);
        for (let p = 1; p < slice.n; p++) {
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

function gustStats(c: CellCounter, counts: Float64Array): void {
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
    console.log(`  ${RES_LABEL[res]}: n=${sum(gustRow)} gust=${(bitsUnder(gustRow, gustRow) / n).toFixed(3)}` +
      ` sfc|gustΔ=${(sfcBits / Math.max(1, sum(sfcMarginal))).toFixed(3)} b/period (training-set)`);
  }
}

// ── Direction ────────────────────────────────────────────────────────────────────

function directionCounter(): CellCounter {
  const tables = [
    { name: "windDirBootstrap", dims: [NDIR] },
    { name: "windDirTransLow", dims: [NRES, NDIR, NDIR] },   // sfc + the top level
    { name: "windDirTransHigh", dims: [NRES, NDIR, NDIR] },  // lower levels (upper table on wire)
    { name: "windDirUpper", dims: [NRES, NGAP, NDIR * NDIR, NDIR] },
  ];
  const { offsets, nSlots } = tableOffsets(tables);
  const BOOT = offsets.windDirBootstrap, LOW = offsets.windDirTransLow,
    HIGH = offsets.windDirTransHigh, UPPER = offsets.windDirUpper;

  // trans[res][prev][next] pooled over all levels (low + high ranges), plus its per-res marginal.
  const transRows = (counts: ArrayLike<number>): { rows: number[][]; marginal: number[] }[] =>
    Array.from({ length: NRES }, (_, res) => {
      const rows = Array.from({ length: NDIR }, (_, prev) => {
        const row = rowAt(counts, LOW + (res * NDIR + prev) * NDIR, NDIR);
        for (let s = 0; s < NDIR; s++) row[s] += counts[HIGH + (res * NDIR + prev) * NDIR + s];
        return row;
      });
      const marginal = new Array<number>(NDIR).fill(0);
      for (const row of rows) for (let s = 0; s < NDIR; s++) marginal[s] += row[s];
      return { rows, marginal };
    });

  return {
    tables, nSlots,
    countCell(ctx, add) {
      for (let resIdx = 0; resIdx < NRES; resIdx++) {
        // Periods anchored to the request hour, aggregated once per cell and shared with every
        // other counter using this anchoring.
        const slice = ctx.atRequest(TABLE_RES_IDXS[resIdx]);
        if (!slice) continue;
        const { n, rows } = slice;
        const periods: Period[] = rows.map((r) => toFullPeriod(r, LEVEL_VARS, "US"));
        // Speeds only feed the calm gate here, but the gate must mirror the wire's own
        // quantization or the trained tables see a different symbol stream.
        const sp = Array.from({ length: NLEVEL }, (_, L) => periods.map((p) => quantWind(speedOf(p, L))));
        const dr = Array.from({ length: NLEVEL }, (_, L) => periods.map((p) => (dirOf(p, L) ?? 0) % 8));
        // Displayed dir under calm gating: last encoded dir, 0 before any (mirrors wire.ts).
        const disp = sp.map((_, L) => {
          let eff = 0;
          return periods.map((_, p) => (sp[L][p] > CALM_MAX_FORCE ? (eff = dr[L][p]) : eff));
        });
        for (let L = 0; L < NLEVEL; L++) {
          const TRANS = L >= 2 ? HIGH : LOW;
          let prev: number | null = null;
          for (let p = 0; p < n; p++) {
            if (sp[L][p] <= CALM_MAX_FORCE) continue; // calm (< 6 kph): no symbol on the wire
            const d = dr[L][p];
            if (prev === null) add(BOOT + d);
            else {
              add(TRANS + (resIdx * NDIR + prev) * NDIR + d);
              // Every pressure level above this one is a possible conditioning level on the
              // wire (the reader picks the subset); count the pair under its gap class.
              for (let U = 1; U < L; U++) {
                const g = windGapClass(L - U);
                add(UPPER + ((resIdx * NGAP + g) * NDIR * NDIR + prev * NDIR + disp[U][p]) * NDIR + d);
              }
            }
            prev = d;
          }
        }
      }
    },
    tablesFrom(counts): DerivedTables {
      // Thin/unseen contexts fall back to broader priors so every table stays representable:
      // an empty [res][prev] row borrows the resolution's marginal; an empty [res][prev×u] row
      // borrows its [res][prev] row.
      const trans = transRows(counts);
      return {
        WIND_DIR_BOOTSTRAP_WEIGHTS: scaledWeights(rowAt(counts, BOOT, NDIR)),
        WIND_DIR_WEIGHTS_BY_RES: trans.map(({ rows, marginal }) =>
          rows.map((row) => scaledWeights(sum(row) > 0 ? row : marginal))),
        // [res][gap × prev × upper], gap-major (windDirBook in entropy.ts indexes it that way).
        WIND_DIR_UPPER_WEIGHTS_BY_RES: trans.map(({ rows }, res) =>
          Array.from({ length: NGAP * NDIR * NDIR }, (_, gctx) => {
            const row = rowAt(counts, UPPER + (res * NGAP * NDIR * NDIR + gctx) * NDIR, NDIR);
            return scaledWeights(sum(row) > 0 ? row : rows[Math.floor(gctx / NDIR) % NDIR]);
          })),
      };
    },
    costBits(counts) {
      // Wire cost: low-range symbols under the pooled [res][prev] tables, lower levels' under
      // the upper-conditioned tables — their [res][prev] (high-range) slots stay 0 so a symbol is
      // never charged twice.
      const L = new Float64Array(nSlots);
      const put = (start: number, row: number[]) => {
        const c = rowCostBits(scaledWeights(row));
        for (let s = 0; s < NDIR; s++) L[start + s] = c[s];
      };
      put(BOOT, rowAt(counts, BOOT, NDIR));
      transRows(counts).forEach(({ rows, marginal }, res) => {
        rows.forEach((row, prev) =>
          put(LOW + (res * NDIR + prev) * NDIR, sum(row) > 0 ? row : marginal));
        // Only the adjacent-gap class carries wire cost: the benchmark request serves every
        // level, so each conditions on the rung above.
        for (let ctx = 0; ctx < NDIR * NDIR; ctx++) {
          const start = UPPER + (res * NGAP * NDIR * NDIR + ctx) * NDIR;
          const row = rowAt(counts, start, NDIR);
          put(start, sum(row) > 0 ? row : rows[Math.floor(ctx / NDIR)]);
        }
      });
      return L;
    },
  };
}

function directionStats(c: CellCounter, counts: Float64Array): void {
  let symbols = 0;
  const { offsets } = tableOffsets(c.tables);
  // Every emission lands exactly once in bootstrap/low/high (upper double-counts high symbols).
  for (let i = offsets.windDirBootstrap; i < offsets.windDirUpper; i++) symbols += counts[i];
  console.log(`  encoded (calm-gated) direction symbols across ${NRES} resolutions: ${symbols}`);
}

// ── Speed ────────────────────────────────────────────────────────────────────────

// [res][level] wire cost: only the topmost level (300 hPa) encodes there in corpus conditions
// (the benchmark's all-levels request) — sfc is charged under the gust counter's conditioned
// tables (gust always present in counting), every other level under the adjacent-gap upper-Δ
// tables. A symbol is never charged twice.
const CHARGED = Array.from({ length: NLEVEL }, (_, L) => L === 1);

function speedCounter(): CellCounter {
  const tables = [
    { name: "windSpeedDelta", dims: [NRES, NLEVEL, NSYM] },
    { name: "windSpeedUpperDelta", dims: [NRES, NGAP, NBUCKET, NSYM] },
  ];
  const { offsets, nSlots } = tableOffsets(tables);
  const LEVEL = offsets.windSpeedDelta, UPPER = offsets.windSpeedUpperDelta;

  // byLevel[res][level] rows plus the per-res pooled marginal (the empty-row fallback).
  const levelRows = (counts: ArrayLike<number>): { rows: number[][]; marginal: number[] }[] =>
    Array.from({ length: NRES }, (_, res) => {
      const rows = Array.from({ length: NLEVEL }, (_, l) =>
        rowAt(counts, LEVEL + (res * NLEVEL + l) * NSYM, NSYM));
      const marginal = new Array<number>(NSYM).fill(0);
      for (const row of rows) for (let s = 0; s < NSYM; s++) marginal[s] += row[s];
      return { rows, marginal };
    });

  return {
    tables, nSlots,
    countCell(ctx, add) {
      for (let resIdx = 0; resIdx < NRES; resIdx++) {
        // Periods anchored to the request hour, aggregated once per cell and shared with every
        // other counter using this anchoring.
        const slice = ctx.atRequest(TABLE_RES_IDXS[resIdx]);
        if (!slice) continue;
        const { n, rows } = slice;
        const periods: Period[] = rows.map((r) => toFullPeriod(r, LEVEL_VARS, "US"));
        const sp = Array.from({ length: NLEVEL }, (_, L) => periods.map((p) => quantWind(speedOf(p, L))));
        for (let L = 0; L < NLEVEL; L++) {
          for (let p = 1; p < n; p++) {
            const sym = deltaSym(sp[L][p] - sp[L][p - 1]);
            add(LEVEL + (resIdx * NLEVEL + L) * NSYM + sym);
            // Every pressure level above this one is a possible conditioning level on the wire
            // (the reader picks the subset); count the pair under its gap class.
            for (let U = 1; U < L; U++) {
              const g = windGapClass(L - U);
              add(UPPER + ((resIdx * NGAP + g) * NBUCKET + upperDeltaBucket(sp[U][p] - sp[U][p - 1])) * NSYM + sym);
            }
          }
        }
      }
    },
    tablesFrom(counts): DerivedTables {
      // Empty rows (rare tails at coarse resolutions) fall back to the resolution's pooled marginal.
      const byRes = levelRows(counts);
      return {
        WIND_SPEED_DELTA_WEIGHTS_BY_RES_LEVEL: byRes.map(({ rows, marginal }) =>
          rows.map((row) => scaledWeights(sum(row) > 0 ? row : marginal))),
        // [res][gap × bucket], gap-major (windSpeedBook in entropy.ts indexes it that way).
        WIND_SPEED_UPPER_DELTA_WEIGHTS_BY_RES: byRes.map(({ marginal }, res) =>
          Array.from({ length: NGAP * NBUCKET }, (_, gb) => {
            const row = rowAt(counts, UPPER + (res * NGAP * NBUCKET + gb) * NSYM, NSYM);
            return scaledWeights(sum(row) > 0 ? row : marginal);
          })),
      };
    },
    costBits(counts) {
      // See CHARGED above — only the top level's [res][level] slots carry wire cost here, and
      // of the upper tables only the adjacent-gap class (the benchmark request carries every
      // level, so each conditions on the rung above).
      const L = new Float64Array(nSlots);
      const put = (start: number, row: number[]) => {
        const c = rowCostBits(scaledWeights(row));
        for (let s = 0; s < NSYM; s++) L[start + s] = c[s];
      };
      levelRows(counts).forEach(({ rows, marginal }, res) => {
        rows.forEach((row, l) => {
          if (!CHARGED[l]) return;
          put(LEVEL + (res * NLEVEL + l) * NSYM, sum(row) > 0 ? row : marginal);
        });
        for (let b = 0; b < NBUCKET; b++) {
          const start = UPPER + (res * NGAP * NBUCKET + b) * NSYM; // gap class 0 = adjacent
          const row = rowAt(counts, start, NSYM);
          put(start, sum(row) > 0 ? row : marginal);
        }
      });
      return L;
    },
  };
}

function speedStats(c: CellCounter, counts: Float64Array): void {
  let samples = 0;
  for (let i = 0; i < c.tables[0].dims.reduce((a, b) => a * b, 1); i++) samples += counts[i];
  console.log(`  delta samples across ${NRES} resolutions × ${NLEVEL} levels: ${samples}`);
}

// ── The wind codebook file ───────────────────────────────────────────────────────

const PARTS = [
  { counter: gustCounter, stats: gustStats },
  { counter: directionCounter, stats: directionStats },
  { counter: speedCounter, stats: speedStats },
];

export function counter(): CellCounter {
  return combineCounters(PARTS.map((p) => p.counter()));
}

export async function derive(precounted?: Float64Array): Promise<DerivedTables> {
  const parts = PARTS.map((p) => p.counter());
  const counts = precounted ?? await deriveCounts(combineCounters(parts));
  const vecs = splitCounts(parts, counts);
  const tables: DerivedTables = {};
  parts.forEach((c, i) => {
    PARTS[i].stats(c, vecs[i]);
    Object.assign(tables, c.tablesFrom(vecs[i]));
  });
  return tables;
}

runStandalone(import.meta.url, derive);
