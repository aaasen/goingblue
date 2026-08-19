/**
 * Sizing scan for an AMOUNT-aware mixed-phase (68/69) gate. READ-ONLY: derives no codebooks and
 * touches no wire format — it measured the corpus so the gate's thresholds could be chosen from
 * data instead of guessed. The arm it motivated now ships in src/weathercode.ts, and this scan
 * reads "shipped" off rowsFromWindows — so on a re-run the conversion grid (section C) prices
 * candidates against the CURRENT rule, amount arm included, and the recommended point reads ~0.
 * Its 2026-08-19 numbers against the code-count-only rule are the before-picture of record.
 *
 * The shipped rule (src/weathercode.ts step 3) decides mixed by counting hourly CODES: the
 * minority phase needs ≥ MIX_FRAC of the wet hours' codes. But an hourly weathercode is
 * single-valued — the model tags each borderline hour with only its dominant phase — so a window
 * where every hour is "mostly snow, some rain" carries zero rain-coded hours and resolves to pure
 * snow, even while rain_mm accumulates visibly in the same period's own row. (Seen in the field:
 * Patagonia at ~0–2 °C, snow icons over a rain row reading 0.5–4 mm per period.)
 *
 * Candidate gate, OR-ed with the code-count arm: compare the phases in water equivalent
 * (snowWE = snow_cm / SNOW_CM_PER_MM, the same 7:1 convention adjustPrecipPhase converts at) and
 * emit 68/69 when the minority phase holds ≥ SHARE of the window's total WE and clears an
 * absolute FLOOR in mm, so trace amounts don't flip icons. Symmetric, like the code gate.
 *
 * Sections:
 *   A. Populations — wet step-3 windows, both-phase-by-amount windows, already-68/69 windows.
 *   B. Minority-share histogram over both-phase windows (is 25% a natural knee in WE space?).
 *   C. SHARE × FLOOR conversion grid — % of wet periods NEWLY converted (amount arm fires,
 *      shipped rule did not emit 68/69). The table the two constants get read off.
 *   D. At the recommended point (share ≥ MIX_FRAC, floor 0.2 mm): what the shipped rule emits
 *      today for the converted windows, which phase was the minority (rain-under-snow is the
 *      field case), the 68 vs 69 split under the existing MIX_HEAVY_MM rate rule, and the
 *      combined 68/69 occupancy after the change.
 *
 *   pnpm exec tsx packages/codec-server/scripts/analyze-wc-amount-mix.ts
 */
import { rowsFromWindows, HOURS_PER_PERIOD, type HourlyData } from "../src/forecast.ts";
import { MIX_FRAC, MIX_HEAVY_MM, WMO_MIX_LIGHT, WMO_MIX_HEAVY } from "../src/weathercode.ts";
import { eachForecast } from "./derive-lib.ts";

const RES_IDXS = [1, 2, 3, 4];
const RES_LABEL: Record<number, string> = { 1: "12h", 2: "6h", 3: "3h", 4: "1h" };
const MAX_PERIODS = 128; // matches derive-weathercode-codebooks.ts

// weather_code/rain/showers/snowfall are what this scan reads; temperature_2m and
// freezing_level_height are required because eachForecast runs adjustPrecipPhase before the
// callback — omit them and the phase correction silently no-ops, so the scan would measure a
// rain/snow split production never encodes.
const SCAN_VARS = [
  "weather_code", "rain", "showers", "snowfall",
  "temperature_2m", "freezing_level_height",
];

// Open-Meteo's snow:liquid convention (1 mm WE = 0.7 cm snow) — matches SNOW_CM_PER_MM in both
// src/weathercode.ts and src/forecast.ts, which do not export it.
const SNOW_CM_PER_MM = 0.7;

// Same family sets as src/weathercode.ts (not exported there).
const THUNDER = new Set([95, 96, 99]);
const FREEZING = new Set([56, 57, 66, 67]);
const SNOW_CODES = new Set([71, 73, 75, 77, 85, 86]);
const LIQUID_CODES = new Set([51, 53, 55, 61, 63, 65, 80, 81, 82]);
const isWet = (c: number): boolean =>
  THUNDER.has(c) || FREEZING.has(c) || SNOW_CODES.has(c) || LIQUID_CODES.has(c);

