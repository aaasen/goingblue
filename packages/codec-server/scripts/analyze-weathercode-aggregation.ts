/**
 * Sizing scan for a coverage-aware weathercode aggregation. READ-ONLY: derives no codebooks and
 * touches no wire format — it measured the corpus so the aggregation rule's thresholds could be
 * chosen from data instead of guessed. The rule it motivated now ships in src/weathercode.ts;
 * this scan still measures the OLD `maxOf` baseline (computed inline), so its numbers remain the
 * before-picture and can be re-run against a grown corpus.
 *
 * The former aggregation was `maxOf(hourly codes)`, i.e. the numerically highest WMO code in the
 * window wins. Two consequences this scan sized:
 *
 *   1. Winner-take-all over-reports. One hour of heavy snow in an otherwise clear 12h window
 *      summarizes as 75 "heavy snow" rather than 85 "snow showers" — even though 85 is already the
 *      alphabet's intermittent form AND already renders with sun behind the cloud
 *      (glyphSpec's `sky: shower ? 'partly' : 'overcast'`, packages/mobile/weatherGlyph.ts).
 *      So the fix is an aggregation rule, not a new symbol: pick the shower form when coverage is
 *      low. Sections B/C size the coverage distribution and the mis-summarized population.
 *
 *   2. Numeric order is not severity order. 80/81/82 (rain showers) outrank 71/73/75 (snow) and
 *      77 (snow grains) outranks 75 (heavy snow), so a mixed rain/snow window resolves to rain —
 *      the wrong phase in exactly the shoulder-season mountain case. The alphabet has no
 *      mixed-phase symbol at all; WMO 4677 defines 68/69 (rain-or-drizzle and snow mixed, slight /
 *      moderate-heavy) and Open-Meteo never emits them. Section D sizes that gap (does it earn two
 *      of the four free symbol slots below 32?), section F sizes the inversions.
 *
 * Section E addresses the third leg: intensity should come from the window's accumulation, not
 * from the peak hour's code, so the summary agrees with the snow_cm/rain_mm shipped beside it.
 * It reports accumulation RATE (per hour, resolution-independent) per emitted code, which is the
 * table the intensity thresholds get read off.
 *
 *   pnpm exec tsx packages/codec-server/scripts/analyze-weathercode-aggregation.ts
 */
import { rowsFromWindows, HOURS_PER_PERIOD, type HourlyData } from "../src/forecast.ts";
import { WMO_CODES } from "@weather/protocol";
import { eachForecast } from "./derive-lib.ts";

// 12h/6h/3h are where an aggregation rule has anything to decide; 1h is included for reference
// only — a one-hour window has coverage 0 or 1, so every candidate rule degenerates to
// pass-through there (and 1h is the resolution today's codebooks are trained at).
const RES_IDXS = [1, 2, 3, 4];
const RES_LABEL: Record<number, string> = { 1: "12h", 2: "6h", 3: "3h", 4: "1h" };
const MAX_PERIODS = 128; // matches derive-weathercode-codebooks.ts

// eachForecast loads only these series. weather_code/rain/showers/snowfall are what this scan
// reads; temperature_2m and freezing_level_height are required because eachForecast runs
// adjustPrecipPhase before the callback — omit them and the phase correction silently no-ops,
// so the scan would measure a rain/snow split production never encodes.
const SCAN_VARS = [
  "weather_code", "rain", "showers", "snowfall",
  "temperature_2m", "freezing_level_height",
];

// ── Code classification ─────────────────────────────────────────────────────────
// Finer than protocol's WEATHERCODE_CLASS (which folds thunder into rain-ish and is indexed by
// symbol index, not raw code) because the aggregation rule needs thunder and freezing held out
// as their own winner-take-all cases.
const DRIZZLE = new Set([51, 53, 55]);
const RAIN_CONT = new Set([61, 63, 65]);
const SNOW_CONT = new Set([71, 73, 75, 77]);
const RAIN_SHWR = new Set([80, 81, 82]);
const SNOW_SHWR = new Set([85, 86]);
const FREEZING = new Set([56, 57, 66, 67]);
const THUNDER = new Set([95, 96, 99]);
const FOG = new Set([45, 48]);

type Phase = "dry" | "rain" | "snow" | "freezing" | "thunder";
function phaseOf(code: number): Phase {
  if (THUNDER.has(code)) return "thunder";
  if (FREEZING.has(code)) return "freezing";
  if (SNOW_CONT.has(code) || SNOW_SHWR.has(code)) return "snow";
  if (DRIZZLE.has(code) || RAIN_CONT.has(code) || RAIN_SHWR.has(code)) return "rain";
  return "dry";
}
const isWet = (code: number): boolean => phaseOf(code) !== "dry";
const isShowerForm = (code: number): boolean => RAIN_SHWR.has(code) || SNOW_SHWR.has(code);
const isContinuousForm = (code: number): boolean =>
  DRIZZLE.has(code) || RAIN_CONT.has(code) || SNOW_CONT.has(code);

