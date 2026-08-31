/**
 * Temp-delta conditioning ladder: held-out (5-fold by location) bits/period for a series of
 * codebook-context schemes, so the adoption decision (see temp.md) is made on measured numbers.
 *
 * Rungs:
 *   A0  shipped tables, cheapest-of-16 + 4-bit selector (cost of doing nothing)
 *   A1  re-derived order-0, cheapest-of-K + log2(K)-bit selector, K = 1/4/8/16
 *   A2  order-1 on the previous decoded delta, bucketed {≤-2, -1, 0, +1, ≥+2}
 *   A2r A2 × resolution
 *   A3  time-of-day bucket (period-midpoint local hour: night/morning/afternoon/evening)
 *   A3s solar-elevation bucket (NOAA position at period midpoint: 3 bands × rising/falling)
 *   A4  prev-delta bucket × time-of-day
 *
 * Data path mirrors the wire: local-midnight-aligned uniform windows per resolution (the same
 * alignment layoutFor produces — aggregateHourly's UTC-aligned windows would shift the diurnal
 * phase by the UTC offset), representativeTemps sampling via rowsFromWindows, 1 °C quantization,
 * clamp-to-±32-and-heal delta chain, escape (|Δ|>7) charged its 6 raw payload bits.
 *
 *   pnpm exec tsx packages/codec-server/scripts/analyze-temp-heldout.ts
 */
import { rowsFromWindows, HOURS_PER_PERIOD } from "../src/forecast.ts";
import { WIRE_CODEBOOKS, RANS_PROB_BITS } from "@weather/protocol";
import { eachForecast, foldOf, N_FOLDS, scaledWeights } from "./derive-lib.ts";

const CORE_RADIUS = 7;
const NSYM = 2 * CORE_RADIUS + 2; // 15 core + escape
const ESCAPE_SYM = NSYM - 1;
const ESCAPE_BITS = 6;
const DELTA_MIN = -32, DELTA_MAX = 31;
const RES_IDXS = [1, 2, 3, 4]; // 12h/6h/3h/1h — 24h is dead (layouts never emit it)
const RES_LABEL: Record<number, string> = { 1: "12h", 2: "6h", 3: "3h", 4: "1h" };

const deltaSym = (d: number) => (Math.abs(d) <= CORE_RADIUS ? d + CORE_RADIUS : ESCAPE_SYM);

// ── Context functions ────────────────────────────────────────────────────────────

// Previous decoded delta, 5 buckets. Must stay integer-only — if adopted this becomes wire format.
const dBucket = (d: number) => (d <= -2 ? 0 : d === -1 ? 1 : d === 0 ? 2 : d === 1 ? 3 : 4);
const N_DBUCKET = 5;

// Period-midpoint local hour → 4 buckets: night [22,6) / morning [6,12) / afternoon [12,17) /
// evening [17,22). At 12h the midpoints are 6:00 and 18:00 — morning vs evening. Bucket the
// midpoint in half-hours so a 3h period's x.5 midpoint doesn't need floats.
const todBucket = (halfHours: number) => {
  const h = ((halfHours % 48) + 48) % 48; // local half-hours 0..47
  return h < 12 ? 0 : h < 24 ? 1 : h < 34 ? 2 : h < 44 ? 3 : 0;
};
const N_TOD = 4;

// Uniform time-of-day bucketing: n equal buckets over the local day (n must divide 48).
const todUniform = (halfHours: number, n: number) => {
  const h = ((halfHours % 48) + 48) % 48;
  return Math.floor(h / (48 / n));
};

// NOAA-ish solar position: elevation (deg) and rising/falling at a UTC epoch-hour instant.
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

// One uniform-resolution temp-delta chain: the wire symbols plus each delta's context features.
interface Chain {
  fold: number;
  res: number;
  syms: number[];      // wire symbol per delta (0..15)
  prevB: number[];     // dBucket(previous decoded delta), -1 for the chain's first delta
  tod: number[];       // todBucket of the ARRIVING period's midpoint (phased 4-bucket)
  mid: number[];       // arriving period's midpoint, LOCAL half-hours (for uniform tod variants)
  sol: number[];       // solarBucket of the arriving period's midpoint
  hist: number[];      // symbol histogram (for the selector rungs)
}