// The grid the constants get read off. SHARES includes MIX_FRAC itself; FLOORS are absolute mm
// of minority-phase WE per window (0 = share test alone).
const SHARES = [0.10, 0.15, 0.20, 0.25, 0.30];
const FLOORS = [0, 0.05, 0.1, 0.2, 0.5, 1.0];
const REC_SHARE = MIX_FRAC;
const REC_FLOOR = 0.2;

// Minority-share bins (share of total WE; max is 0.5 by construction). Upper bounds, last open.
const SHARE_BINS = [0.05, 0.10, 0.15, 0.20, 0.25, 1 / 3, Infinity];
const SHARE_LABEL = ["<5%", "5-10", "10-15", "15-20", "20-25", "25-33", "33-50"];
const shareBin = (s: number): number => SHARE_BINS.findIndex((b) => s < b);

interface ResStats {
  periods: number;        // windows with ≥1 hourly code
  escaped: number;        // thunder/freezing hours present → step-1 escape, gate never reached
  wetPeriods: number;     // step-3 windows (≥1 wet hour, no escape)
  shippedMixed: number;   // shipped rule already emits 68/69 (the code-count arm)
  bothAmount: number;     // rainMm > 0 AND snowWE > 0
  shareHist: number[];    // minority-share histogram over bothAmount windows
  grid: number[][];       // [share][floor] → newly converted count
  recEmitted: Map<number, number>; // shipped code for windows the recommended point converts
  recRainMinor: number;   // converted with rain the minority (the field case)
  recSnowMinor: number;
  rec68: number;          // converted → 68 under the existing rate split
  rec69: number;
}

const zeros = (n: number): number[] => new Array<number>(n).fill(0);
const newResStats = (): ResStats => ({
  periods: 0, escaped: 0, wetPeriods: 0, shippedMixed: 0, bothAmount: 0,
  shareHist: zeros(SHARE_BINS.length),
  grid: SHARES.map(() => zeros(FLOORS.length)),
  recEmitted: new Map(), recRainMinor: 0, recSnowMinor: 0, rec68: 0, rec69: 0,
});
const bump = <K,>(m: Map<K, number>, k: K, by = 1): void => { m.set(k, (m.get(k) ?? 0) + by); };
const stats = new Map<number, ResStats>(RES_IDXS.map((r) => [r, newResStats()]));

// Mirrors the window construction in aggregateHourly (src/forecast.ts) — local-date/hour keyed,
// anchored at the cell's start hour — same as analyze-weathercode-aggregation.ts.
function windowsFor(times: string[], hoursPerPeriod: number, startEpochHour: number): number[][] {
  const anchorKey = new Date(startEpochHour * 3600000).toISOString().slice(0, 13);
  const windows: number[][] = [];
  const byKey = new Map<string, number[]>();
  for (let i = 0; i < times.length; i++) {
    const date = times[i].slice(0, 10);
    const hour = parseInt(times[i].slice(11, 13));
    const key = `${date}T${String(Math.floor(hour / hoursPerPeriod) * hoursPerPeriod).padStart(2, "0")}`;
    if (key < anchorKey) continue;
    if (!byKey.has(key)) {
      if (windows.length >= MAX_PERIODS) break;
      const w: number[] = [];
      byKey.set(key, w);
      windows.push(w);
    }
    byKey.get(key)!.push(i);
  }
  return windows;
}

