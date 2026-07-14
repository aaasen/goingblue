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
 *   node packages/server/scripts/derive-temp-delta-codebooks.ts
 */
import { rowsFromWindows, HOURS_PER_PERIOD } from "../src/forecast.ts";
import {
  tempDeltaBucket, tempTodBucket, TEMP_DELTA_PREV_BUCKETS, TEMP_DELTA_TOD_BUCKETS,
  TEMP_DELTA_CORE_RADIUS, TEMP_DELTA_MIN, TEMP_DELTA_MAX, TEMP_DELTA_ESCAPE_BITS,
} from "@weather/protocol";
import { eachForecast, scaledWeights, runStandalone, type DerivedTables } from "./derive-lib.ts";

const NSYM = 2 * TEMP_DELTA_CORE_RADIUS + 2; // 16: 15 core + escape
const ESCAPE_SYM = NSYM - 1;
const NRES = 5; // 24h/12h/6h/3h/1h — row 0 (24h) is dead in fill layouts but kept for shape
const NCTX = TEMP_DELTA_PREV_BUCKETS * TEMP_DELTA_TOD_BUCKETS; // 40

const deltaSym = (d: number) => (Math.abs(d) <= TEMP_DELTA_CORE_RADIUS ? d + TEMP_DELTA_CORE_RADIUS : ESCAPE_SYM);

export async function derive(): Promise<DerivedTables> {
  const counts: number[][][] = Array.from({ length: NRES }, () =>
    Array.from({ length: NCTX }, () => new Array(NSYM).fill(0)));
  const bootstrap = new Array(NSYM).fill(0);
  let columns = 0, symbols = 0;

  await eachForecast((h, _startHour, _loc, pos) => {
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
        if (prevDelta === null) bootstrap[sym]++;
        else {
          const tod = tempTodBucket((firstUtc + p * hpp) * 2 + hpp + off * 2);
          counts[res][tempDeltaBucket(prevDelta) * TEMP_DELTA_TOD_BUCKETS + tod][sym]++;
        }
        prevDelta = delta;
        symbols++;
      }
      columns++;
    }
  });
  console.log(`Columns (forecast × resolution): ${columns}, delta symbols: ${symbols}`);

  // Empty contexts (structural at coarse resolutions: a 12h period's midpoint only ever lands in
  // two tod buckets) fall back to the resolution's pooled marginal.
  const sum = (r: number[]) => r.reduce((a, b) => a + b, 0);
  const marginal = counts.map((byCtx) => {
    const m = new Array(NSYM).fill(0);
    for (const row of byCtx) for (let s = 0; s < NSYM; s++) m[s] += row[s];
    return m;
  });

  // Training-set mean bits/period per resolution, for the generation log (held-out numbers are
  // the ladder's job).
  for (let res = 0; res < NRES; res++) {
    let bits = 0, n = 0;
    for (let ctx = 0; ctx < NCTX; ctx++) {
      const row = sum(counts[res][ctx]) > 0 ? counts[res][ctx] : marginal[res];
      const w = scaledWeights(row);
      const total = sum(w);
      for (let s = 0; s < NSYM; s++) {
        if (counts[res][ctx][s] === 0) continue;
        bits += counts[res][ctx][s] * (-Math.log2(w[s] / total) + (s === ESCAPE_SYM ? TEMP_DELTA_ESCAPE_BITS : 0));
        n += counts[res][ctx][s];
      }
    }
    const label = ["24h", "12h", "6h", "3h", "1h"][res];
    console.log(`  ${label}: n=${n} mean=${(bits / Math.max(1, n)).toFixed(3)} b/period (training-set)`);
  }

  return {
    TEMP_DELTA_BOOTSTRAP_WEIGHTS: scaledWeights(bootstrap),
    TEMP_DELTA_WEIGHTS_BY_RES: counts.map((byCtx, res) =>
      byCtx.map((row) => scaledWeights(sum(row) > 0 ? row : marginal[res]))),
  };
}

runStandalone(import.meta.url, derive);
