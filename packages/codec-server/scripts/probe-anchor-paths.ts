/**
 * Phase-0 anchor probe for the Detail/Auto/Range priority-mode redesign.
 *
 * Measures, on the corpus, the candidate refinement paths for each mode: every step is either an
 * extend-move (cover one more day slot @12h) or a refine-move (one slot, one rung finer), and the
 * probe walks each candidate path encoding every intermediate layout through the production
 * aggregation + codec (buildLayoutMessage → v3EncodeBreakdown). Per step it reports fit % against
 * the char budget, the chars distribution, and the marginal model bits vs the previous step — the
 * exchange-rate data that decides where extend-steps sit relative to refine-steps in each mode's
 * final anchor table.
 *
 *   pnpm exec tsx packages/codec-server/scripts/probe-anchor-paths.ts                 # eval split, 160c
 *   pnpm exec tsx packages/codec-server/scripts/probe-anchor-paths.ts --limit 100     # quick pass
 *   pnpm exec tsx packages/codec-server/scripts/probe-anchor-paths.ts --split all --max-chars 160
 *
 * Output: step tables per mode × combo on stdout, plus a timestamped record in data/benchmarks.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { buildLayoutMessage, type ForecastParams } from "../src/forecast.ts";
import {
  RESOLUTION_HOURS, VARS_BIT, v3EncodeBreakdown, V3_VERSION,
  type FillLayout, type ForecastMessage,
} from "@weather/protocol";
import { REPO_ROOT, dbLocations, listCells, loadCell, modelElevations, openDb } from "./corpus-db.ts";

// ── Probe frame ─────────────────────────────────────────────────────────────────

// The redesign's horizon: 12 whole days ahead → 13 day slots including the partial request day.
// 12d is the largest duration the 14d corpus windows can evaluate for every UTC offset (a
// duration D eats D+1 slots plus up to 23h of local-midnight alignment).
const DURATION_DAYS = 12;
const SLOTS = DURATION_DAYS + 1;
const MAX_PERIODS = 256; // V3_MAX_PERIODS — every candidate layout must stay under it

const SOURCE = "best_match"; // what production serves; the only source with the sampled strata
const MODEL_KEY = "BEST";    // center key for toFullPeriod (keeps every column)

const RUNG: Record<number, string> = Object.fromEntries(
  Object.entries(RESOLUTION_HOURS).map(([i, h]) => [i, `${h}h`]),
);

// A layout candidate: resolution index (1=12h … 4=1h) per covered day slot, front to back.
// Profiles are monotone non-increasing (finer never appears after coarser).
type Profile = number[];
const profKey = (p: Profile) => p.join("");

// Compact human label, e.g. "1h×2 3h×3 6h×3 12h×5".
function profLabel(p: Profile): string {
  const runs: string[] = [];
  for (let i = 0; i < p.length; ) {
    let j = i;
    while (j < p.length && p[j] === p[i]) j++;
    runs.push(`${RUNG[p[i]]}×${j - i}`);
    i = j;
  }
  return runs.join(" ");
}

// Mirrors layoutFor's period generation (protocol/src/layout.ts) for a hand-built profile: slot 0
// starts at the period containing the request time, later slots at local midnight. seq is a
// filler — probe messages are encoded for their size, never decoded.
function profileLayout(profile: Profile, requestUtcHour: number, utcOffsetHours: number): FillLayout {
  const local = requestUtcHour + utcOffsetHours;
  const day0 = Math.floor(local / 24) * 24;
  const periodHours: number[] = [];
  const periodStartUtcHour: number[] = [];
  for (let d = 0; d < profile.length; d++) {
    const h = RESOLUTION_HOURS[profile[d]];
    const dayStart = day0 + 24 * d;
    const first = d === 0 ? dayStart + Math.floor((local - dayStart) / h) * h : dayStart;
    for (let s = first; s < dayStart + 24; s += h) {
      periodHours.push(h);
      periodStartUtcHour.push(s - utcOffsetHours);
    }
  }
  if (periodHours.length > MAX_PERIODS)
    throw new Error(`profile ${profLabel(profile)}: ${periodHours.length} periods > ${MAX_PERIODS}`);
  return {
    seq: 1, mode: 1, // filler — probe messages are encoded for their size, never decoded
    days: profile.length, dayResolution: [...profile], periodHours, periodStartUtcHour,
  };
}

// ── Candidate paths ─────────────────────────────────────────────────────────────

interface Step { move: string; profile: Profile }

// The canonical interpolation rule (prototyping the Phase-1 table compiler): between anchors,
// repeatedly fix the leftmost slot below its target — extend with a 12h slot when the deficit is
// coverage, otherwise upgrade one rung. Only ever refines a prefix, so profiles stay monotone and
// period count strictly grows.
function interpolate(from: Profile, to: Profile): Step[] {
  for (let i = 0; i < from.length; i++) {
    if (to[i] === undefined || to[i] < from[i])
      throw new Error(`anchors not nested: ${profLabel(from)} → ${profLabel(to)}`);
  }
  const cur = [...from];
  const steps: Step[] = [];
  for (;;) {
    let s = -1;
    for (let i = 0; i < to.length; i++) {
      if (i >= cur.length || cur[i] < to[i]) { s = i; break; }
    }
    if (s === -1) break;
    if (s >= cur.length) {
      cur.push(1);
      steps.push({ move: `+day${cur.length - 1} @12h`, profile: [...cur] });
    } else {
      cur[s] += 1;
      steps.push({ move: `day${s} ${RUNG[cur[s] - 1]}→${RUNG[cur[s]]}`, profile: [...cur] });
    }
  }
  return steps;
}

function pathFromAnchors(anchors: Profile[]): Step[] {
  const steps: Step[] = [{ move: "(start)", profile: anchors[0] }];
  for (let a = 1; a < anchors.length; a++) steps.push(...interpolate(anchors[a - 1], anchors[a]));
  return steps;
}

const rep = (r: number, n: number) => Array(n).fill(r) as Profile;

// Candidate anchors per mode. These are shapes to MEASURE, not the final tables: the probe's
// step economics (fit % + marginal bits) decide what survives into the Phase-1 anchor lists.
// All paths share the [12h×3] near-term baseline; rungs past each top anchor exist in production
// (no caps) but sit beyond what any real budget reaches, so the probe stops there.
// Anchor revision 2 (Lane, 2026-07-22): Detail = 3 hourly days before coverage exceeds 5 slots;
// Auto = 7 slots @12h → 5 @3h → coverage to 10 → hourly refinement; Range = coverage-first.
const PATHS: Record<string, Profile[]> = {
  detail: [
    [1],
    [1, 1, 1],
    [4, 2, 1],                                   // today → 1h as early as possible
    [4, 4, 4, 1, 1],                             // 3d @1h, coverage capped at 5
    [4, 4, 4, 3, 3, 2, 2, 2, 1, 1, 1],           // taper outward
    [4, 4, 4, 3, 3, 2, 2, 2, 1, 1, 1, 1, 1],     // full 13
    [4, 4, 4, 4, 4, 3, 3, 3, 3, 3, 2, 2, 2],     // deepen hourly to 5d
    [...rep(4, 8), ...rep(3, 5)],                // frontier top: 8d @1h + 3h rest (<256 periods)
  ],
  auto: [
    [1],
    [1, 1, 1],
    rep(1, 7),                                   // 7 slots of 12h coverage
    [...rep(2, 5), 1, 1],                        // 6h breadth pass (smoother mid-shapes)
    [...rep(3, 5), 1, 1],                        // 5 slots @3h
    [...rep(3, 5), ...rep(1, 5)],                // coverage bumped to 10
    [4, ...rep(3, 4), ...rep(1, 5)],             // hourly refinement begins
    [4, 4, ...rep(3, 5), 2, 2, 2, 1, 1, 1],      // 2nd hourly day, 3h to day 7, full 13
    [...rep(4, 6), ...rep(3, 7)],
  ],
  range: [
    [1],
    [1, 1, 1],
    rep(1, SLOTS),                               // full 12d coverage before any refinement
    rep(2, SLOTS),
    rep(3, SLOTS),
    [...rep(4, 3), ...rep(3, 10)],
  ],
};

// ── Corpus plumbing (mirrors benchmark.ts report loading) ───────────────────────

const utcOffsetFor = (lon: number) => Math.max(-12, Math.min(14, Math.round(lon / 15)));

function requestUtcHourFor(windowStartUtcHour: number, utcOffsetHours: number, hour: number): number {
  const firstLocalMidnight = Math.ceil((windowStartUtcHour + utcOffsetHours) / 24) * 24;
  return firstLocalMidnight - utcOffsetHours + hour;
}

const REQUIRED_BASE: string[][] = [
  ["temperature_2m"], ["weather_code"], ["snowfall"], ["rain", "showers"], ["wind_speed_10m"],
];
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function baseComplete(h: any): boolean {
  const hasData = (v: string) => (h[v] as (number | null)[] | undefined)?.some((x) => x != null) ?? false;
  return REQUIRED_BASE.every((anyOf) => anyOf.some(hasData));
}

const BASE_MASK = ["precip", "temp", "snow", "rain", "wind"]
  .reduce((m, v) => m | (1 << VARS_BIT[v]), 0);
const ALL_MASK = [...Object.values(VARS_BIT)].reduce((m, b) => m | (1 << b), BASE_MASK);
const COMBOS: { id: string; mask: number }[] = [
  { id: "base", mask: BASE_MASK },
  { id: "all", mask: ALL_MASK },
];

// ── Measurement ─────────────────────────────────────────────────────────────────

interface Args { split: string; limit: number; sample: number; maxChars: number; requestHour: number }

function parseArgs(argv: string[]): Args {
  // --sample strides the cell list for an even spread over locations × windows (the list is
  // ordered by location then window); --limit takes a prefix (quick smoke tests only).
  const args: Args = { split: "eval", limit: 0, sample: 5000, maxChars: 160, requestHour: 7 };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--split") args.split = argv[++i];
    else if (a === "--limit") args.limit = parseInt(argv[++i], 10);
    else if (a === "--sample") args.sample = parseInt(argv[++i], 10); // 0 = every cell
    else if (a === "--max-chars") args.maxChars = parseInt(argv[++i], 10);
    else if (a === "--request-hour") args.requestHour = parseInt(argv[++i], 10);
    else throw new Error(`unknown arg ${a}`);
  }
  return args;
}

interface StepStats { fit: number; chars: number[]; dBits: number[] }

function main(): void {
  const args = parseArgs(process.argv);
  const db = openDb();
  const locs = dbLocations(db);
  const elevs = modelElevations(db, SOURCE);

  const cells = listCells(db, SOURCE).filter(({ locationId }) => {
    const loc = locs.get(locationId);
    return loc && (args.split === "all" || loc.split === args.split);
  });
  let limited = args.limit > 0 ? cells.slice(0, args.limit) : cells;
  if (args.sample > 0 && limited.length > args.sample) {
    const stride = limited.length / args.sample;
    limited = Array.from({ length: args.sample }, (_, i) => limited[Math.floor(i * stride)]);
  }

  // steps + running stats per mode × combo
  const modeSteps = new Map(Object.entries(PATHS).map(([m, a]) => [m, pathFromAnchors(a)]));
  const stats = new Map<string, StepStats[]>();
  for (const [m, steps] of modeSteps) for (const c of COMBOS) {
    stats.set(`${m}:${c.id}`, steps.map(() => ({ fit: 0, chars: [], dBits: [] })));
  }

  let used = 0, skipped = 0, uncovered = 0;

  const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : NaN);
  const p50 = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)] ?? NaN;
  const render = (): string => {
    const lines: string[] = [];
    lines.push(`anchor probe — ${used} forecasts (split: ${args.split}, sample ${args.sample || "all"} of ${cells.length}, skipped ${skipped}, uncovered ${uncovered})`);
    lines.push(`horizon ${DURATION_DAYS}d/${SLOTS} slots, budget ${args.maxChars}c, request ${args.requestHour}:00 local, source ${SOURCE}`);
    for (const [mode, steps] of modeSteps) for (const c of COMBOS) {
      const st = stats.get(`${mode}:${c.id}`)!;
      lines.push("");
      lines.push(`── ${mode.toUpperCase()} × ${c.id} ─────────────────────────────`);
      lines.push("  #  move                fit%   chars p50  Δbits mean  layout");
      for (let i = 0; i < steps.length; i++) {
        const fitPct = (100 * st[i].fit / used).toFixed(1).padStart(5);
        const ch = String(p50(st[i].chars)).padStart(6);
        const db_ = i === 0 ? "     —" : mean(st[i].dBits).toFixed(1).padStart(6);
        lines.push(`${String(i).padStart(3)}  ${steps[i].move.padEnd(18)} ${fitPct}  ${ch}      ${db_}      ${profLabel(steps[i].profile)}`);
      }
    }
    return lines.join("\n") + "\n";
  };

  const dir = join(REPO_ROOT, "data", "benchmarks");
  mkdirSync(dir, { recursive: true });
  const ts = new Date().toISOString().slice(0, 19).replace(/:/g, "-");
  const file = join(dir, `${ts}_anchor-probe.txt`);

  for (const cell of limited) {
    const h = loadCell(db, SOURCE, cell.locationId, cell.windowStart);
    if (!h || !baseComplete(h)) { skipped++; continue; }
    const loc = locs.get(cell.locationId)!;
    const utcOffsetHours = utcOffsetFor(loc.lon);
    const startEpochHour = requestUtcHourFor(
      Math.floor(Date.parse(cell.windowStart + "Z") / 3600000), utcOffsetHours, args.requestHour);
    const params: ForecastParams = {
      locationIdx: 0, lat: loc.lat, lon: loc.lon, mode: 1, utcOffsetHours,
      modelsMask: 1, varsMask: ALL_MASK, maxChars: args.maxChars,
      decoderVersion: V3_VERSION, code: 0, startEpochHour, userToken: null,
    };
    const elevation = elevs.get(cell.locationId) ?? 0;

    const msgMemo = new Map<string, ForecastMessage | null>();
    const msgFor = (p: Profile): ForecastMessage | null => {
      const k = profKey(p);
      if (!msgMemo.has(k)) {
        msgMemo.set(k, buildLayoutMessage(
          h, h.time, params, profileLayout(p, startEpochHour, utcOffsetHours),
          loc.lat, loc.lon, elevation, MODEL_KEY));
      }
      return msgMemo.get(k)!;
    };

    // Every profile spans a subset of the full-coverage span; if even that isn't covered by the
    // window, drop the cell so fit % has one denominator across all steps.
    if (msgFor(rep(1, SLOTS)) === null) { uncovered++; continue; }
    used++;

    // breakdown memo shared across modes (paths overlap heavily at the bottom)
    const bdMemo = new Map<string, { chars: number; modelBits: number }>();
    const bdFor = (p: Profile, comboId: string, mask: number) => {
      const k = `${comboId}:${profKey(p)}`;
      if (!bdMemo.has(k)) {
        const bd = v3EncodeBreakdown({ ...msgFor(p)!, vars_mask: mask });
        bdMemo.set(k, { chars: bd.chars, modelBits: bd.bodyBits - bd.overheadBits });
      }
      return bdMemo.get(k)!;
    };

    for (const [mode, steps] of modeSteps) for (const c of COMBOS) {
      const st = stats.get(`${mode}:${c.id}`)!;
      let prevBits: number | null = null;
      for (let i = 0; i < steps.length; i++) {
        const bd = bdFor(steps[i].profile, c.id, c.mask);
        if (bd.chars <= args.maxChars) st[i].fit++;
        st[i].chars.push(bd.chars);
        if (prevBits !== null) st[i].dBits.push(bd.modelBits - prevBits);
        prevBits = bd.modelBits;
      }
    }
    if (used % 200 === 0) console.error(`  …${used} forecasts`);
    if (used % 500 === 0) writeFileSync(file, render()); // checkpoint: a killed run still reports
  }

  const final = render();
  writeFileSync(file, final);
  console.log(final);
  console.error(`\nwrote ${file}`);
}

main();