async function collectChains(): Promise<Chain[]> {
  const chains: Chain[] = [];
  await eachForecast((h, _startHour, loc, pos) => {
    if (!pos) return;
    const times = h.time;
    if (!times?.length || !h.temperature_2m) return;
    const off = Math.round(pos.lon / 15);
    const dataStart = Math.floor(Date.parse(`${times[0]}:00Z`) / 3600000);
    const dataEnd = dataStart + times.length; // exclusive; corpus hours are contiguous
    const fold = foldOf(loc);

    for (const res of RES_IDXS) {
      const hpp = HOURS_PER_PERIOD[res];
      // First local midnight with data, then consecutive hpp-hour windows — the phase layoutFor
      // produces for whole-day slots.
      const firstUtc = Math.ceil((dataStart + off) / 24) * 24 - off;
      const n = Math.floor((dataEnd - firstUtc) / hpp);
      if (n < 3) continue;
      const windows: number[][] = [];
      for (let p = 0; p < n; p++) {
        const w: number[] = [];
        for (let eh = firstUtc + p * hpp; eh < firstUtc + (p + 1) * hpp; eh++) w.push(eh - dataStart);
        windows.push(w);
      }
      const rows = rowsFromWindows(h, times, windows, off);
      if (rows.some((r) => r.temp_c == null)) continue; // incomplete series — skip the column
      const q = rows.map((r) => Math.min(Math.max(Math.round(r.temp_c! + 100), 0), 255));

      const chain: Chain = { fold, res, syms: [], prevB: [], tod: [], mid: [], sol: [], hist: new Array(NSYM).fill(0) };
      let recon = q[0];
      let prevDelta: number | null = null;
      for (let p = 1; p < n; p++) {
        const delta = Math.min(Math.max(q[p] - recon, DELTA_MIN), DELTA_MAX);
        recon += delta;
        const sym = deltaSym(delta);
        const midHalfHours = (firstUtc + p * hpp) * 2 + hpp; // arriving period's midpoint, half-hours
        chain.syms.push(sym);
        chain.hist[sym]++;
        chain.prevB.push(prevDelta === null ? -1 : dBucket(prevDelta));
        chain.tod.push(todBucket(midHalfHours + off * 2));
        chain.mid.push(((midHalfHours + off * 2) % 48 + 48) % 48);
        chain.sol.push(solarBucket(solar(pos.lat, pos.lon, midHalfHours)));
        prevDelta = delta;
      }
      chains.push(chain);
    }
  });
  return chains;
}

// ── Evaluation helpers ───────────────────────────────────────────────────────────

const zeros = (n: number) => new Array<number>(n).fill(0);
const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0);

// Bits to code `testCounts` under scaledWeights(trainCounts) (same flooring the shipped tables
// get), escape payloads included; falls back to `fallback` for an unseen training context.
function heldOutBits(trainCounts: number[], testCounts: number[], fallback: number[]): number {
  const train = sum(trainCounts) > 0 ? trainCounts : fallback;
  const w = scaledWeights(train);
  const total = sum(w);
  let bits = 0;
  for (let s = 0; s < NSYM; s++) {
    if (testCounts[s] === 0) continue;
    bits += testCounts[s] * (-Math.log2(w[s] / total) + (s === ESCAPE_SYM ? ESCAPE_BITS : 0));
  }
  return bits;
}