// Mirrors codeSeverity() in packages/mobile/Meteogram.tsx:199 — the ranking the CLIENT already
// uses to collapse several periods into one day glyph, and which the server's numeric max
// disagrees with. Kept as a local copy so this scan doesn't import from the mobile package.
function codeSeverity(code: number): number {
  if (code >= 95) return 100;
  if (SNOW_CONT.has(code) || SNOW_SHWR.has(code) || FREEZING.has(code)) return 90;
  if (DRIZZLE.has(code) || RAIN_CONT.has(code) || RAIN_SHWR.has(code)) return 80;
  if (FOG.has(code)) return 40;
  return code === 0 ? 0 : code === 1 ? 2.5 : code === 2 ? 5.5 : 9.5;
}

// codeSeverity is PHASE-granular only — every rain code scores 80, every snow code 90 — so ranking
// by it alone leaves intensity tied, and the winner would be whichever code happened to come first
// in the window. That tie-break noise swamps the real signal (a first pass reported 12% of 12h
// periods "inverted", almost all of it 53→51 and 63→51: same phase, arbitrary order). Rank by
// (severity, intensity, code) so ties resolve deterministically toward the stronger code, and
// report the cross-PHASE disagreements separately — those are the only ones that mean anything.
function intensityOf(code: number): 1 | 2 | 3 {
  if ([51, 56, 61, 66, 71, 80, 85, 96].includes(code)) return 1;
  if ([53, 63, 73, 81].includes(code)) return 2;
  if ([55, 57, 65, 67, 75, 82, 86, 99].includes(code)) return 3;
  return 2;
}
const severityRank = (code: number): number => codeSeverity(code) * 10 + intensityOf(code);

// ── Accumulation rate bins (per hour, so a 12h and a 3h window are comparable) ───
// Upper bounds; the last bin is open. Snow in cm/h, rain in mm/h.
const RATE_BINS = [0.01, 0.05, 0.1, 0.25, 0.5, 1, 2, 5, Infinity];
const RATE_LABEL = ["<.01", ".01-.05", ".05-.1", ".1-.25", ".25-.5", ".5-1", "1-2", "2-5", "5+"];
const rateBin = (r: number): number => RATE_BINS.findIndex((b) => r < b);

// Coverage buckets: fraction of the window's hours that were wet. Coverage is QUANTIZED to k/N
// for an N-hour window, so the distribution is a comb, not a smooth curve — eighth-width bins
// would leave structurally-empty columns that read as real zeros (they did in the first pass).
// Quarters land cleanly on the 1/3, 1/6 and 1/12 combs, and fully-wet is split out on its own
// because "was it wet the whole window" is the actual continuous-vs-shower decision boundary.
const COV_BINS = [0.25, 0.5, 0.75, 0.9999, Infinity];
const COV_LABEL = ["0-¼", "¼-½", "½-¾", "¾-<1", "ALL WET"];
const covBin = (f: number): number => COV_BINS.findIndex((b) => f <= b);

// ── Accumulators ────────────────────────────────────────────────────────────────
const zeros = (n: number): number[] => new Array<number>(n).fill(0);
const KNOWN = new Set(WMO_CODES);

interface ResStats {
  periods: number;
  wetPeriods: number;
  occupancy: Map<number, number>;      // emitted code → count
  unknownCodes: number;                // hourly codes outside WMO_CODES
  covByPhase: Map<Phase, number[]>;    // dominant wet phase → coverage histogram
  contCoverage: Map<"rain" | "snow", number[]>;  // continuous-form emissions → coverage histogram
  shwrCoverage: Map<"rain" | "snow", number[]>;  // shower-form emissions → coverage histogram
  mixedAny: number;                    // wet periods with ≥1 rain hour AND ≥1 snow hour
  mixedStrong: number;                 // ...and the minority phase is ≥25% of wet hours
  mixedEmitted: Map<number, number>;   // what max() currently emits for the strong-mixed periods
  rateByCode: Map<number, number[]>;   // emitted code → accumulation-rate histogram
  inversions: number;                  // numeric max ≠ severity-ranked max
  inversionPairs: Map<string, number>; // "numeric→severity" → count
}

function newResStats(): ResStats {
  return {
    periods: 0, wetPeriods: 0, occupancy: new Map(), unknownCodes: 0,
    covByPhase: new Map(), contCoverage: new Map(), shwrCoverage: new Map(),
    mixedAny: 0, mixedStrong: 0, mixedEmitted: new Map(),
    rateByCode: new Map(), inversions: 0, inversionPairs: new Map(),
  };
}

