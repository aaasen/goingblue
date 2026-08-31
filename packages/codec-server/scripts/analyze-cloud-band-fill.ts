/**
 * The acceptance check for the cloud-band correction (docs/private/Cloud Band Correction.md).
 *
 * THE SYMPTOM. The cloud band's eight `cloud_cover_XhPa` levels are not model cloud: they are
 * Open-Meteo's own Sundqvist (1989) diagnostic over gridbox-mean relative humidity, and it has a
 * hard floor at each level's critical humidity. Stack the encoder's 3-bit deadband on top and the
 * band frequently renders empty for hours the weathercode calls cloudy. fillCloudBand
 * (src/forecast.ts) takes MAGNITUDE from the model's own low/mid/high trio and uses humidity only
 * for vertical PLACEMENT. This script measures whether that works.
 *
 * READ SECTION C, NOT SECTION B. The conflict and recovery rates quoted in the plan are hourly
 * and pre-quantization, which is where the mechanism is legible but not where the user lives. The
 * wire carries per-period `maxOf` aggregates through `quantCover`, and:
 *   - aggregation HELPS the baseline (a period is all-zero less often than any single hour), so
 *     the shipped conflict rate is lower than the hourly one and the improvement reads smaller;
 *   - quantization HURTS the fill (a synthesized value under 50/7 % encodes as clear anyway).
 * Section C measures through both. That post-wire number is the honest one.
 *
 * Section A is the evidence for the variable swap: production stopped fetching the eight
 * `cloud_cover_XhPa` and fetches `relative_humidity_XhPa` instead, on the claim that one is
 * exactly a function of the other. If section A ever stops reporting ~100% exact, Open-Meteo has
 * changed the diagnostic and §6 of the plan no longer holds.
 *
 * Runs held-out (eval split): the sites in section C's periods never trained a codebook.
 *
 * The eval split is 30,236 cells and the scan is I/O-bound on a 32 GB corpus, so it SUBSAMPLES by
 * default — `--stride N` keeps one cell in N, via eachForecast's shard argument, which skips
 * before loadCell rather than after (a filter in the callback would still pay for every read).
 * The default stride of 50 lands ~600 windows, the sample size every figure in the plan was
 * measured at, in a couple of minutes. `--stride 1` scans the whole split.
 *
 *   pnpm exec tsx packages/codec-server/scripts/analyze-cloud-band-fill.ts
 *   pnpm exec tsx packages/codec-server/scripts/analyze-cloud-band-fill.ts --stride 10
 */
import {
  fillCloudBand, rhCritical, rowsFromWindows, sundqvistCover, toFullPeriod,
  HOURS_PER_PERIOD, type HourlyData,
} from "../src/forecast.ts";
import { CLOUD_BAND_LEVELS_HPA, VARS_BIT, quantCover } from "@weather/protocol";
import { DERIVE_VARS, eachForecast } from "./derive-lib.ts";

const LEVELS = CLOUD_BAND_LEVELS_HPA;
const NL = LEVELS.length;
const CLOUD_VARS = LEVELS.map((l) => `cloud_cover_${l}hPa`);
const RH_VARS = LEVELS.map((l) => `relative_humidity_${l}hPa`);
const RES_IDXS = [1, 2, 3, 4]; // 12h/6h/3h/1h — the resolutions layouts actually emit
const BAND_MASK = 1 << VARS_BIT.cch;

const args = process.argv.slice(2);
const stride = Math.max(1, Number(args[args.indexOf("--stride") + 1]) || 50);

// DERIVE_VARS already carries all three level families (the band codebooks train on them), so
// the default load is enough. What this scan must NOT take is eachForecast's own fillCloudBand:
// sections A–C measure the fill by comparing before against after, and a pre-filled cell would
// have it validating its own output. Hence `fillBand: false` on the call below.

// A code that implies cloud. WMO 0/1 are clear and mainly-clear; everything from 2 up is partly
// cloudy or worse, including every precipitating and fog code. This is the same coarse proxy the
// plan scores against, and it IS coarse — see §8: it comes from averaged WMO codes, not from
// cloud percentages, so "false cloud" here means "cloud the weathercode ladder didn't reflect",
// not "cloud the model didn't forecast".
const isCloudy = (code: number | null | undefined) => code != null && code >= 2;
const isClear = (code: number | null | undefined) => code != null && code < 2;

const pct = (num: number, den: number) => den === 0 ? "  —  " : (100 * num / den).toFixed(2).padStart(5);
const row = (label: string, cells: string[]) => console.log(`  ${label.padEnd(34)}${cells.join("")}`);