// Evaluate one symbol-context scheme: ctxOf(chain, i) → context id (chains supply per-symbol
// features), nctx contexts; tables trained per fold on the other folds. Returns bits per res
// plus totals, and per-context training occupancy (summed over folds).
function evalScheme(
  chains: Chain[], nctx: number, ctxOf: (c: Chain, i: number) => number,
): { bits: Record<number, number>; n: Record<number, number>; occupancy: number[]; foldBpp: number[] } {
  // counts[fold][res][ctx][sym]
  const counts = Array.from({ length: N_FOLDS }, () =>
    Object.fromEntries(RES_IDXS.map((r) => [r, Array.from({ length: nctx }, () => zeros(NSYM))])) as Record<number, number[][]>);
  for (const c of chains) {
    for (let i = 0; i < c.syms.length; i++) counts[c.fold][c.res][ctxOf(c, i)][c.syms[i]]++;
  }
  const bits: Record<number, number> = Object.fromEntries(RES_IDXS.map((r) => [r, 0]));
  const n: Record<number, number> = Object.fromEntries(RES_IDXS.map((r) => [r, 0]));
  const occupancy = zeros(nctx);
  const foldBpp: number[] = [];
  for (let fold = 0; fold < N_FOLDS; fold++) {
    // Train tables: sum the other folds. Contexts pool across res unless ctxOf already keys res.
    const train = Array.from({ length: nctx }, () => zeros(NSYM));
    const fallback = zeros(NSYM);
    for (let f = 0; f < N_FOLDS; f++) {
      if (f === fold) continue;
      for (const r of RES_IDXS) {
        for (let ctx = 0; ctx < nctx; ctx++) {
          for (let s = 0; s < NSYM; s++) {
            train[ctx][s] += counts[f][r][ctx][s];
            fallback[s] += counts[f][r][ctx][s];
          }
        }
      }
    }
    for (let ctx = 0; ctx < nctx; ctx++) occupancy[ctx] += sum(train[ctx]) / (N_FOLDS - 1);
    let foldBits = 0, foldN = 0;
    for (const r of RES_IDXS) {
      for (let ctx = 0; ctx < nctx; ctx++) {
        const b = heldOutBits(train[ctx], counts[fold][r][ctx], fallback);
        const cnt = sum(counts[fold][r][ctx]);
        bits[r] += b;
        n[r] += cnt;
        foldBits += b;
        foldN += cnt;
      }
    }
    foldBpp.push(foldBits / foldN);
  }
  return { bits, n, occupancy, foldBpp };
}

// Cost of one column under fixed quantized-frequency tables, cheapest-of-K + selector.
function columnCostQuantized(hist: number[], tables: number[][], selectorBits: number): number {
  let best = Infinity;
  for (const freq of tables) {
    const M = sum(freq);
    let cost = 0;
    for (let s = 0; s < NSYM; s++) {
      if (hist[s] === 0) continue;
      cost += hist[s] * (Math.log2(M) - Math.log2(freq[s]) + (s === ESCAPE_SYM ? ESCAPE_BITS : 0));
    }
    if (cost < best) best = cost;
  }
  return best + selectorBits;
}

// ── k-means (lifted from derive-temp-delta-codebooks.ts; fewer restarts — measurement only) ──