const bump = <K,>(m: Map<K, number>, k: K, by = 1): void => { m.set(k, (m.get(k) ?? 0) + by); };
function hist<K>(m: Map<K, number[]>, k: K, n: number): number[] {
  let h = m.get(k);
  if (!h) { h = zeros(n); m.set(k, h); }
  return h;
}

const stats = new Map<number, ResStats>(RES_IDXS.map((r) => [r, newResStats()]));

// Mirrors the window construction in aggregateHourly (src/forecast.ts) — local-date/hour keyed,
// anchored at the cell's start hour — so the windows this scan inspects are the ones production
// aggregates over. Returns the hourly indices per window; rowsFromWindows then produces the
// production Row (weathercode = max, snow_cm/rain_mm = sums) for each.
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
      const idx = windows[w];
      const codes: number[] = [];
      for (const i of idx) {
        const c = wc[i];
        if (c == null) continue;
        if (!KNOWN.has(c)) s.unknownCodes++;
        codes.push(c);
      }
      if (codes.length === 0) continue;

      // The FORMER `maxOf` aggregation. Computed here, not read off rows[w].weathercode:
      // rowsFromWindows now returns the coverage-aware rule this scan was written to motivate,
      // and reading it back would silently turn every "today's wire" column below into a
      // description of the new rule instead of the max baseline it is measuring against.
      const emitted = Math.max(...codes);
      s.periods++;
      bump(s.occupancy, emitted);

      // F — numeric max vs the client's severity ranking, counting only CROSS-PHASE disagreements
      // (same-phase differences are intensity, which codeSeverity does not rank — see severityRank).
      let sevBest = codes[0];
      for (const c of codes) if (severityRank(c) > severityRank(sevBest)) sevBest = c;
      if (phaseOf(sevBest) !== phaseOf(emitted)) {
        s.inversions++;
        bump(s.inversionPairs, `${emitted}(${phaseOf(emitted)})→${sevBest}(${phaseOf(sevBest)})`);
      }

      const wet = codes.filter(isWet);
      if (wet.length === 0) continue;
      s.wetPeriods++;

      const fWet = wet.length / codes.length;
      const cb = covBin(fWet);

      // Dominant wet phase, thunder and freezing first (they stay winner-take-all in the rule).
      const nSnow = wet.filter((c) => phaseOf(c) === "snow").length;
      const nRain = wet.filter((c) => phaseOf(c) === "rain").length;
      const nFrz = wet.filter((c) => phaseOf(c) === "freezing").length;
      const nThu = wet.filter((c) => phaseOf(c) === "thunder").length;
      const dominant: Phase =
        nThu > 0 ? "thunder" : nFrz > 0 ? "freezing" : nSnow > nRain ? "snow" : "rain";
      hist(s.covByPhase, dominant, COV_BINS.length)[cb]++;

      // B/C — coverage under the form actually emitted.
      if (isContinuousForm(emitted)) {
        const p = SNOW_CONT.has(emitted) ? "snow" : "rain";
        hist(s.contCoverage, p, COV_BINS.length)[cb]++;
      } else if (isShowerForm(emitted)) {
        const p = SNOW_SHWR.has(emitted) ? "snow" : "rain";
        hist(s.shwrCoverage, p, COV_BINS.length)[cb]++;
      }

      // D — mixed rain/snow in one window (the 68/69 case).
      if (nSnow > 0 && nRain > 0) {
        s.mixedAny++;
        if (Math.min(nSnow, nRain) / wet.length >= 0.25) {
          s.mixedStrong++;
          bump(s.mixedEmitted, emitted);
        }
      }

      // E — accumulation rate under the emitted code, per WET hour. Dividing by the whole window
      // instead would fold coverage back into the intensity number — the same 71 reads .05-.1 cm/h
      // at 1h but .01-.05 at 3h purely because the dry hours dilute it — and separating those two
      // axes is the entire point of the rule. Per wet hour, the rate is resolution-stable and the
      // 1h rows are the undiluted ground truth every coarser row should reproduce.
      const snowy = SNOW_CONT.has(emitted) || SNOW_SHWR.has(emitted);
      const rate = (snowy ? rows[w].snow_cm : rows[w].rain_mm) / wet.length;
      if (isWet(emitted)) hist(s.rateByCode, emitted, RATE_BINS.length)[rateBin(rate)]++;
    }
  }
}

// ── Reporting ───────────────────────────────────────────────────────────────────
const pctStr = (n: number, d: number): string => (d === 0 ? "  -  " : `${((100 * n) / d).toFixed(1)}%`);
const row = (label: string, h: number[], width = 8): string => {
  const total = h.reduce((a, b) => a + b, 0);
  const cells = h.map((v) => pctStr(v, total).padStart(width));
  return `${label.padEnd(14)}${cells.join("")}  n=${total}`;
};