function scanCell(h: HourlyData, startHour: number): void {
  const wc = h.weather_code as (number | null)[] | undefined;
  if (!wc) return;

  for (const res of RES_IDXS) {
    const s = stats.get(res)!;
    const windows = windowsFor(h.time, HOURS_PER_PERIOD[res], startHour);
    if (windows.length === 0) continue;
    const rows = rowsFromWindows(h, h.time, windows, 0);

    for (let w = 0; w < windows.length; w++) {
      const codes = windows[w].map((i) => wc[i]).filter((c): c is number => c != null);
      if (codes.length === 0) continue;
      s.periods++;

      // Step-1 escapes win before the mix gate would run; the amount arm never sees these.
      if (codes.some((c) => THUNDER.has(c) || FREEZING.has(c))) { s.escaped++; continue; }
      const wet = codes.filter(isWet);
      if (wet.length === 0) continue;
      s.wetPeriods++;

      const shipped = rows[w].weathercode; // the SHIPPED aggregation, code-count mix arm included
      const alreadyMixed = shipped === WMO_MIX_LIGHT || shipped === WMO_MIX_HEAVY;
      if (alreadyMixed) s.shippedMixed++;

      const rainMm = rows[w].rain_mm;
      const snowWE = rows[w].snow_cm / SNOW_CM_PER_MM;
      if (!(rainMm > 0 && snowWE > 0)) continue;
      s.bothAmount++;

      const minority = Math.min(rainMm, snowWE);
      const share = minority / (rainMm + snowWE);
      s.shareHist[shareBin(share)]++;

      if (!alreadyMixed) {
        for (let si = 0; si < SHARES.length; si++)
          for (let fi = 0; fi < FLOORS.length; fi++)
            if (share >= SHARES[si] && minority >= FLOORS[fi]) s.grid[si][fi]++;

        if (share >= REC_SHARE && minority >= REC_FLOOR) {
          bump(s.recEmitted, shipped ?? -1);
          if (rainMm < snowWE) s.recRainMinor++; else s.recSnowMinor++;
          // Same intensity split the shipped mix arm uses: total WE per wet hour vs MIX_HEAVY_MM.
          const rate = (rainMm + snowWE) / wet.length;
          if (rate < MIX_HEAVY_MM) s.rec68++; else s.rec69++;
        }
      }
    }
  }
}

// ── Reporting ───────────────────────────────────────────────────────────────────
const pctStr = (n: number, d: number): string => (d === 0 ? "  -  " : `${((100 * n) / d).toFixed(2)}%`);

function report(): void {
  for (const res of RES_IDXS) {
    const s = stats.get(res)!;
    console.log(`\n${"═".repeat(96)}\n  RESOLUTION ${RES_LABEL[res]}   periods=${s.periods}  escaped(thunder/frz)=${s.escaped}  wet(step-3)=${s.wetPeriods} (${pctStr(s.wetPeriods, s.periods)} of all)`);

    console.log(`\n  A. Populations`);
    console.log(`     both phases by AMOUNT:  ${s.bothAmount} = ${pctStr(s.bothAmount, s.wetPeriods)} of wet periods`);
    console.log(`     shipped already 68/69:  ${s.shippedMixed} = ${pctStr(s.shippedMixed, s.wetPeriods)} of wet (the code-count arm)`);

    console.log(`\n  B. Minority-phase share of total water equivalent (both-phase windows)`);
    console.log(`     ${SHARE_LABEL.map((l) => l.padStart(8)).join("")}`);
    const tot = s.shareHist.reduce((a, b) => a + b, 0);
    console.log(`     ${s.shareHist.map((v) => pctStr(v, tot).padStart(8)).join("")}  n=${tot}`);

    console.log(`\n  C. Newly converted → 68/69, % of WET periods (amount arm fires, shipped rule didn't)`);
    console.log(`     share\\floor${FLOORS.map((f) => `≥${f}mm`.padStart(9)).join("")}`);
    for (let si = 0; si < SHARES.length; si++) {
      const mark = SHARES[si] === REC_SHARE ? "▸" : " ";
      console.log(`    ${mark}≥${(SHARES[si] * 100).toFixed(0).padStart(2)}%      ` +
        s.grid[si].map((v) => pctStr(v, s.wetPeriods).padStart(9)).join(""));
    }

    const nRec = s.rec68 + s.rec69;
    console.log(`\n  D. Recommended point: share ≥ ${REC_SHARE}, minority ≥ ${REC_FLOOR} mm WE`);
    console.log(`     converts: ${nRec} = ${pctStr(nRec, s.wetPeriods)} of wet, ${pctStr(nRec, s.periods)} of all periods`);
    console.log(`     minority phase: rain-under-snow ${pctStr(s.recRainMinor, nRec)}   snow-under-rain ${pctStr(s.recSnowMinor, nRec)}`);
    console.log(`     intensity split: 68 ${pctStr(s.rec68, nRec)}   69 ${pctStr(s.rec69, nRec)}`);
    const em = [...s.recEmitted.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10);
    console.log(`     shipped rule emits today: ` + em.map(([c, n]) => `${c}:${pctStr(n, nRec)}`).join("  "));
    console.log(`     combined 68/69 after change: ${pctStr(s.shippedMixed + nRec, s.wetPeriods)} of wet periods`);
  }
  console.log();
}

console.log("Scanning corpus (train split) for amount-aware mixed-phase sizing…");
await eachForecast((h, startHour) => scanCell(h, startHour), "train", SCAN_VARS);
report();