function rng(seed: number) {
  return () => {
    seed |= 0; seed = (seed + 0x6D2B79F5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const dist2 = (a: number[], b: number[]) => a.reduce((s, x, i) => s + (x - b[i]) ** 2, 0);
const nearest = (x: number[], cs: number[][]) => {
  let best = 0, bd = Infinity;
  for (let c = 0; c < cs.length; c++) { const d = dist2(x, cs[c]); if (d < bd) { bd = d; best = c; } }
  return best;
};
function kmeans(data: number[][], k: number, restarts = 4): number[][] {
  const rand = rng(42);
  let best: { centroids: number[][]; inertia: number } | null = null;
  for (let r = 0; r < restarts; r++) {
    const centroids: number[][] = [data[Math.floor(rand() * data.length)].slice()];
    while (centroids.length < k) {
      const d2 = data.map((x) => dist2(x, centroids[nearest(x, centroids)]));
      const total = sum(d2) || 1;
      let t = rand() * total, i = 0;
      while (t > d2[i] && i < data.length - 1) t -= d2[i++];
      centroids.push(data[i].slice());
    }
    const assign = new Array(data.length).fill(-1);
    for (let it = 0; it < 100; it++) {
      let changed = false;
      for (let i = 0; i < data.length; i++) { const a = nearest(data[i], centroids); if (a !== assign[i]) { assign[i] = a; changed = true; } }
      if (!changed) break;
      const sums = centroids.map(() => zeros(NSYM));
      const cnt = zeros(k);
      for (let i = 0; i < data.length; i++) { cnt[assign[i]]++; for (let d = 0; d < NSYM; d++) sums[assign[i]][d] += data[i][d]; }
      for (let c = 0; c < k; c++) if (cnt[c] > 0) centroids[c] = sums[c].map((s) => s / cnt[c]);
    }
    const inertia = data.reduce((s, x) => s + dist2(x, centroids[nearest(x, centroids)]), 0);
    if (!best || inertia < best.inertia) best = { centroids, inertia };
  }
  return best!.centroids;
}

// ── Main ─────────────────────────────────────────────────────────────────────────

const chains = await collectChains();
const totalSyms = sum(chains.map((c) => c.syms.length));
console.log(`Columns (forecast × resolution): ${chains.length}, delta symbols: ${totalSyms}`);

interface Row { label: string; bits: Record<number, number>; n: Record<number, number>; occupancy?: number[] }
const rows: Row[] = [];

// A0 — the pre-conditioning shipped tables (cheapest-of-16 + 4 selector bits per column).
// Only runs while WIRE_CODEBOOKS still carries flat selector tables; after the A4r adoption the
// shipped scheme IS a ladder rung (prevΔ × tod8 × res), so this row is historical. For the
// record it measured 2.648 b/period overall (12h 5.367 · 6h 4.244 · 3h 3.232 · 1h 1.980).
const shippedFlat = (WIRE_CODEBOOKS.tempDelta as { weights?: number[][] }).weights;
if (shippedFlat) {
  const bits: Record<number, number> = Object.fromEntries(RES_IDXS.map((r) => [r, 0]));
  const n: Record<number, number> = Object.fromEntries(RES_IDXS.map((r) => [r, 0]));
  for (const c of chains) {
    bits[c.res] += columnCostQuantized(c.hist, shippedFlat, 4);
    n[c.res] += c.syms.length;
  }
  rows.push({ label: "A0 shipped ×16 (+4b sel)", bits, n });
}

// A1 — re-derived order-0 per fold, cheapest-of-K + log2(K) selector bits per column.
// (--fast skips these: k-means dominates the runtime and the numbers don't change.)
for (const K of process.argv.includes("--fast") ? [] : [1, 4, 8, 16]) {
  const bits: Record<number, number> = Object.fromEntries(RES_IDXS.map((r) => [r, 0]));
  const n: Record<number, number> = Object.fromEntries(RES_IDXS.map((r) => [r, 0]));
  for (let fold = 0; fold < N_FOLDS; fold++) {
    const train = chains.filter((c) => c.fold !== fold);
    const normed = train.map((c) => { const t = sum(c.hist) || 1; return c.hist.map((x) => x / t); });
    const centroids = K === 1
      ? [normed.reduce((acc, h) => acc.map((v, i) => v + h[i] / normed.length), zeros(NSYM))]
      : kmeans(normed, K);
    const tables = centroids.map((c) => scaledWeights(c.map((v) => v * 1e6)));
    const quantized = tables.map((w) => { const t = sum(w); return w.map((x) => x / t * 4096); });
    for (const c of chains) {
      if (c.fold !== fold) continue;
      bits[c.res] += columnCostQuantized(c.hist, quantized, Math.log2(K));
      n[c.res] += c.syms.length;
    }
  }
  rows.push({ label: `A1 re-derived ×${K} (+${Math.log2(K)}b sel)`, bits, n });
}

// A2 / A2r / A3 / A3s / A4 — per-symbol contexts, no selector. Bootstrap (first delta of a
// column, no previous delta) is its own context in the prev-delta rungs.
const nRes = RES_IDXS.length;
const resPos: Record<number, number> = Object.fromEntries(RES_IDXS.map((r, i) => [r, i]));

// Resolution alone — the fully-free context (no selector, no per-symbol state). If this lands
// near A1 ×16, the selector was mostly re-discovering resolution.
const a1r = evalScheme(chains, nRes, (c) => resPos[c.res]);
rows.push({ label: "A1r res only (4 ctx, no sel)", ...a1r });

const a2 = evalScheme(chains, N_DBUCKET + 1, (c, i) => (c.prevB[i] < 0 ? N_DBUCKET : c.prevB[i]));
rows.push({ label: "A2 prevΔ bucket (6 ctx)", ...a2 });
const a2r = evalScheme(chains, N_DBUCKET * nRes + 1, (c, i) =>
  c.prevB[i] < 0 ? N_DBUCKET * nRes : c.prevB[i] * nRes + resPos[c.res]);
rows.push({ label: "A2r prevΔ × res (21 ctx)", ...a2r });

const a3 = evalScheme(chains, N_TOD, (c, i) => c.tod[i]);
rows.push({ label: "A3 time-of-day (4 ctx)", ...a3 });

const a3s = evalScheme(chains, N_SOLAR, (c, i) => c.sol[i]);
rows.push({ label: "A3s solar elev (6 ctx)", ...a3s });

const a3r = evalScheme(chains, N_TOD * nRes, (c, i) => c.tod[i] * nRes + resPos[c.res]);
rows.push({ label: "A3r tod × res (16 ctx)", ...a3r });

// A3r tod-granularity sweep: n uniform buckets of 24/n hours × res. (The phased 4-bucket above
// is hand-aligned to the diurnal cycle; the uniform variants test whether finer phase helps.)
const a3rU: Record<number, ReturnType<typeof evalScheme>> = {};
for (const nTod of [6, 8, 12, 24]) {
  a3rU[nTod] = evalScheme(chains, nTod * nRes, (c, i) => todUniform(c.mid[i], nTod) * nRes + resPos[c.res]);
  rows.push({ label: `A3r tod${nTod}u × res (${nTod * nRes} ctx)`, ...a3rU[nTod] });
}

const a4 = evalScheme(chains, N_DBUCKET * N_TOD + 1, (c, i) =>
  c.prevB[i] < 0 ? N_DBUCKET * N_TOD : c.prevB[i] * N_TOD + c.tod[i]);
rows.push({ label: "A4 prevΔ × tod (21 ctx)", ...a4 });

const a4r = evalScheme(chains, N_DBUCKET * N_TOD * nRes + 1, (c, i) =>
  c.prevB[i] < 0 ? N_DBUCKET * N_TOD * nRes : (c.prevB[i] * N_TOD + c.tod[i]) * nRes + resPos[c.res]);
rows.push({ label: "A4r prevΔ × tod × res (81 ctx)", ...a4r });

const a4r8 = evalScheme(chains, N_DBUCKET * 8 * nRes + 1, (c, i) =>
  c.prevB[i] < 0 ? N_DBUCKET * 8 * nRes : (c.prevB[i] * 8 + todUniform(c.mid[i], 8)) * nRes + resPos[c.res]);
rows.push({ label: "A4r prevΔ × tod8u × res (161 ctx)", ...a4r8 });

// ── Report ───────────────────────────────────────────────────────────────────────

console.log(`\nHeld-out bits/period (5-fold by location; escape +${ESCAPE_BITS}b payload included)`);
console.log(`${"rung".padEnd(34)} overall   ${RES_IDXS.map((r) => RES_LABEL[r].padStart(6)).join(" ")}`);
for (const row of rows) {
  const overall = sum(RES_IDXS.map((r) => row.bits[r])) / sum(RES_IDXS.map((r) => row.n[r]));
  const perRes = RES_IDXS.map((r) => (row.bits[r] / row.n[r]).toFixed(3).padStart(6)).join(" ");
  console.log(`${row.label.padEnd(34)} ${overall.toFixed(3).padStart(7)}   ${perRes}`);
}

// Per-fold paired comparison for the contenders: is the A4r-over-A3r gap consistent or noise?
// Folds split by location, so each column is one independent draw of "different geography".
console.log(`\nPer-fold overall b/period (paired; consistent sign across folds ⇒ not noise):`);
const contenders: [string, ReturnType<typeof evalScheme>][] = [
  ["A3r tod4 × res", a3r],
  ...Object.entries(a3rU).map(([n, v]) => [`A3r tod${n}u × res`, v] as [string, ReturnType<typeof evalScheme>]),
  ["A4r prevΔ × tod4 × res", a4r],
  ["A4r prevΔ × tod8u × res", a4r8],
];
console.log(`${"rung".padEnd(28)} ${Array.from({ length: N_FOLDS }, (_, f) => `fold${f}`.padStart(7)).join(" ")}`);
for (const [label, v] of contenders) {
  console.log(`${label.padEnd(28)} ${v.foldBpp.map((b) => b.toFixed(3).padStart(7)).join(" ")}`);
}

console.log(`\nTraining occupancy (mean symbols/context over folds; low counts → untrustworthy rung):`);
for (const row of rows) {
  if (!row.occupancy) continue;
  const occ = row.occupancy.map((o) => Math.round(o / N_FOLDS));
  console.log(`  ${row.label}: min=${Math.min(...occ)} median=${occ.slice().sort((a, b) => a - b)[occ.length >> 1]} max=${Math.max(...occ)}`);
}