// ── A: is `cloud_cover_XhPa` really Sundqvist(`relative_humidity_XhPa`)? ───────────────────────
const provExact = new Float64Array(NL);
const provErr = new Float64Array(NL);
const provN = new Float64Array(NL);

// ── B: hourly, pre-quantization ───────────────────────────────────────────────────────────────
interface HourStats {
  hours: number; cloudy: number; clear: number;
  empty: number; emptyCloudy: number;   // band all-zero (post-quantCover)
  lit: number; litHours: number;        // mean lit levels over hours with any cloud
  falseCloud: number;                   // band non-empty on a clear-weathercode hour
  topLit: number;                       // 300 hPa slot lights
}
const hourly0: HourStats = blankHours(), hourly1: HourStats = blankHours();
function blankHours(): HourStats {
  return { hours: 0, cloudy: 0, clear: 0, empty: 0, emptyCloudy: 0, lit: 0, litHours: 0, falseCloud: 0, topLit: 0 };
}

// ── C: post-quantization, post-aggregation — the acceptance check ─────────────────────────────
// Keyed by resolution, since the aggregation window is what makes an all-zero period rarer than
// an all-zero hour, and the layouts mix resolutions.
interface PeriodStats { periods: number; cloudy: number; clear: number; empty: number; emptyCloudy: number; falseCloud: number; lit: number; litPeriods: number; topLit: number }
const blankPeriods = (): PeriodStats =>
  ({ periods: 0, cloudy: 0, clear: 0, empty: 0, emptyCloudy: 0, falseCloud: 0, lit: 0, litPeriods: 0, topLit: 0 });
const period0 = new Map(RES_IDXS.map((r) => [r, blankPeriods()]));
const period1 = new Map(RES_IDXS.map((r) => [r, blankPeriods()]));

function countHours(h: HourlyData, wc: (number | null)[], s: HourStats): void {
  const cols = CLOUD_VARS.map((v) => h[v] as (number | null)[] | undefined);
  for (let i = 0; i < h.time.length; i++) {
    let lit = 0;
    for (let li = 0; li < NL; li++) if (quantCover(cols[li]?.[i] ?? 0) > 0) lit++;
    s.hours++;
    if (lit === 0) s.empty++; else { s.lit += lit; s.litHours++; }
    if (quantCover(cols[0]?.[i] ?? 0) > 0) s.topLit++;
    if (isCloudy(wc[i])) { s.cloudy++; if (lit === 0) s.emptyCloudy++; }
    else if (isClear(wc[i])) { s.clear++; if (lit > 0) s.falseCloud++; }
  }
}

// The band exactly as the wire carries it: maxOf over the period's hours (rowsFromWindows),
// hole-bridged (repairCloudBand, via toFullPeriod), then quantized by the encoder.
function countPeriods(h: HourlyData, windows: number[][], off: number, s: PeriodStats): void {
  // toFullPeriod already runs repairCloudBand over the aggregated stack, so cloud_band here is
  // exactly the eight values the encoder quantizes.
  const periods = rowsFromWindows(h, h.time, windows, off).map((r) => toFullPeriod(r, BAND_MASK, "US"));
  for (let p = 0; p < periods.length; p++) {
    const stack = periods[p].cloud_band ?? [];
    let lit = 0;
    for (let li = 0; li < NL; li++) if (quantCover(stack[li]) > 0) lit++;
    // The period's weathercode is already the coverage-aware aggregate (aggregateWeathercode).
    const code = periods[p].weathercode;
    s.periods++;
    if (lit === 0) s.empty++; else { s.lit += lit; s.litPeriods++; }
    if (quantCover(stack[0]) > 0) s.topLit++;
    if (isCloudy(code)) { s.cloudy++; if (lit === 0) s.emptyCloudy++; }
    else if (isClear(code)) { s.clear++; if (lit > 0) s.falseCloud++; }
  }
}