function report(): void {
  for (const res of RES_IDXS) {
    const s = stats.get(res)!;
    const L = RES_LABEL[res];
    console.log(`\n${"═".repeat(88)}\n  RESOLUTION ${L}   periods=${s.periods}  wet=${s.wetPeriods} (${pctStr(s.wetPeriods, s.periods)})` +
      (s.unknownCodes ? `  UNKNOWN HOURLY CODES=${s.unknownCodes}` : ""));

    console.log(`\n  A. Emitted symbol occupancy (max aggregation, today's wire)`);
    const occ = [...s.occupancy.entries()].sort((a, b) => b[1] - a[1]);
    const occTotal = occ.reduce((a, [, c]) => a + c, 0);
    console.log("     " + occ.map(([c, n]) => `${c}:${pctStr(n, occTotal)}`).join("  "));
    const dead = WMO_CODES.filter((c) => (s.occupancy.get(c) ?? 0) / (occTotal || 1) < 0.0005);
    console.log(`     symbols under 0.05% of emissions: ${dead.length ? dead.join(", ") : "none"}`);

    console.log(`\n  B. Wet-hour coverage by dominant phase (fraction of the window that was wet)`);
    console.log(`     ${"".padEnd(11)}${COV_LABEL.map((l) => l.padStart(8)).join("")}`);
    for (const p of ["rain", "snow", "freezing", "thunder"] as Phase[]) {
      const h = s.covByPhase.get(p);
      if (h) console.log("     " + row(p, h));
    }

    console.log(`\n  C. Coverage under the form max() actually emitted`);
    console.log(`     (continuous form at low coverage = the "heavy snow for 1 of 12 hours" population)`);
    console.log(`     ${"".padEnd(11)}${COV_LABEL.map((l) => l.padStart(8)).join("")}`);
    for (const p of ["rain", "snow"] as const) {
      const h = s.contCoverage.get(p);
      if (h) {
        const total = h.reduce((a, b) => a + b, 0);
        const below = (k: number) => h.slice(0, k).reduce((a, b) => a + b, 0);
        console.log("     " + row(`cont ${p}`, h));
        console.log(`     ${"".padEnd(14)}↳ ≤¼ coverage: ${pctStr(below(1), total)}   ≤½: ${pctStr(below(2), total)}   not fully wet: ${pctStr(below(4), total)}`);
      }
    }
    for (const p of ["rain", "snow"] as const) {
      const h = s.shwrCoverage.get(p);
      if (h) console.log("     " + row(`shower ${p}`, h));
    }

    console.log(`\n  D. Mixed rain/snow in one window (the 68/69 case)`);
    console.log(`     any overlap:       ${s.mixedAny} = ${pctStr(s.mixedAny, s.wetPeriods)} of wet periods, ${pctStr(s.mixedAny, s.periods)} of all`);
    console.log(`     minority ≥25%:     ${s.mixedStrong} = ${pctStr(s.mixedStrong, s.wetPeriods)} of wet periods, ${pctStr(s.mixedStrong, s.periods)} of all`);
    const me = [...s.mixedEmitted.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8);
    console.log(`     max() emits for those: ` +
      me.map(([c, n]) => `${c}(${phaseOf(c)}):${pctStr(n, s.mixedStrong)}`).join("  "));

    console.log(`\n  E. Accumulation rate per emitted code — snow cm per wet hour, rain mm per wet hour`);
    console.log(`     (intensity thresholds get read off this; per WET hour, so coverage is not folded in`);
    console.log(`      and every resolution should reproduce the 1h rows)`);
    console.log(`     ${"".padEnd(11)}${RATE_LABEL.map((l) => l.padStart(8)).join("")}`);
    const wetCodes = WMO_CODES.filter((c) => isWet(c) && s.rateByCode.has(c));
    for (const c of wetCodes) console.log("     " + row(`${c} ${phaseOf(c)}`, s.rateByCode.get(c)!));

    console.log(`\n  F. Numeric max vs severity ranking — CROSS-PHASE disagreements only`);
    console.log(`     (same-phase differences are intensity, which codeSeverity does not rank)`);
    console.log(`     disagree: ${s.inversions} = ${pctStr(s.inversions, s.periods)} of periods, ${pctStr(s.inversions, s.wetPeriods)} of wet`);
    const inv = [...s.inversionPairs.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8);
    console.log(`     top pairs (max→severity): ` + inv.map(([k, n]) => `${k}:${pctStr(n, s.inversions)}`).join("  "));
  }
  console.log();
}

console.log("Scanning corpus (train split) for weathercode aggregation sizing…");
await eachForecast((h, startHour) => scanCell(h, startHour), "train", SCAN_VARS);
report();
