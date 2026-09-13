/**
 * Temp-delta conditioning ladder: held-out (5-fold by location) bits/period for a series of
 * codebook-context schemes, so the adoption decision was made on measured numbers.
 *
 * Rungs (every context is free: both sides already have it):
 *   res         resolution alone
 *   prevΔ       order-1 on the previous decoded delta, bucketed {≤-2, -1, 0, +1, ≥+2}
 *   tod4        period-midpoint local hour: night/morning/afternoon/evening
 *   solar       solar-elevation bucket (NOAA position at the period midpoint: 3 bands × rising/falling)
 *   todNu       N uniform time-of-day buckets of the local day
 *   prevΔ × tod8u × res   ← shipped (tempDeltaBucket × tempTodBucket per resolution row)
 *
 * OUTCOME (2026-07): the cheapest-of-16 k-means tables with a 4-bit per-column selector cost
 * 2.648 b/period overall (12h 5.367 · 6h 4.244 · 3h 3.232 · 1h 1.980); re-derived order-0 with
 * cheapest-of-K + selector landed 2.65-2.68 for every K, and resolution alone matched it:
 * the selector was mostly re-discovering resolution. tod8 × res reached 2.388 and
 * prevΔ × tod8 × res 2.335, prevΔ's ~0.05 sign-consistent in all five folds. Solar elevation
 * did not beat the plain time-of-day buckets. Those historical rungs are no longer computed.
 *
 * Data path mirrors the wire: local-midnight-aligned windows per resolution (eachColumn),
 * representativeTemps sampling, 1 °C quantization, clamp-and-heal delta chain, the escape
 * (|Δ| > 7) charged its 6 raw payload bits.
 *
 *   pnpm exec tsx packages/codec-server/scripts/analyze/temperature.ts [--stride N]
 */
import {
  tempDeltaBucket, tempTodBucket, TEMP_DELTA_PREV_BUCKETS, TEMP_DELTA_TOD_BUCKETS,
  TEMP_DELTA_CORE_RADIUS, TEMP_DELTA_MIN, TEMP_DELTA_MAX, TEMP_DELTA_ESCAPE_BITS,
} from "@weather/protocol";
import {
  NRES, argStride, eachColumn, heldOut, localMidHalfHours, printFolds, printLadder, runStandalone,
  type Rung,
} from "./lib.ts";

const NSYM = 2 * TEMP_DELTA_CORE_RADIUS + 2; // 15 core + escape
const ESCAPE_SYM = NSYM - 1;
const N_PREV = TEMP_DELTA_PREV_BUCKETS;
const deltaSym = (d: number) => (Math.abs(d) <= TEMP_DELTA_CORE_RADIUS ? d + TEMP_DELTA_CORE_RADIUS : ESCAPE_SYM);
const escapeBits = (s: number) => (s === ESCAPE_SYM ? TEMP_DELTA_ESCAPE_BITS : 0);

// ── Context functions ────────────────────────────────────────────────────────────

// Period-midpoint local hour → 4 buckets: night [22,6) / morning [6,12) / afternoon [12,17) /
// evening [17,22), in half-hours so a 3h period's x.5 midpoint needs no floats.
const tod4 = (halfHours: number) => {
  const h = ((halfHours % 48) + 48) % 48;
  return h < 12 ? 0 : h < 24 ? 1 : h < 34 ? 2 : h < 44 ? 3 : 0;
};
const N_TOD4 = 4;

// n equal buckets over the local day (n must divide 48).
const todUniform = (halfHours: number, n: number) => Math.floor((((halfHours % 48) + 48) % 48) / (48 / n));

// NOAA-ish solar position: elevation (deg) and rising/falling at a UTC instant in half-hours.
function solar(lat: number, lon: number, epochHalfHours: number): { elevDeg: number; rising: boolean } {
  const ms = epochHalfHours * 1800000;
  const d = (ms - Date.UTC(2000, 0, 1, 12)) / 86400000; // days since J2000
  const rad = Math.PI / 180;
  const L = (280.46 + 0.9856474 * d) % 360;
  const g = ((357.528 + 0.9856003 * d) % 360) * rad;
  const lambda = (L + 1.915 * Math.sin(g) + 0.02 * Math.sin(2 * g)) * rad;
  const eps = (23.439 - 0.0000004 * d) * rad;
  const decl = Math.asin(Math.sin(eps) * Math.sin(lambda));
  const ra = Math.atan2(Math.cos(eps) * Math.sin(lambda), Math.cos(lambda));
  const eqTimeHours = (((L * rad - ra + Math.PI * 3) % (Math.PI * 2)) - Math.PI) * (12 / Math.PI);
  const utcHours = (ms / 3600000) % 24;
  const solarHours = (utcHours + lon / 15 + eqTimeHours + 48) % 24;
  const H = (solarHours - 12) * 15 * rad; // hour angle: negative before solar noon
  const phi = lat * rad;
  const elev = Math.asin(Math.sin(phi) * Math.sin(decl) + Math.cos(phi) * Math.cos(decl) * Math.cos(H));
  return { elevDeg: elev / rad, rising: H < 0 };
}

// 3 elevation bands (night < -6°, twilight/low -6..10°, day > 10°) × rising/falling.
const solarBucket = (s: { elevDeg: number; rising: boolean }) =>
  (s.elevDeg < -6 ? 0 : s.elevDeg <= 10 ? 1 : 2) * 2 + (s.rising ? 0 : 1);