let cells = 0;
await eachForecast((raw, _startHour, _loc, pos) => {
  const wc = raw.weather_code as (number | null)[] | undefined;
  if (!wc || !pos) return;
  // Section A first — on the RAW cell, before the fill overwrites the served diagnostic.
  const served = CLOUD_VARS.map((v) => raw[v] as (number | null)[] | undefined);
  const rh = RH_VARS.map((v) => raw[v] as (number | null)[] | undefined);
  if (served.every((c) => c == null) || rh.every((c) => c == null)) return;
  cells++;
  for (let li = 0; li < NL; li++) {
    const crit = rhCritical(LEVELS[li]);
    for (let i = 0; i < raw.time.length; i++) {
      const r = rh[li]?.[i], c = served[li]?.[i];
      if (r == null || c == null) continue;
      const err = Math.abs(sundqvistCover(r, crit) - c);
      provN[li]++; provErr[li] += err;
      if (err <= 0.5) provExact[li]++;
    }
  }

  const filled = fillCloudBand(raw);
  countHours(raw, wc, hourly0);
  countHours(filled, wc, hourly1);

  // Production's window construction: local-midnight-justified, whole periods only. Same as the
  // other held-out scans (analyze-wc-aggregation-heldout.ts).
  const off = Math.round(pos.lon / 15);
  const dataStart = Math.floor(Date.parse(`${raw.time[0]}:00Z`) / 3600000);
  const dataEnd = dataStart + raw.time.length;
  for (const res of RES_IDXS) {
    const hpp = HOURS_PER_PERIOD[res];
    const firstUtc = Math.ceil((dataStart + off) / 24) * 24 - off;
    const n = Math.floor((dataEnd - firstUtc) / hpp);
    if (n < 3) continue;
    const windows: number[][] = [];
    for (let p = 0; p < n; p++) {
      const w: number[] = [];
      for (let eh = firstUtc + p * hpp; eh < firstUtc + (p + 1) * hpp; eh++) w.push(eh - dataStart);
      windows.push(w);
    }
    countPeriods(raw, windows, off, period0.get(res)!);
    countPeriods(filled, windows, off, period1.get(res)!);
  }
}, "eval", DERIVE_VARS, { index: 0, total: stride }, false);

console.log(`\ncloud-band fill — ${cells} eval cells (1 in ${stride}), ` +
  `${hourly0.hours.toLocaleString()} hours\n`);

console.log("A. cloud_cover_XhPa vs Sundqvist(relative_humidity_XhPa)");
console.log("   If this stops reading ~100% exact, the variable swap in forecast.ts is unsound.");
row("level", LEVELS.map((l) => String(l).padStart(8)));
row("exact (±0.5 pp) %", LEVELS.map((_, li) => pct(provExact[li], provN[li]).padStart(8)));
row("mean abs err (pp)", LEVELS.map((_, li) =>
  (provN[li] ? (provErr[li] / provN[li]).toFixed(3) : "—").padStart(8)));

const hourRows: [string, (s: HourStats) => string][] = [
  ["band empty, % of all hours", (s) => pct(s.empty, s.hours)],
  ["band empty, % of cloudy hours", (s) => pct(s.emptyCloudy, s.cloudy)],
  ["false cloud, % of clear hours", (s) => pct(s.falseCloud, s.clear)],
  ["lit levels, mean of non-empty", (s) => (s.litHours ? s.lit / s.litHours : 0).toFixed(2).padStart(5)],
  ["top slot lit, % of hours", (s) => pct(s.topLit, s.hours)],
];
console.log("\nB. hourly, post-quantization — the mechanism, NOT the shipped number");
row("", ["  before", "   after"]);
for (const [label, f] of hourRows) row(label, [`  ${f(hourly0)}`, `  ${f(hourly1)}`]);
console.log(`  recovery of empty-on-cloudy hours: ` +
  `${pct(hourly0.emptyCloudy - hourly1.emptyCloudy, hourly0.emptyCloudy)}%`);

console.log("\nC. per period, through maxOf + repairCloudBand + quantCover — THE ACCEPTANCE CHECK");
const periodRows: [string, (s: PeriodStats) => string][] = [
  ["band empty, % of all periods", (s) => pct(s.empty, s.periods)],
  ["band empty, % of cloudy periods", (s) => pct(s.emptyCloudy, s.cloudy)],
  ["false cloud, % of clear periods", (s) => pct(s.falseCloud, s.clear)],
  ["lit levels, mean of non-empty", (s) => (s.litPeriods ? s.lit / s.litPeriods : 0).toFixed(2).padStart(5)],
  ["top slot lit, % of periods", (s) => pct(s.topLit, s.periods)],
];
for (const res of RES_IDXS) {
  const a = period0.get(res)!, b = period1.get(res)!;
  if (a.periods === 0) continue;
  console.log(`\n  ${HOURS_PER_PERIOD[res]}h periods (${a.periods.toLocaleString()})`);
  row("", ["  before", "   after"]);
  for (const [label, f] of periodRows) row(label, [`  ${f(a)}`, `  ${f(b)}`]);
  console.log(`    recovery of empty-on-cloudy periods: ` +
    `${pct(a.emptyCloudy - b.emptyCloudy, a.emptyCloudy)}%`);
}