const N_SOLAR = 6;

// ── Corpus pass ──────────────────────────────────────────────────────────────────

// One column's delta chain: the wire symbols plus each delta's context features.
interface Chain {
  fold: number;
  res: number;
  syms: Uint8Array;    // wire symbol per delta (0..15)
  prevB: Int8Array;    // tempDeltaBucket(previous decoded delta), -1 for the chain's first delta
  mid: Uint8Array;     // arriving period's midpoint, local half-hours 0..47
  sol: Uint8Array;     // solarBucket of the arriving period's midpoint
}

async function collectChains(stride: number): Promise<Chain[]> {
  const chains: Chain[] = [];
  await eachColumn({ vars: ["temperature_2m"], stride }, (col) => {
    const { rows, n } = col.slice;
    if (rows.some((r) => r.temp_c == null)) return; // incomplete series: skip the column
    const q = rows.map((r) => Math.min(Math.max(Math.round(r.temp_c! + 100), 0), 255));
    const pos = col.ctx.pos!;
    const chain: Chain = {
      fold: col.fold, res: col.res,
      syms: new Uint8Array(n - 1), prevB: new Int8Array(n - 1), mid: new Uint8Array(n - 1), sol: new Uint8Array(n - 1),
    };
    let recon = q[0];
    let prevDelta: number | null = null;
    for (let p = 1; p < n; p++) {
      const delta = Math.min(Math.max(q[p] - recon, TEMP_DELTA_MIN), TEMP_DELTA_MAX);
      recon += delta;
      const localMid = localMidHalfHours(col, p);
      chain.syms[p - 1] = deltaSym(delta);
      chain.prevB[p - 1] = prevDelta === null ? -1 : tempDeltaBucket(prevDelta);
      chain.mid[p - 1] = ((localMid % 48) + 48) % 48;
      chain.sol[p - 1] = solarBucket(solar(pos.lat, pos.lon, localMid - col.utcOffset * 2));
      prevDelta = delta;
    }
    chains.push(chain);
  });
  return chains;
}

// One symbol-context scheme over every chain; the chain's first delta (no previous delta) gets
// its own context in the prevΔ rungs, as the wire's bootstrap table does.
function rung(chains: Chain[], label: string, nctx: number, ctxOf: (c: Chain, i: number) => number): Rung {
  const result = heldOut({ nsym: NSYM, nctx, extraBits: escapeBits }, (add) => {
    for (const c of chains) for (let i = 0; i < c.syms.length; i++) add(c.fold, c.res, ctxOf(c, i), c.syms[i]);
  });
  return { label, result };
}

export async function analyze(args: string[]): Promise<void> {
  const chains = await collectChains(argStride(args));
  let total = 0;
  for (const c of chains) total += c.syms.length;
  console.log(`Columns (forecast × resolution): ${chains.length}, delta symbols: ${total}`);

  const R = (c: Chain) => c.res;
  const withPrev = (nInner: number, inner: (c: Chain, i: number) => number) =>
    (c: Chain, i: number) => (c.prevB[i] < 0 ? N_PREV * nInner : c.prevB[i] * nInner + inner(c, i));

  const rungs: Rung[] = [
    rung(chains, "res only (4 ctx)", NRES, R),
    rung(chains, "prevΔ (6 ctx)", N_PREV + 1, withPrev(1, () => 0)),
    rung(chains, "prevΔ × res (21 ctx)", N_PREV * NRES + 1, withPrev(NRES, R)),
    rung(chains, "tod4 (4 ctx)", N_TOD4, (c, i) => tod4(c.mid[i])),
    rung(chains, "solar elev (6 ctx)", N_SOLAR, (c, i) => c.sol[i]),
    rung(chains, "tod4 × res (16 ctx)", N_TOD4 * NRES, (c, i) => tod4(c.mid[i]) * NRES + c.res),
  ];
  // Time-of-day granularity: n uniform buckets × res. tod4 above is hand-aligned to the diurnal
  // cycle; the uniform variants test whether finer phase helps.
  for (const nTod of [6, 8, 12, 24])
    rungs.push(rung(chains, `tod${nTod}u × res (${nTod * NRES} ctx)`, nTod * NRES, (c, i) => todUniform(c.mid[i], nTod) * NRES + c.res));
  rungs.push(
    rung(chains, "prevΔ × tod4 (21 ctx)", N_PREV * N_TOD4 + 1, withPrev(N_TOD4, (c, i) => tod4(c.mid[i]))),
    rung(chains, "prevΔ × tod4 × res (81 ctx)", N_PREV * N_TOD4 * NRES + 1,
      withPrev(N_TOD4 * NRES, (c, i) => tod4(c.mid[i]) * NRES + c.res)),
    rung(chains, `prevΔ × tod8u × res (${N_PREV * TEMP_DELTA_TOD_BUCKETS * NRES + 1} ctx) ← shipped`,
      N_PREV * TEMP_DELTA_TOD_BUCKETS * NRES + 1,
      withPrev(TEMP_DELTA_TOD_BUCKETS * NRES, (c, i) => tempTodBucket(c.mid[i]) * NRES + c.res)),
  );

  printLadder(`Held-out bits/period (5-fold by location; escape +${TEMP_DELTA_ESCAPE_BITS}b payload included)`, rungs);
  printFolds(rungs.filter((r) => /tod\d+u × res|prevΔ × tod/.test(r.label)));
}

runStandalone(import.meta.url, analyze);
