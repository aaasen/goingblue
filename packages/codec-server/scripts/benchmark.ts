/**
 * Benchmark the forecast encoding against a corpus of real forecasts.
 *
 * One script, two phases:
 *   1. Collect — pull 14-day hourly windows from Open-Meteo's Historical Forecast API (a
 *      continuous best-estimate archive), one window every ~10 days across YEARS_BACK years, for
 *      every source production serves (per-center seamless blends + best_match). Rows land in the
 *      corpus SQLite DB (corpus-db.ts); the planner fetches only (source, location, window,
 *      variable) cells the DB doesn't have, batched per call, so variables/sources/locations are
 *      all addable incrementally without refetching what exists.
 *   2. Report — for each cached forecast, run the exact production path: buildFillMessage (the
 *      duration-first layout: layoutFor → window aggregation → toFullPeriod) fed to the same
 *      fitFillToBudget binary search the request path uses, over the identical fill sequence. So
 *      the report answers the product question — for a requested duration, how far up the
 *      refinement ladder (12h → 6h → 3h → 1h) does one message get? — and shows how the bit
 *      budget splits across the header and each variable column (with each column's chosen mode).
 *      The report reads REPORT_SOURCE (best_match — what production serves) and defaults to the
 *      eval split, so the headline metric is held out from codebook training (--split widens it).
 *
 *   node packages/codec-server/scripts/benchmark.ts                     # collect (idempotent) then report
 *   node packages/codec-server/scripts/benchmark.ts --collect-only      # expand the corpus DB, no report
 *   node packages/codec-server/scripts/benchmark.ts --report-only       # report from the DB, no collection
 *   node packages/codec-server/scripts/benchmark.ts --dry-run           # preview the fetch plan, no fetch
 *   node packages/codec-server/scripts/benchmark.ts --pilot             # candidate-spec pull, pilot slice only
 *   node packages/codec-server/scripts/benchmark.ts --validate          # data-quality report from the DB
 *   node packages/codec-server/scripts/benchmark.ts --dump <source> <loc> <window>  # inspect one cell
 *   node packages/codec-server/scripts/benchmark.ts --help              # all options
 *
 * Reports land in data/benchmarks (gitignored). going.blue/benchmark serves one published copy;
 * promoting a run is a manual, deliberate step — it is a public page:
 *
 *   gzip -9 -c data/benchmarks/<run>.html > packages/server/public/benchmark.html.gz
 *
 * API usage counts toward the plan's monthly call volume; cap a run with --limit.
 * OPEN_METEO_API_KEY switches to the commercial endpoint.
 */
import { mkdir, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { join } from "node:path";
import { buildFillMessage, fitFillToBudget, type ForecastParams, type HourlyData } from "../src/forecast.ts";
import {
  VARS_BIT, ALWAYS_VARS, RESOLUTION_HOURS, FILL_SLOTS, FILL_ANCHOR_SEQS, MODE_NAMES, MODE_AUTO,
  fillProfile, maxFillSeq, v1EncodeBreakdown,
  type ForecastMessage, type V1Breakdown,
} from "@weather/protocol";

import {
  DB_PATH, HORIZON_DAYS, REPO_ROOT, WINDOW_HOURS, cellKey, dbLocations, listCells, loadCell,
  mirrorLocations, modelElevations, openDb, presentVars, upsertLocationMeta, upsertSeries,
  type SeriesRow,
} from "./corpus-db.ts";
import { runIso, sampleWindows } from "./lattice.ts";
import { API_KEY, ApiError, ENDPOINT, fetchWindow } from "./om-fetch.ts";
import { LOCATIONS, type Location } from "./locations.ts";

const BENCHMARKS_DIR = join(REPO_ROOT, "data", "benchmarks"); // timestamped HTML reports

// ── Collection config ────────────────────────────────────────────────────────────

// Protocol variable groups mirroring the app's selector (BuilderTab.tsx); the report's toggles.
type GroupId = "clouds" | "highwind" | "freeze" | "precip";
const GROUP_IDS: GroupId[] = ["clouds", "highwind", "freeze", "precip"];
const GROUP_LABEL: Record<GroupId, string> = {
  clouds: "Clouds", highwind: "High Altitude Winds", freeze: "Freezing Level",
  precip: "Precip Chance",
};
// Short forms for the frontier chart, where each curve is labelled on the plot itself.
const GROUP_SHORT: Record<GroupId, string> = {
  clouds: "Cloud", highwind: "Wind", freeze: "FL", precip: "Precip",
};

// Open-Meteo hourly series behind the current wire format. The Historical Forecast API provides
// precipitation_probability (unlike single-runs, where it forced the ensemble variant).
const BASE_HOURLY = [
  "temperature_2m", "wind_speed_10m", "wind_direction_10m", "precipitation_probability",
  "weather_code", "snowfall", "rain", "showers",
];
const CLOUD_HOURLY = ["cloud_cover_high", "cloud_cover_mid", "cloud_cover_low"];
const HIGHWIND_HOURLY = ["wind_speed_500hPa", "wind_direction_500hPa", "wind_speed_600hPa",
  "wind_direction_600hPa", "wind_speed_700hPa", "wind_direction_700hPa"];
const FREEZE_HOURLY = ["freezing_level_height"];

// Candidate-spec additions (see CorpusPlan.md): future-display surface variables, plus clouds and
// winds on the standard pressure levels (925/850/700/500/300 exist across centers; 1000 is nearly
// free and serves the ocean stratum; 600/400 — Denali 14k camp and the summit bracket — probed
// 2026-07-31: best_match serves both globally on the forecast AND historical-forecast APIs, so
// they ride the sample pull; per-center availability (ecmwf_ifs025, gem) still unverified.
// The pilot pull fetches these to build the per-source capability matrix; the backfill
// pulls wire sets only, and later additions are batched add-passes over the DB (~1 unit/cell).
const SURFACE_CANDIDATE = [
  "relative_humidity_2m", "dew_point_2m", "snow_depth", "pressure_msl", "visibility", "cape",
  "wind_gusts_10m",
  // 2026-07-31 expansion, all probed ok on the historical-forecast API under best_match:
  // feels-like pair (wet bulb is Stull — sea-level fit, biased at altitude; surface_pressure
  // enables a correct psychrometric recompute), UV, CIN/LI around cape, the solar block
  // (also inputs to apparent_temperature), and the models' own totals so component
  // reconstruction (rain+showers+snowfall, low/mid/high overlap) can be validated.
  "apparent_temperature", "wet_bulb_temperature_2m", "uv_index", "uv_index_clear_sky",
  "surface_pressure", "lifted_index", "convective_inhibition",
  "shortwave_radiation", "direct_radiation", "diffuse_radiation", "sunshine_duration",
  "precipitation", "cloud_cover",
];
const STD_LEVELS = [1000, 925, 850, 700, 500, 300];
const GFS_EXTRA_LEVELS = [600, 400];
const levelVars = (levels: number[]) =>
  levels.flatMap((l) => [
    `cloud_cover_${l}hPa`, `wind_speed_${l}hPa`, `wind_direction_${l}hPa`,
    // Thermo fields complete the sounding: temp at camp altitudes, derived freezing level,
    // and geopotential height to place each level at a real elevation.
    `temperature_${l}hPa`, `relative_humidity_${l}hPa`, `geopotential_height_${l}hPa`,
  ]);
const uniq = (vars: string[]) => [...new Set(vars)];

// The sources production will serve (see memory: model menu by center). `id` doubles as the
// Open-Meteo `models` param. The two ECMWF entries are one logical center — HRES 9 km surface +
// IFS 0.25° pressure levels — kept as separate source rows and merged only at read time.
// `sample` marks sources that collect the stratified global sample (koppen/ocean strata) —
// best_match only: it is what production serves, and 10k sites × the other centers would
// multiply the pull for no training benefit.
interface SourceDef {
  id: string;
  label: string;
  wire: string[];      // backfill set: what the current wire format needs
  candidate: string[]; // pilot set: wire + everything under consideration (capability matrix)
  collect?: string[];  // full-pull set for the non-pilot collect; defaults to wire
  sample: boolean;
}
const GFS_WIRE = [...BASE_HOURLY, ...CLOUD_HOURLY, ...HIGHWIND_HOURLY, ...FREEZE_HOURLY];
// Everything best_match can serve: wire + surface candidates + all 8 levels × 6 fields.
const BEST_MATCH_FULL = uniq([...GFS_WIRE, "wind_gusts_10m", ...SURFACE_CANDIDATE,
  ...levelVars([...STD_LEVELS, ...GFS_EXTRA_LEVELS])]);
const SOURCES: SourceDef[] = [
  {
    id: "gfs_seamless", label: "NCEP GFS Seamless", sample: false,
    wire: GFS_WIRE,
    candidate: uniq([...GFS_WIRE, ...SURFACE_CANDIDATE, ...levelVars([...STD_LEVELS, ...GFS_EXTRA_LEVELS])]),
  },
  {
    id: "ecmwf_ifs", label: "ECMWF IFS HRES (surface)", sample: false,
    wire: [...BASE_HOURLY, ...CLOUD_HOURLY], // no freeze / pressure vars on the 9 km product
    candidate: uniq([...BASE_HOURLY, ...CLOUD_HOURLY, ...SURFACE_CANDIDATE]),
  },
  {
    id: "ecmwf_ifs025", label: "ECMWF IFS 0.25° (pressure levels)", sample: false,
    wire: HIGHWIND_HOURLY,
    candidate: uniq([...HIGHWIND_HOURLY, ...levelVars(STD_LEVELS)]),
  },
  {
    id: "gem_seamless", label: "GEM Seamless", sample: false,
    wire: GFS_WIRE, // freeze presence unverified — the capability matrix settles it
    candidate: uniq([...GFS_WIRE, ...SURFACE_CANDIDATE, ...levelVars(STD_LEVELS)]),
  },
  {
    id: "best_match", label: "Best match", sample: true,
    // wind_gusts_10m joined the wire 2026-07-30 (always-on gust column) — best_match only for
    // now: it is the derive/report source, and the per-center sources add no training benefit.
    wire: uniq([...GFS_WIRE, "wind_gusts_10m"]),
    candidate: BEST_MATCH_FULL,
    // 2026-07-31 expansion pull: while commercial access lasts, the sample source collects the
    // full candidate set corpus-wide — planCollection makes this one add-pass call per cell.
    collect: BEST_MATCH_FULL,
  },
];
// The report (and the derive pipeline, via derive-lib DERIVE_SOURCE) reads best_match — the
// source production serves and the only one collected for the 10k sampled strata.
const REPORT_SOURCE = SOURCES.find((s) => s.id === "best_match")!;

// Pilot slice (Phase 2 of CorpusPlan.md): a handful of spread-out favorites × four seasonal
// windows × the full candidate spec, to build the capability matrix before committing budget.
const PILOT_LOCATION_IDS = [
  "denali", "paradise", "alta", "chamonix", "mount-cook", "el-chalten", "tromso",
  "kebnekaise-sydtoppen", "summit-pyramid", "south-rim",
];

// Window cadence/lattice constants live in lattice.ts (shared with sample-locations.ts).


// ── Report config ────────────────────────────────────────────────────────────────

// The report pivots on the priority mode (the `p:` request token), because that is what the
// user actually chooses: the mode orders the fill path, and the layout is the *output* the
// sequence buys with whatever budget is left.
const MODES = [0, 1, 2];
const modeLabel = (m: number) => MODE_NAMES[m];
const N_RUNGS = 4; // 12h → 1h, the resolution colour ramp

// The messages the detail view draws: the whole spread, from the worst forecasts to encode (p1 —
// stormy, high-entropy) to the easiest (p99 — stable).
const PERCENTILES = [1, 10, 25, 50, 75, 90, 99];

// Rung labels by resolution index (RESOLUTION_HOURS). The fill ladder walks 1..4 (12h → 1h).
const RUNG = Object.fromEntries(
  Object.entries(RESOLUTION_HOURS).map(([i, h]) => [i, `${h}h`]),
) as Record<number, string>;

// The layout a seq denotes, in words: the profile's resolution runs, plus a coverage note when
// the layout doesn't reach the full horizon yet.
function seqLabel(mode: number, seq: number): string {
  const prof = fillProfile(mode, seq);
  const runs: string[] = [];
  for (let i = 0; i < prof.length; ) {
    let j = i;
    while (j < prof.length && prof[j] === prof[i]) j++;
    runs.push(`${RUNG[prof[i]]}×${j - i}`);
    i = j;
  }
  const cover = prof.length < FILL_SLOTS ? ` (${prof.length}/${FILL_SLOTS} slots)` : "";
  return runs.join(" ") + cover;
}

// The landmarks the report marks on every seq axis: the mode's anchor waypoints (layout.ts).
// The first couple of anchors sit inside the truncated ramp — too close to zero to label.
function anchorMarks(mode: number): { seq: number; label: string }[] {
  return FILL_ANCHOR_SEQS[mode]
    .filter((seq) => seq > 3)
    .map((seq) => ({ seq, label: seqLabel(mode, seq) }));
}

// The corpus has no timezone, and production takes the offset from the client's `z:` token — so
// approximate it from longitude (the nautical convention, one zone per 15°). What matters for the
// benchmark is that the offset is realistic and non-zero: it puts local midnight (and so every day
// boundary in the layout) off the UTC grid, exactly as a real request does.
const utcOffsetFor = (lon: number) => Math.max(-12, Math.min(14, Math.round(lon / 15)));

// Request time for a corpus window: local `hour` on the first local day that starts at or after the
// window, expressed in UTC epoch hours. Anchoring to a local midnight inside the window keeps the
// whole fill span inside the cached data; a non-zero hour keeps slot 0 partial (the common case —
// a request at exactly local midnight is the one case layoutFor over-covers).
function requestUtcHour(windowStartUtcHour: number, utcOffsetHours: number, hour: number): number {
  const firstLocalMidnight = Math.ceil((windowStartUtcHour + utcOffsetHours) / 24) * 24;
  return firstLocalMidnight - utcOffsetHours + hour;
}

// Protocol variable groups, mirroring the app (BuilderTab.tsx). weathercode is always encoded by the
// protocol (not in a mask). BASE is always on; each toggleable group maps to protocol var bits.
const BASE_VARS: string[] = [...ALWAYS_VARS];
const GROUP_VARS: Record<GroupId, string[]> = {
  clouds: ["cch", "ccm", "ccl"],
  highwind: ["w500", "w600", "w700"],
  freeze: ["freeze"],
  precip: ["precip"],
};
const maskOf = (vars: string[]) => vars.reduce((m, v) => m | (1 << VARS_BIT[v]), 0);
const BASE_MASK = maskOf(BASE_VARS);

// All variable-group combinations (bit i = GROUP_IDS[i]).
const COMBOS = [...Array(1 << GROUP_IDS.length).keys()];
const comboGroups = (c: number): GroupId[] => GROUP_IDS.filter((_, i) => c & (1 << i));
const comboMask = (c: number) => BASE_MASK | maskOf(comboGroups(c).flatMap((g) => GROUP_VARS[g]));
const DEFAULT_COMBO = 0; // base variables only (no optional groups)

// Base Open-Meteo series required for a usable forecast (a fully-null one would encode as a silent
// zero column). rain counts as present if rain OR showers has data.
const REQUIRED_BASE: string[][] = [
  ["temperature_2m"], ["weather_code"], ["snowfall"], ["rain", "showers"], ["wind_speed_10m"],
  // gust joined the wire after the main backfill; ~1.6k stale cells (windows since rolled off the
  // live lattice) never got the add-pass and would encode gust as a silent zero column.
  ["wind_gusts_10m"],
];

// ── CLI ──────────────────────────────────────────────────────────────────────────

interface Args {
  // collect
  limit: number;         // max fetches this run (0 = unlimited); use a small value to verify first
  concurrency: number;   // fetches in flight; call starts are rate-gated regardless
  dryRun: boolean;       // preview the fetch plan, fetch nothing, no report
  collectOnly: boolean;  // collect (expand the corpus DB) and stop — no report
  reportOnly: boolean;   // skip collection, build the report from the DB
  pilot: boolean;        // candidate-spec pull over the pilot slice (capability matrix input)
  // inspection
  validate: boolean;     // data-quality report from the DB (no collection, no benchmark report)
  dump?: [string, string, string]; // print one (source, location, window) cell
  // report
  mode: number;          // which priority mode the report opens on (all of MODES are computed)
  split: "train" | "eval" | "all"; // which held-out split the report covers (--location bypasses)
  requestHour: number;   // local hour of day the request is assumed to arrive at
  maxChars: number;
  verbose: boolean;
  includeIncomplete: boolean;
  open: boolean; // open the HTML report when done (default true; --no-open to suppress)
  // shared
  location?: string;
}

const USAGE = `benchmark.ts — collect the forecast corpus and benchmark the encoding against it

Usage: node packages/codec-server/scripts/benchmark.ts [options]

Default (no options): collect anything missing (wire variable sets, all sources), then build the
HTML benchmark report from the corpus DB and open it.

Modes
  --collect-only            collect (expand the corpus DB) and stop — no report
  --report-only             skip collection, build the report from the DB
  --dry-run                 preview the fetch plan, fetch nothing, no report
  --pilot                   candidate-spec pull over the pilot slice only (10 locations ×
                            4 seasonal windows — builds the capability matrix input)
  --validate                data-quality report from the DB: capability matrix, archive depth,
                            range sanity, pinned elevations, archive drift
  --dump <source> <location> <window>
                            print one cell, e.g. --dump gfs_seamless denali 2026-05-16T00:00

Collect options
  --limit <n>               max fetches this run (0 = unlimited); pace big pulls with this
  --concurrency <n>         fetches in flight, 1-32 (default 8)
  --location <id>           restrict to one registry location (also filters the report)

Report options
  --mode <m>                mode view the report opens on: detail/auto/range (default auto)
  --split <s>               which locations the report covers: eval (held out from codebook
                            training, the default), train, or all; --location bypasses this
  --request-hour <h>        local hour the request is assumed to arrive at, 0-23 (default 7)
  --max-chars <n>           message budget in characters (default 160)
  --include-incomplete      keep forecasts with fully-null base series
  --no-open                 don't open the HTML report in the browser

Misc
  --verbose                 per-call OK/FAIL lines while collecting (default: a single
                            progress line), and the full call list in --dry-run
  -h, --help                show this help

Environment
  OPEN_METEO_API_KEY        API key — switches to the dedicated customer servers
                            (customer-historical-forecast-api.open-meteo.com). Set it inline:
                              OPEN_METEO_API_KEY=xxx pnpm benchmark --collect-only
                            or export it from your shell profile, or put it in a file and run
                            node --env-file=.env packages/codec-server/scripts/benchmark.ts
`;

function parseArgs(argv: string[]): Args {
  const args: Args = {
    limit: 0, concurrency: 8, dryRun: false, collectOnly: false, reportOnly: false, pilot: false,
    validate: false,
    mode: MODE_AUTO, split: "eval", requestHour: 7, maxChars: 160, verbose: false,
    includeIncomplete: false, open: true,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--help" || a === "-h") { console.log(USAGE); process.exit(0); }
    else if (a === "--dry-run") args.dryRun = true;
    else if (a === "--collect-only") args.collectOnly = true;
    else if (a === "--report-only") args.reportOnly = true;
    else if (a === "--pilot") args.pilot = true;
    else if (a === "--validate") args.validate = true;
    else if (a === "--dump") args.dump = [argv[++i], argv[++i], argv[++i]];
    else if (a === "--verbose") args.verbose = true;
    else if (a === "--no-open") args.open = false;
    else if (a === "--include-incomplete") args.includeIncomplete = true;
    else if (a === "--limit") args.limit = parseInt(argv[++i], 10) || 0;
    else if (a === "--concurrency") args.concurrency = parseInt(argv[++i], 10);
    else if (a === "--mode") args.mode = MODE_NAMES.findIndex((n) => n.toLowerCase() === argv[++i]?.toLowerCase());
    else if (a === "--split") args.split = argv[++i] as Args["split"];
    else if (a === "--request-hour") args.requestHour = parseInt(argv[++i], 10);
    else if (a === "--max-chars") args.maxChars = parseInt(argv[++i], 10);
    else if (a === "--location") args.location = argv[++i];
    else throw new Error(`Unknown argument: ${a} (--help lists the options)`);
  }
  if (!MODES.includes(args.mode)) {
    throw new Error(`--mode must be one of ${MODES.map(modeLabel).join(", ").toLowerCase()}`);
  }
  if (!["train", "eval", "all"].includes(args.split)) {
    throw new Error(`--split must be train, eval, or all`);
  }
  if (!(args.requestHour >= 0 && args.requestHour <= 23)) {
    throw new Error(`--request-hour must be 0..23`);
  }
  if (!(args.concurrency >= 1 && args.concurrency <= 32)) throw new Error("--concurrency must be 1..32");
  if (args.collectOnly && args.reportOnly) throw new Error("--collect-only and --report-only are mutually exclusive");
  if (args.dump && args.dump.some((p) => !p)) throw new Error("--dump needs <source> <location> <window>");
  return args;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ── Phase 1: collect ───────────────────────────────────────────────────────────────

// Pilot windows: the four samples nearest to mid-season points of the newest year — one window a
// season, so the capability matrix sees winter and summer data without a full pull.
function pilotWindows(windows: number[]): number[] {
  const day = 24 * 3600 * 1000;
  const anchor = windows[0]; // newest-first (sampleWindows order)
  const picks = [45, 135, 225, 315].map((d) => {
    let best = windows[0];
    for (const w of windows) {
      if (Math.abs(w - (anchor - d * day)) < Math.abs(best - (anchor - d * day))) best = w;
    }
    return best;
  });
  return [...new Set(picks)];
}

// One planned API call: the variables a (source, location, window) cell is missing, batched.
// Fetching per missing-set (instead of per fixed set) is what makes variables addable later —
// an add-pass is one call per cell for just the new variables, nothing is refetched.
interface PlannedCall { source: SourceDef; loc: Location; windowStart: string; vars: string[] }

function planCollection(db: ReturnType<typeof openDb>, args: Args, locations: Location[]): PlannedCall[] {
  const windows = sampleWindows();
  const windowIsos = (args.pilot ? pilotWindows(windows) : windows).map(runIso);
  const plan: PlannedCall[] = [];
  const sampledStrata = new Set<Location["stratum"]>(["koppen", "ocean", "peaks"]);
  for (const source of SOURCES) {
    const wanted = args.pilot ? source.candidate : (source.collect ?? source.wire);
    const locs = locations
      .filter((l) => !sampledStrata.has(l.stratum) || source.sample)
      .filter((l) => !args.pilot || PILOT_LOCATION_IDS.includes(l.id));
    const present = presentVars(db, source.id);
    for (const loc of locs) {
      // Sampled sites commit to a window subset; intersect so they stay on the live lattice.
      const locWindows = loc.windows
        ? windowIsos.filter((w) => loc.windows!.includes(w))
        : windowIsos;
      for (const w of locWindows) {
        const have = present.get(cellKey(loc.id, w));
        const missing = have ? wanted.filter((v) => !have.has(v)) : wanted;
        if (missing.length) plan.push({ source, loc, windowStart: w, vars: missing });
      }
    }
  }
  return plan;
}

// No client-side pacing: the Professional plan's only limit is monthly call volume, which the
// operator tracks (--limit caps a run). A 429 still pauses every worker briefly.
class Backoff {
  private pausedUntil = 0;

  backOff(ms: number): void {
    this.pausedUntil = Math.max(this.pausedUntil, Date.now() + ms);
  }

  async wait(): Promise<void> {
    for (;;) {
      const delay = this.pausedUntil - Date.now();
      if (delay <= 0) return;
      await sleep(Math.min(delay, 1000));
    }
  }
}

async function collect(args: Args, locations: Location[]): Promise<void> {
  const db = openDb();
  mirrorLocations(db);
  const plan = planCollection(db, args, locations);

  console.log(`== Collect (historical forecast${args.pilot ? ", pilot candidate spec" : ""}) ==`);
  console.log(`  endpoint: ${ENDPOINT}${API_KEY ? " (commercial key)" : ""}`);
  for (const source of SOURCES) {
    const calls = plan.filter((c) => c.source === source);
    const wanted = args.pilot ? source.candidate : (source.collect ?? source.wire);
    console.log(`  ${source.id.padEnd(14)} ${String(calls.length).padStart(5)} calls (${wanted.length} vars wanted)`);
  }
  console.log(`  plan total: ${plan.length} calls`);
  if (args.limit) console.log(`  --limit ${args.limit}: capping this run to ${args.limit} fetches`);

  if (args.dryRun) {
    const shown = args.verbose ? plan.length : Math.min(plan.length, 5);
    for (const call of plan.slice(0, shown)) {
      console.log(`  DRY ${call.source.id} ${call.loc.id} ${call.windowStart} (${call.vars.length} vars)`);
    }
    if (plan.length > shown) console.log(`  … ${plan.length - shown} more planned calls (use --verbose to list)`);
    db.close();
    return;
  }

  // Worker pool: N fetches in flight, sharing a 429 backoff. A throttled call goes back on the
  // retry queue (a few attempts) instead of being dropped for the next run. The DB writes are
  // synchronous (DatabaseSync), so upserts from different workers can't interleave.
  const gate = new Backoff();
  const RETRY_ATTEMPTS = 3;
  const retries: { call: PlannedCall; attempts: number }[] = [];
  let nextIdx = 0, started = 0, fetched = 0, failed = 0;

  // Default output is one progress line — completed/planned, %, remaining-time estimate from
  // the observed pace — rewritten in place on a TTY, printed every 50 calls otherwise.
  // --verbose switches to the per-call OK/FAIL lines. Failures always print.
  const planned = args.limit ? Math.min(args.limit, plan.length) : plan.length;
  const t0 = Date.now();
  const isTTY = process.stdout.isTTY;
  let progressShown = false; // a \r-line is on screen and must be closed before other output
  const eta = (done: number): string => {
    const s = Math.round(((Date.now() - t0) / done) * (planned - done) / 1000);
    return s < 60 ? `${s}s` : s < 3600 ? `~${Math.round(s / 60)}m` : `~${Math.floor(s / 3600)}h ${Math.round((s % 3600) / 60)}m`;
  };
  const progress = (): void => {
    if (args.verbose) return;
    const done = fetched + failed;
    const line = `  ${done}/${planned} calls (${((100 * done) / Math.max(1, planned)).toFixed(1)}%)` +
      (done > 0 && done < planned ? ` — ${eta(done)} left` : "");
    if (isTTY) {
      process.stdout.write(`\r${line}\x1b[K`);
      progressShown = true;
    } else if (done % 50 === 0 || done === planned) {
      console.log(line);
    }
  };
  const note = (msg: string): void => {
    if (progressShown) { process.stdout.write("\n"); progressShown = false; }
    console.warn(msg);
  };

  const worker = async (): Promise<void> => {
    for (;;) {
      // A worker that requeues a call stays in its loop, so its own retries are always consumed
      // even if every other worker has already exited.
      let item = retries.shift();
      if (!item) {
        if (args.limit && started >= args.limit) return;
        const i = nextIdx++;
        if (i >= plan.length) return;
        started++;
        item = { call: plan[i], attempts: 0 };
      }
      const { call } = item;
      const label = `${call.source.id} ${call.loc.id} ${call.windowStart}`;
      await gate.wait();
      try {
        const res = await fetchWindow({
          apiModel: call.source.id, lat: call.loc.lat, lon: call.loc.lon, elevM: call.loc.elev_m,
          windowStart: call.windowStart, variables: call.vars,
        });
        const fetchedAt = new Date().toISOString();
        const rows: SeriesRow[] = [...res.series.entries()].map(([variable, s]) => ({
          source: call.source.id, locationId: call.loc.id, windowStart: call.windowStart,
          variable, values: s.values, unit: s.unit, fetchedAt,
        }));
        upsertSeries(db, rows);
        upsertLocationMeta(db, call.source.id, call.loc.id, res.resolvedLat, res.resolvedLon, res.modelElevation);
        fetched++;
        if (args.verbose) console.log(`  OK   ${label} (${call.vars.length} vars)`);
        progress();
      } catch (err) {
        const msg = (err as Error).message ?? String(err);
        if (err instanceof ApiError && err.status === 429 && item.attempts + 1 < RETRY_ATTEMPTS) {
          gate.backOff(10_000);
          retries.push({ call, attempts: item.attempts + 1 });
          if (args.verbose) console.warn(`  rate limited — pausing workers 10s, will retry ${label}`);
        } else {
          note(`  FAIL ${label} → ${msg.slice(0, 200)}`);
          failed++; // a re-run picks the cell up
          progress();
        }
      }
    }
  };
  await Promise.all(Array.from({ length: args.concurrency }, worker));

  if (progressShown) process.stdout.write("\n");
  console.log(`  done: fetched=${fetched} failed=${failed}`);
  db.close();
}

// ── Phase 2: report ────────────────────────────────────────────────────────────────

// One corpus forecast the report encodes: a (location, window) cell of REPORT_SOURCE plus the
// geography the layout needs. The hourly series itself is loaded per cell inside the report loop —
// the full-corpus eval split doesn't fit in memory all at once.
interface ReportCell {
  locId: string;
  windowStart: string;
  lat: number;
  lon: number;
  elevation: number; // grid-snap elevation from location_meta (pinned for curated peaks)
  group: string;     // breakdown row: favorites / Köppen major group / ocean band
}

// Breakdown row for a location: favorites stay their own row; sampled land rolls up to the
// Köppen major group (A tropical … E polar; the subtype rows would be too thin on the 15% eval
// split); ocean sites to their 30° latitude band (the sampler's stratification — the band isn't
// stored, so rederive it from lat).
const bandLabel = (south: number): string => {
  const edge = (d: number) => `${Math.abs(d)}°${d < 0 ? "S" : d > 0 ? "N" : ""}`;
  return `ocean ${edge(south)}–${edge(south + 30)}`;
};
// Peak-probe rows: summit elevation bands wide enough to stay populated on 30-site strata.
const peakBand = (elevM: number): string =>
  elevM >= 5500 ? "peaks ≥5.5 km" : elevM >= 3500 ? "peaks 3.5–5.5 km" : "peaks <3.5 km";
function groupOf(loc: { stratum: string; koppen: string | null; lat: number; elev_m: number | null }): string {
  if (loc.stratum === "favorites") return "favorites";
  if (loc.stratum === "peaks") return peakBand(loc.elev_m ?? 0);
  if (loc.stratum === "ocean") return bandLabel(Math.min(2, Math.floor(loc.lat / 30)) * 30);
  return `Köppen ${loc.koppen?.[0] ?? "?"}`;
}
// Row order for the breakdown: land groups tropics → polar, ocean bands north → south, peak
// bands low → high, favorites last. Unknown groups (shouldn't happen) sort just before favorites.
const GROUP_ORDER = [
  ..."ABCDE".split("").map((g) => `Köppen ${g}`),
  ...[60, 30, 0, -30, -60, -90].map(bandLabel),
  ...[0, 3500, 5500].map(peakBand),
];
const groupOrder = (g: string): number => {
  const i = GROUP_ORDER.indexOf(g);
  return g === "favorites" ? GROUP_ORDER.length + 1 : i === -1 ? GROUP_ORDER.length : i;
};

function loadReportCells(
  db: ReturnType<typeof openDb>, split: Args["split"], locationFilter?: string,
): ReportCell[] {
  const locs = dbLocations(db);
  const elevs = modelElevations(db, REPORT_SOURCE.id);
  const cells: ReportCell[] = [];
  for (const { locationId, windowStart } of listCells(db, REPORT_SOURCE.id, locationFilter)) {
    const loc = locs.get(locationId);
    if (!loc) continue; // a location dropped from the registry — its rows are dead weight, skip
    if (!locationFilter && split !== "all" && loc.split !== split) continue;
    cells.push({
      locId: locationId, windowStart,
      lat: loc.lat, lon: loc.lon, elevation: elevs.get(locationId) ?? 0,
      group: groupOf(loc),
    });
  }
  return cells;
}

// True if any base series is entirely null (a single trailing null at the horizon boundary is fine).
function baseComplete(h: HourlyData): boolean {
  const hasData = (v: string) => (h[v] as (number | null)[] | undefined)?.some((x) => x != null) ?? false;
  return REQUIRED_BASE.every((anyOf) => anyOf.some(hasData));
}

// The layout the production search landed on for one (forecast, mode, variable-combo), plus its
// bit breakdown.
interface Fit {
  seq: number;       // low seqs are the truncated 12h ramp (see layout.ts)
  periods: number;   // periods in the fitted message
  breakdown: V1Breakdown;
}

// What the report keeps per fit after folding the column bits into the colBits arrays — the full
// V1Breakdown per (cell × mode × combo) is what blew the heap on the full eval split.
interface StoredFit {
  seq: number;
  periods: number;
  bodyBits: number; // Σ column bits (excludes coder overhead), for the per-stratum bits/period
}

// The production fit, exactly: fitFillToBudget's binary search over the fill sequence, with each
// candidate encoded through the real codec. The only difference from the request path is that we
// keep the breakdown instead of just the string (fitFillToBudget is generic over that).
function fitFill(
  msgAt: (seq: number) => ForecastMessage | null,
  mode: number,
  varsMask: number,
  maxChars: number,
): Fit | null {
  return fitFillToBudget<Fit>(
    (seq) => {
      const msg = msgAt(seq);
      if (msg === null) return null; // upstream gap — unservable, same as in production
      const withVars: ForecastMessage = { ...msg, vars_mask: varsMask };
      return { seq, periods: withVars.periods[0].length, breakdown: v1EncodeBreakdown(withVars) };
    },
    (fit) => fit.breakdown.chars,
    maxFillSeq(mode),
    maxChars,
  );
}

const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;
function pct(xs: number[], p: number): number {
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))];
}
const box = (xs: number[]): BoxStats => ({
  min: Math.min(...xs), p25: pct(xs, 25), p50: pct(xs, 50),
  mean: mean(xs), p75: pct(xs, 75), max: Math.max(...xs),
});

function buildView(
  mode: number,
  fits: StoredFit[],
  cb: Map<string, number[]>,
): ViewStats {
  const seqs = fits.map((f) => f.seq);
  const periods = fits.map((f) => f.periods);
  const maxSeq = maxFillSeq(mode);

  // Histogram over the whole sequence, not just the observed range, so the anchor landmarks are
  // always on the axis and every mode's chart reads the same way.
  const counts = new Map<number, number>();
  for (const s of seqs) counts.set(s, (counts.get(s) ?? 0) + 1);
  const histogram = Array.from({ length: maxSeq }, (_, i) => ({ seq: i + 1, count: counts.get(i + 1) ?? 0 }));

  // How often the budget carried the message at least to each anchor waypoint.
  const stages = anchorMarks(mode).map(({ seq, label }) => ({
    seq, label, share: seqs.filter((s) => s >= seq).length / seqs.length,
  }));

  const columns: ColStat[] = [...cb.entries()].map(([name, bitsArr]) => {
    const bpp = bitsArr.map((b, i) => b / periods[i]);
    return {
      name,
      bits: mean(bitsArr),
      bitsPerPeriod: mean(bpp),
      bppStats: box(bpp),
    };
  });

  const medianSeq = pct(seqs, 50);
  return {
    mode, slots: FILL_SLOTS, maxSeq,
    seq: box(seqs),
    periods: box(periods),
    percentiles: PERCENTILES.map((p) => ({ p, seq: pct(seqs, p) })),
    medianSeq,
    medianLabel: seqLabel(mode, medianSeq),
    stages,
    histogram,
    bodyBits: columns.reduce((s, c) => s + c.bits, 0),
    columns,
  };
}

async function report(args: Args): Promise<void> {
  // Single source (best_match supplies every variable group, so no cross-source fallback needed).
  // The db stays open through the loop — cells are streamed one at a time (see ReportCell).
  const db = openDb();
  const cells = loadReportCells(db, args.split, args.location);
  if (cells.length === 0) throw new Error("No forecasts found — run collection first (or import the old JSON tree: import-corpus-json.ts)");

  // A view = mode × variable-combo. Every (mode, combo) is precomputed.
  const vkey = (mode: number, combo: number) => `${mode}:${combo}`;
  const fitsFor = new Map<string, StoredFit[]>();
  const colBits = new Map<string, Map<string, number[]>>();
  for (const m of MODES) for (const c of COMBOS) {
    const vk = vkey(m, c);
    fitsFor.set(vk, []); colBits.set(vk, new Map());
  }

  const forecasts: { location: string }[] = [];
  const allMask = comboMask(COMBOS.length - 1); // every group on
  let versionBits = 0, headerBits = 0, skipped = 0, short = 0, uncovered = 0;

  // Per-stratum breakdown bookkeeping: the group of each fitted cell, in push order per mode
  // (fits for every combo of one cell are pushed together, so one list per mode serves all
  // combos), plus the distinct locations behind each group.
  const groupsFor = new Map<number, string[]>(MODES.map((m) => [m, []]));
  const groupLocs = new Map<string, Set<string>>();

  for (const cell of cells) {
    const h = loadCell(db, REPORT_SOURCE.id, cell.locId, cell.windowStart);
    if (!h) { skipped++; continue; }
    // The DB's time axis is the fixed window grid (loadCell), so the old short-record case is
    // structurally gone; a cell missing a whole base variable still gets skipped below.
    if (!baseComplete(h)) { skipped++; continue; }
    const { locId, lat, lon, elevation } = cell;
    const utcOffsetHours = utcOffsetFor(lon);
    const startEpochHour = requestUtcHour(
      Math.floor(Date.parse(cell.windowStart + "Z") / 3600000), utcOffsetHours, args.requestHour);
    forecasts.push({ location: locId });

    for (const mode of MODES) {
      // Build layouts with every column populated (varsMask = allMask), then override vars_mask per
      // combo: columns encode independently, so one aggregation per seq serves every combo.
      // "US" (American center) keeps the pressure/freeze columns in toFullPeriod.
      const params: ForecastParams = {
        locationIdx: 0, lat, lon, mode, utcOffsetHours,
        modelsMask: 1, varsMask: allMask, maxChars: args.maxChars,
        decoderVersion: 1, code: 0, startEpochHour, userToken: null,
      };
      const memo = new Map<number, ForecastMessage | null>();
      const msgAt = (seq: number): ForecastMessage | null => {
        if (!memo.has(seq)) {
          // "BEST" is the center key (toFullPeriod indexes CENTERS with it); REPORT_SOURCE.label
          // is display text and broke the lookup after the center switch (97d4467).
          memo.set(seq, buildFillMessage(h, h.time, params, seq, lat, lon, elevation, "BEST"));
        }
        return memo.get(seq)!;
      };

      // The corpus window must cover the whole fill span. If it doesn't, the seq search would read
      // the data gap as "doesn't fit" and report a short layout as though the char budget had
      // caused it. Every path top spans the full horizon, so checking it is enough. (With a
      // 14-day window and the 12-day horizon this should never fire; it guards the metric.)
      if (msgAt(maxFillSeq(mode)) === null) { uncovered++; continue; }
      groupsFor.get(mode)!.push(cell.group);
      if (!groupLocs.has(cell.group)) groupLocs.set(cell.group, new Set());
      groupLocs.get(cell.group)!.add(locId);

      for (const c of COMBOS) {
        const fit = fitFill(msgAt, mode, comboMask(c), args.maxChars)!; // seq=1 is covered
        const vk = vkey(mode, c);
        fitsFor.get(vk)!.push({
          seq: fit.seq, periods: fit.periods,
          bodyBits: fit.breakdown.columns.reduce((s, col) => s + col.bits, 0),
        });
        versionBits = fit.breakdown.versionBits; headerBits = fit.breakdown.headerBits;
        const cb = colBits.get(vk)!;
        for (const col of fit.breakdown.columns) {
          if (!cb.has(col.name)) cb.set(col.name, []);
          cb.get(col.name)!.push(col.bits);
        }
        // Column bits are model costs; the rANS stream adds a constant flush/renorm slack per
        // message. Track it as a pseudo-column so the occupancy total reconciles with the chars.
        if (!cb.has("coder")) cb.set("coder", []);
        cb.get("coder")!.push(fit.breakdown.overheadBits);
      }
    }
  }
  db.close();

  // Build per-view stats. A mode the corpus can't cover for *any* forecast has no fits at all —
  // drop it rather than render a view full of NaNs (it means the window is too short; see
  // HORIZON_DAYS).
  const modes = MODES.filter((m) => fitsFor.get(vkey(m, DEFAULT_COMBO))!.length > 0);
  if (modes.length === 0) throw new Error("No (forecast, mode) pair is covered by the corpus — re-collect with a longer window");
  const views: Record<string, ViewStats> = {};
  for (const m of modes) {
    for (const c of COMBOS) {
      const vk = vkey(m, c);
      views[vk] = buildView(m, fitsFor.get(vk)!, colBits.get(vk)!);
    }
  }
  const dropped = MODES.filter((m) => !modes.includes(m));
  const defaultMode = modes.includes(args.mode) ? args.mode : modes[0];

  // Per-stratum breakdown, default combo: mean fill % (the tracked metric — see the report table)
  // and mean body bits/period per group, per mode.
  const strata: StratumStat[] = [...groupLocs.keys()]
    .sort((a, b) => groupOrder(a) - groupOrder(b))
    .map((group) => ({
      group,
      locations: groupLocs.get(group)!.size,
      perMode: modes.map((m) => {
        const fits = fitsFor.get(vkey(m, DEFAULT_COMBO))!;
        const groups = groupsFor.get(m)!;
        const mine = fits.filter((_, i) => groups[i] === group);
        if (mine.length === 0) return { m, n: 0, fillPct: NaN, bpp: NaN };
        return {
          m, n: mine.length,
          fillPct: 100 * mean(mine.map((f) => f.seq)) / maxFillSeq(m),
          bpp: mean(mine.map((f) => f.bodyBits / f.periods)),
        };
      }),
    }));

  const stats: ReportData = {
    timestamp: new Date().toISOString(),
    modes,
    dropped,
    defaultMode,
    requestHour: args.requestHour,
    maxChars: args.maxChars,
    forecasts: forecasts.length,
    locations: new Set(forecasts.map((f) => f.location)).size,
    skipped,
    short,
    uncovered,
    versionBits, headerBits,
    model: REPORT_SOURCE.label,
    split: args.location ? `location ${args.location}` : args.split,
    strata,
    groups: GROUP_IDS.map((g) => ({ id: g, label: GROUP_LABEL[g], short: GROUP_SHORT[g] })),
    defaultCombo: DEFAULT_COMBO,
    views,
  };

  await mkdir(BENCHMARKS_DIR, { recursive: true });
  const stamp = stats.timestamp.replace(/[:.]/g, "-").slice(0, 19);
  const outPath = join(BENCHMARKS_DIR, `${stamp}_${args.maxChars}c.html`);
  await writeFile(outPath, renderHtml(stats));

  const dv = views[vkey(defaultMode, stats.defaultCombo)];
  console.log(`\n== Benchmark ==`);
  console.log(`  ${stats.forecasts} forecasts, ${stats.locations} locations, ${REPORT_SOURCE.label} (split: ${stats.split}), modes ${modes.map(modeLabel).join("/")}  |  max-chars=${args.maxChars}, request ${args.requestHour}:00 local`);
  if (short) console.log(`  ignored ${short} cached forecast(s) from a shorter-window pull (< ${HORIZON_DAYS}d — leftovers, safe to delete)`);
  if (skipped) console.log(`  skipped ${skipped} forecast(s) with an incomplete base series`);
  if (uncovered) console.log(`  skipped ${uncovered} (forecast, mode) pair(s) the corpus window doesn't cover`);
  if (dropped.length) console.log(`  dropped ${dropped.map(modeLabel).join("/")} entirely — no forecast in the corpus covers them (re-collect: the window must be ≥ ${HORIZON_DAYS}d)`);
  console.log(`  default view (${modeLabel(defaultMode)}, base): seq mean ${dv.seq.mean.toFixed(1)} of ${dv.maxSeq}, median ${dv.medianSeq} = ${dv.medianLabel}`);
  if (strata.length > 1) {
    console.log(`  by stratum (${modeLabel(defaultMode)}, base):`);
    for (const s of strata) {
      const p = s.perMode.find((x) => x.m === defaultMode)!;
      console.log(`    ${s.group.padEnd(16)} ${String(s.locations).padStart(5)} locs  ${String(p.n).padStart(6)} cells  fill ${p.fillPct.toFixed(1).padStart(5)}%  ${p.bpp.toFixed(2)} bits/period`);
    }
  }
  console.log(`  report: ${outPath.replace(REPO_ROOT + "/", "")}`);

  if (args.open) openInBrowser(outPath);
}

// Open a file with the OS default handler (the browser, for the HTML report). Best-effort and
// non-blocking; failures (e.g. headless CI) are ignored.
function openInBrowser(path: string): void {
  const cmd = process.platform === "darwin" ? "open"
    : process.platform === "win32" ? "cmd"
    : "xdg-open";
  const cmdArgs = process.platform === "win32" ? ["/c", "start", "", path] : [path];
  try {
    spawn(cmd, cmdArgs, { detached: true, stdio: "ignore" }).unref();
  } catch { /* ignore — opening is a convenience, not required */ }
}

// ── HTML report ──────────────────────────────────────────────────────────────────

interface BoxStats { min: number; p25: number; p50: number; mean: number; p75: number; max: number }
interface ColStat { name: string; bits: number; bitsPerPeriod: number; bppStats: BoxStats }
// An anchor landmark: a named waypoint of the mode's path, reached by `share` of messages.
interface StageStat { seq: number; label: string; share: number }
interface ViewStats {
  mode: number;
  slots: number;   // FILL_SLOTS day slots
  maxSeq: number;  // the mode's path top
  seq: BoxStats;
  periods: BoxStats;
  percentiles: { p: number; seq: number }[]; // the seq at each PERCENTILE of the distribution
  medianSeq: number;
  medianLabel: string;    // what the median seq actually is, as a layout
  stages: StageStat[];
  histogram: { seq: number; count: number }[]; // one bin per seq in 1..maxSeq
  bodyBits: number;
  columns: ColStat[];
}
// One breakdown row: a corpus stratum group (Köppen major group / ocean band / favorites), its
// mean fill % and body bits/period for the base combo at each mode.
interface StratumStat {
  group: string;
  locations: number;
  perMode: { m: number; n: number; fillPct: number; bpp: number }[];
}
// Everything the report embeds. `views` holds one ViewStats per mode:combo.
interface ReportData {
  timestamp: string;
  modes: number[];       // modes the corpus can serve (a view exists for each)
  dropped: number[];     // modes no forecast covers — corpus window too short
  defaultMode: number;
  requestHour: number;
  maxChars: number;
  forecasts: number;
  locations: number;
  skipped: number;
  short: number;      // cached records from a shorter-window pull, ignored
  uncovered: number;
  versionBits: number;
  headerBits: number;
  model: string; // single model (label), shown in the meta line
  split: string; // which held-out split the report covers (or the explicit --location)
  strata: StratumStat[];
  groups: { id: GroupId; label: string; short: string }[];
  defaultCombo: number;
  views: Record<string, ViewStats>;                        // "mode:combo" → stats
}

// Fill as a fraction of the sequence: seq / maxSeq. 100% is the top of the mode's path.
// Normalizing by the path length is what makes modes with different sequence lengths comparable
// on one axis.
const fillBox = (vs: ViewStats): BoxStats => {
  const f = 1 / vs.maxSeq;
  const s = vs.seq;
  return { min: s.min * f, p25: s.p25 * f, p50: s.p50 * f, mean: s.mean * f, p75: s.p75 * f, max: s.max * f };
};
const pctText = (fraction: number) => `${(100 * fraction).toFixed(1)}%`;

const esc = (s: string) =>
  s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]!));

// The layout a seq denotes, slot by slot — the concrete thing a fill percentage stands for. Mirrors
// layoutFor's arithmetic without needing a real request: each covered day slot gets a resolution
// rung, and slot 0 starts at the period containing the request hour (so refining it drops the
// earlier part of today — visible as the leading gap in the strip).
interface StripSlot {
  res: number;          // resolution index (1..4), or 0 when the slot isn't covered at all
  periodHours: number;  // span of one period in this slot
  startHour: number;    // first period's local hour of day (0 for every slot but the first)
}
// Geometry shared by the strips and the day axis above them, so days line up across rows. Periods
// are separated by a hairline gap and days by a wider one — the spacing alone reads as the day
// boundary, so the strips need no rules drawn over the fills.
const STRIP = { W: 720, l: 0, r: 0, periodGap: 2, dayGap: 9 };
const dayName = (d: number) => `${d}d`; // 0d is the request day (partial); 1d, 2d … are whole days
function stripLayout(mode: number, seq: number, requestHour: number): StripSlot[] {
  const profile = fillProfile(mode, seq);
  return Array.from({ length: FILL_SLOTS }, (_, d) => {
    if (d >= profile.length) return { res: 0, periodHours: 0, startHour: 0 }; // not covered yet
    const res = profile[d];
    const h = RESOLUTION_HOURS[res];
    return { res, periodHours: h, startHour: d === 0 ? Math.floor(requestHour / h) * h : 0 };
  });
}

// One message, drawn: a rectangle of day slots, each divided into its periods and coloured by
// resolution. The whole point is to make a fill percentage legible — [1h|3h|3h|3h] is what "75%"
// actually buys you.
// `scaleSlots` sets the day pitch: pass the widest duration in a stack and every row draws its days
// at the same width, so a longer forecast is a longer strip rather than a squashed one.
function renderLayoutStrip(vs: ViewStats, seq: number, requestHour: number, scaleSlots?: number): string {
  const slots = stripLayout(vs.mode, seq, requestHour);
  const { W, l, r, periodGap, dayGap } = STRIP;
  const H = 34, m = { t: 1, b: 1 };
  const barH = H - m.t - m.b;
  const slotW = (W - l - r) / (scaleSlots ?? slots.length);
  const dayW = slotW - dayGap; // the day's fills; the remainder is the gap to the next day

  const cells = slots.map((slot, d) => {
    const x0 = l + d * slotW;
    if (slot.res === 0) {
      return `<rect x="${x0.toFixed(1)}" y="${m.t}" width="${dayW.toFixed(1)}" height="${barH}" class="slot-empty">` +
        `<title>${dayName(d)} — not covered: the budget stopped the path before this day</title></rect>`;
    }
    const out: string[] = [];
    // Slot 0 starts at the period containing the request hour. The earlier part of today carries no
    // periods; show it as an empty placeholder so today reads as a partial day rather than a short one.
    if (slot.startHour > 0) {
      out.push(`<rect x="${x0.toFixed(1)}" y="${m.t}" width="${Math.max(1, dayW * slot.startHour / 24 - periodGap).toFixed(1)}" ` +
        `height="${barH}" rx="1.5" class="slot-past">` +
        `<title>before the request (${requestHour}:00 local) — not sent</title></rect>`);
    }
    for (let h = slot.startHour; h < 24; h += slot.periodHours) {
      const x = x0 + dayW * (h / 24);
      out.push(`<rect x="${x.toFixed(1)}" y="${m.t}" width="${Math.max(1, dayW * slot.periodHours / 24 - periodGap).toFixed(1)}" ` +
        `height="${barH}" rx="1.5" class="rung r${slot.res}">` +
        `<title>${dayName(d)} ${String(h).padStart(2, "0")}:00 — one ${RUNG[slot.res]} period</title></rect>`);
    }
    return out.join("");
  }).join("");

  return `<svg viewBox="0 0 ${W} ${H}" class="strip" role="img" aria-label="One message: ${esc(seqLabel(vs.mode, seq))}">
  ${cells}
</svg>`;
}

// The day axis, shared by every strip below it: one label per day slot, aligned to the same grid.
function renderStripAxis(slots: number): string {
  const { W, l, r, dayGap } = STRIP;
  const H = 16;
  const slotW = (W - l - r) / slots;
  const labels = Array.from({ length: slots }, (_, d) =>
    `<text x="${(l + d * slotW + (slotW - dayGap) / 2).toFixed(1)}" y="11" class="sliplabel" text-anchor="middle">${esc(dayName(d))}</text>`).join("");
  return `<svg viewBox="0 0 ${W} ${H}" class="stripaxis" role="img" aria-label="Day axis">${labels}</svg>`;
}

// The rung key, shared by every strip: colour is the only channel carrying resolution in the strips
// themselves, so the legend is mandatory (and each block still names its rung on hover).
function renderRungLegend(): string {
  const keys = Array.from({ length: N_RUNGS }, (_, i) => i + 1)
    .map((res) => `<span class="key"><i class="sw r${res}"></i>${esc(RUNG[res])}</span>`).join("");
  return `<div class="legend"><span class="legend-label">resolution</span>${keys}</div>`;
}

// One strip per percentile of the fill distribution, labelled with its fill percentage.
function renderPercentileStrips(vs: ViewStats, requestHour: number): string {
  const rows = vs.percentiles.map(({ p, seq }) => `<div class="striprow">
    <div class="striplabel"><strong>p${p}</strong> · ${pctText(seq / vs.maxSeq)} filled</div>
    ${renderLayoutStrip(vs, seq, requestHour)}
  </div>`).join("\n");
  // The percentile stack is itself an axis: p1 is the hardest forecast in the corpus to encode and
  // p99 the easiest, so label the two ends rather than leaving the ordering implicit.
  return `${renderRungLegend()}
  <div class="striphead indent"><div></div>${renderStripAxis(FILL_SLOTS)}</div>
  <div class="stripwrap">
    <div class="entropy-axis">
      <span>stormy</span>
      <span class="entropy-line"></span>
      <span>stable</span>
    </div>
    <div class="stripstack">${rows}</div>
  </div>`;
}

// The chart keeps the full fill scale (0–100%) on the axis rather than the observed range: the low
// end is where the interesting failures live (at 10d with every variable on, some messages don't
// even reach a full 12h fill), so cropping to the data would hide exactly what you want to see.
// `l` leaves room for the y tick labels *and* the rotated axis title beside them.
const SEQ_CHART = { W: 720, l: 64, r: 14 };

// How far a message gets, as a survival curve: for each fill level, the share of forecasts that
// reach *at least* that far. Read it directly — pick a fill level on the x-axis, read the percentage
// of forecasts that achieve it. Monotone by construction, so it can never look noisy, and the four
// rung landmarks are just points on the curve rather than a separate table.
//
// The area is cut into the four ladder stages and filled with the same rung colours as the strips
// and the fill bars: the darker the band under the curve, the finer the resolution it represents.
function renderReachArea(vs: ViewStats): string {
  const W = SEQ_CHART.W, H = 260, m = { t: 28, r: SEQ_CHART.r, b: 42, l: SEQ_CHART.l };
  const iw = W - m.l - m.r, ih = H - m.t - m.b;
  const { maxSeq } = vs;
  const total = vs.histogram.reduce((sum, h) => sum + h.count, 0) || 1;

  // reach[seq] = share of forecasts whose fitted seq is >= seq (so reach[1] is always 100%).
  const reach: number[] = new Array(maxSeq + 1).fill(0);
  for (let seq = maxSeq; seq >= 1; seq--) {
    reach[seq] = reach[seq + 1] ?? 0;
    reach[seq] += (vs.histogram[seq - 1]?.count ?? 0) / total;
  }

  const xEdge = (i: number) => m.l + (i / maxSeq) * iw; // band edges: seq n spans [n-1, n]
  const y = (share: number) => m.t + ih * (1 - share);
  const base = y(0);

  // One stepped polygon per run of seqs sharing the same finest rung (the front slot of the
  // profile — profiles are monotone), so the area under the curve carries the resolution colour
  // the path has reached at that point.
  const finest = Array.from({ length: maxSeq }, (_, i) => fillProfile(vs.mode, i + 1)[0]);
  const areaRuns: string[] = [];
  let runStart = 1;
  for (let seq = 2; seq <= maxSeq + 1; seq++) {
    if (seq <= maxSeq && finest[seq - 1] === finest[runStart - 1]) continue;
    const from = runStart, to = seq - 1;
    const pts: string[] = [`${xEdge(from - 1).toFixed(1)},${base.toFixed(1)}`];
    for (let q = from; q <= to; q++) {
      pts.push(`${xEdge(q - 1).toFixed(1)},${y(reach[q]).toFixed(1)}`);
      pts.push(`${xEdge(q).toFixed(1)},${y(reach[q]).toFixed(1)}`);
    }
    pts.push(`${xEdge(to).toFixed(1)},${base.toFixed(1)}`);
    areaRuns.push(`<polygon points="${pts.join(" ")}" class="rung r${finest[runStart - 1]} area"/>`);
    runStart = seq;
  }
  const areas = areaRuns.join("");

  // The curve itself, over the whole domain.
  const line: string[] = [];
  for (let seq = 1; seq <= maxSeq; seq++) {
    line.push(`${xEdge(seq - 1).toFixed(1)},${y(reach[seq]).toFixed(1)}`);
    line.push(`${xEdge(seq).toFixed(1)},${y(reach[seq]).toFixed(1)}`);
  }
  const curve = `<polyline points="${line.join(" ")}" class="reachline"/>`;

  // Invisible hit targets: one per seq, so any point on the curve can be read exactly.
  const hits = Array.from({ length: maxSeq }, (_, i) => i + 1).map((seq) =>
    `<rect x="${xEdge(seq - 1).toFixed(1)}" y="${m.t}" width="${(iw / maxSeq).toFixed(1)}" height="${ih}" class="hit">` +
    `<title>${pctText(seq / maxSeq)} filled (seq ${seq} — ${esc(seqLabel(vs.mode, seq))})\n` +
    `${(100 * reach[seq]).toFixed(1)}% of forecasts reach at least this far</title></rect>`).join("");

  // y: share of forecasts, 0–100%.
  const yAxis = [0, 0.25, 0.5, 0.75, 1].map((v) =>
    `<line x1="${m.l}" y1="${y(v).toFixed(1)}" x2="${W - m.r}" y2="${y(v).toFixed(1)}" class="hgrid"/>` +
    `<text x="${m.l - 8}" y="${(y(v) + 3.5).toFixed(1)}" class="htick" text-anchor="end">${(100 * v).toFixed(0)}%</text>`).join("");

  // x: fill percentage, ticked at the mode's anchor waypoints. Each mark carries the share of
  // forecasts that reach it — the numbers worth reading off this curve, stated rather than left
  // to the eye; the waypoint's layout is in the hover title.
  const xAxis = vs.stages.map((st, k) => {
    const x = xEdge(st.seq);
    const anchor = k === vs.stages.length - 1 ? "end" : "middle";
    return `<line x1="${x.toFixed(1)}" y1="${m.t}" x2="${x.toFixed(1)}" y2="${base.toFixed(1)}" class="mark"><title>${esc(st.label)}</title></line>` +
      `<text x="${x.toFixed(1)}" y="${m.t - 10}" class="marklabel" text-anchor="${anchor}">` +
      `${(100 * st.share).toFixed(1)}%</text>` +
      `<text x="${x.toFixed(1)}" y="${H - m.b + 16}" class="htick" text-anchor="${anchor}">${pctText(st.seq / maxSeq)}</text>`;
  }).join("");

  return `<svg viewBox="0 0 ${W} ${H}" class="hist" role="img" aria-label="Share of forecasts reaching each fill level">
  ${yAxis}${areas}${curve}${xAxis}${hits}
  <text x="${m.l + iw / 2}" y="${H - 4}" class="haxis" text-anchor="middle">FILL PERCENTAGE</text>
  <text x="12" y="${m.t + ih / 2}" class="haxis" text-anchor="middle" transform="rotate(-90 12 ${m.t + ih / 2})">PERCENT OF FORECASTS</text>
</svg>`;
}

// Compact box-and-whisker for a table cell: min–max whiskers, Q1–Q3 box, median line, mean dot, on a
// shared 0..scaleMax x-axis so columns are directly comparable. Values are in the hover title.
function renderMiniBox(s: BoxStats, scaleMax: number): string {
  const W = 200, H = 20, pad = 3, iw = W - 2 * pad;
  const x = (v: number) => pad + (v / scaleMax) * iw;
  const cy = H / 2, half = 5.5, cap = 3.5;
  return `<svg viewBox="0 0 ${W} ${H}" class="mbox">` +
    `<title>bits/period — min ${s.min.toFixed(2)} · Q1 ${s.p25.toFixed(2)} · median ${s.p50.toFixed(2)} · mean ${s.mean.toFixed(2)} · Q3 ${s.p75.toFixed(2)} · max ${s.max.toFixed(2)}</title>` +
    `<line x1="${x(s.min).toFixed(1)}" y1="${cy}" x2="${x(s.max).toFixed(1)}" y2="${cy}" class="bwhisker"/>` +
    `<line x1="${x(s.min).toFixed(1)}" y1="${cy - cap}" x2="${x(s.min).toFixed(1)}" y2="${cy + cap}" class="bwhisker"/>` +
    `<line x1="${x(s.max).toFixed(1)}" y1="${cy - cap}" x2="${x(s.max).toFixed(1)}" y2="${cy + cap}" class="bwhisker"/>` +
    `<rect x="${x(s.p25).toFixed(1)}" y="${cy - half}" width="${Math.max(1, x(s.p75) - x(s.p25)).toFixed(1)}" height="${2 * half}" class="bbox"/>` +
    `<line x1="${x(s.p50).toFixed(1)}" y1="${cy - half}" x2="${x(s.p50).toFixed(1)}" y2="${cy + half}" class="bmedian"/>` +
    `<circle cx="${x(s.mean).toFixed(1)}" cy="${cy}" r="2.5" class="bmean"/>` +
  `</svg>`;
}

// Mean fill as a bar: a fixed 0–100% track with the value filled in, so a row of cells can be
// compared at a glance without reading the numbers. The track is always the full scale — a short bar
// means a small share of a full 1h fill, never a rescaled axis.
//
function renderFillBar(fill: number): string {
  const W = 150, H = 10, r = 2;
  const w = Math.max(0, W * fill - 1);
  const bar = w > 0
    ? `<rect x="0" y="0" width="${w.toFixed(1)}" height="${H}" rx="${r}" class="rung r2"/>` : "";
  return `<svg viewBox="0 0 ${W} ${H}" class="fillbar" role="img" aria-label="${pctText(fill)} of the mode's fill sequence">` +
    `<title>${pctText(fill)} of the mode's fill sequence (100% = the path top)</title>` +
    `<rect x="0" y="0" width="${W}" height="${H}" rx="${r}" class="fbtrack"/>${bar}` +
  `</svg>`;
}

// Monotone cubic interpolation (Fritsch–Carlson): a smooth path that cannot overshoot the data, so a
// curve of shares can never bulge above 100% or below 0 between samples.
function smoothPath(pts: { x: number; y: number }[]): string {
  const n = pts.length;
  if (n < 2) return "";
  const dx = [], slope = [];
  for (let i = 0; i < n - 1; i++) {
    dx.push(pts[i + 1].x - pts[i].x);
    slope.push((pts[i + 1].y - pts[i].y) / (pts[i + 1].x - pts[i].x));
  }
  const m = [slope[0]];
  for (let i = 1; i < n - 1; i++) {
    m.push(slope[i - 1] * slope[i] <= 0 ? 0 : (slope[i - 1] + slope[i]) / 2);
  }
  m.push(slope[n - 2]);
  for (let i = 0; i < n - 1; i++) {
    if (slope[i] === 0) { m[i] = 0; m[i + 1] = 0; continue; }
    const a = m[i] / slope[i], b = m[i + 1] / slope[i];
    const h = Math.hypot(a, b);
    if (h > 3) { m[i] = (3 / h) * a * slope[i]; m[i + 1] = (3 / h) * b * slope[i]; }
  }
  let d = `M ${pts[0].x.toFixed(1)},${pts[0].y.toFixed(1)}`;
  for (let i = 0; i < n - 1; i++) {
    const c1x = pts[i].x + dx[i] / 3, c1y = pts[i].y + (m[i] * dx[i]) / 3;
    const c2x = pts[i + 1].x - dx[i] / 3, c2y = pts[i + 1].y - (m[i + 1] * dx[i]) / 3;
    d += ` C ${c1x.toFixed(1)},${c1y.toFixed(1)} ${c2x.toFixed(1)},${c2y.toFixed(1)} ${pts[i + 1].x.toFixed(1)},${pts[i + 1].y.toFixed(1)}`;
  }
  return d;
}

// The frontier: for each mode, a solid curve for the base variables and a faint dashed curve per
// optional variable group, added one at a time (never in combination — that would be 32 lines). This
// is the regression chart: an encoding improvement pushes every curve right (more resolution for the
// same 160 characters), and because these are whole distributions you see *where* it lands rather
// than just a mean. x is fill percentage, which is what makes modes with different sequence
// lengths comparable on one axis.
function renderFrontier(s: ReportData): string {
  const W = 720, H = 300, m = { t: 28, r: 46, b: 42, l: 64 };
  const iw = W - m.l - m.r, ih = H - m.t - m.b;
  const x = (fill: number) => m.l + fill * iw;
  const y = (share: number) => m.t + ih * (1 - share);

  // Share of forecasts reaching at least each fill level, as plot coordinates. `views` is summed, so
  // one curve can pool several variable selections (each contributes the same forecasts).
  const reachPoints = (views: ViewStats[]) => {
    const maxSeq = views[0].maxSeq;
    const counts = new Array<number>(maxSeq + 1).fill(0);
    let total = 0;
    for (const vs of views) {
      for (const h of vs.histogram) { counts[h.seq] += h.count; total += h.count; }
    }
    const pts = [{ x: x(0), y: y(1) }];
    let reached = total;
    for (let seq = 1; seq <= maxSeq; seq++) {
      pts.push({ x: x(seq / maxSeq), y: y(total ? reached / total : 0) });
      reached -= counts[seq];
    }
    return pts;
  };

  // Direct labels on the plot: the mode on each solid curve, the variable selection on each
  // component curve. The palette's contrast/CVD warnings make this mandatory, not decorative —
  // identity never rests on colour alone. Labels sit at different shares so they don't collide.
  const draw = (
    views: ViewStats[], cls: string, label: string, share: number,
  ) => {
    const pts = reachPoints(views);
    const at = pts.find((p) => p.y >= y(share)) ?? pts[pts.length - 1];
    return `<path d="${smoothPath(pts)}" class="frontier ${cls}"/>` +
      `<text x="${(at.x + 5).toFixed(1)}" y="${(at.y - 5).toFixed(1)}" class="flabel ${cls}">${esc(label)}</text>`;
  };

  // One group per mode. The solid line pools exactly the selections drawn beneath it — the base
  // variables plus each optional group on its own — so it reads as the average of its components and
  // still moves when any single variable's encoding changes. (Pooling all 2^n *combinations* would
  // weight the heavy ones and pull the solid line away from the curves it sits among.) Components
  // stay hidden until the mode is hovered, so the chart is three lines at rest. The fat
  // transparent path over the solid curve is the hit target — a 2px line is too thin to hover.
  const groups = s.modes.map((md, i) => {
    const slot = i + 1;
    const components = [
      { combo: s.defaultCombo, label: "Base", share: 0.8 },
      ...s.groups.map((g, gi) => ({
        combo: 1 << gi, label: g.short, share: [0.65, 0.5, 0.35][gi] ?? 0.5,
      })),
    ].map((c, ci) => ({ ...c, dash: ci + 1, vs: s.views[`${md}:${c.combo}`] }))
      .filter((c) => c.vs);
    if (components.length === 0) return "";

    const componentSvg = components.map((c) =>
      draw([c.vs], `c${slot} variant dash${c.dash}`, c.label, c.share)).join("");
    const meanPts = reachPoints(components.map((c) => c.vs));
    return `<g class="dseries">${componentSvg}` +
      `${draw(components.map((c) => c.vs), `c${slot}`, modeLabel(md), 0.5)}` +
      `<path d="${smoothPath(meanPts)}" class="fhit"/></g>`;
  }).join("");

  const yAxis = [0, 0.25, 0.5, 0.75, 1].map((v) =>
    `<line x1="${m.l}" y1="${y(v).toFixed(1)}" x2="${W - m.r}" y2="${y(v).toFixed(1)}" class="hgrid"/>` +
    `<text x="${m.l - 8}" y="${(y(v) + 3.5).toFixed(1)}" class="htick" text-anchor="end">${(100 * v).toFixed(0)}%</text>`).join("");

  // The modes' paths differ in length and shape, so the x-axis carries plain fill-percentage
  // ticks (per-mode anchor marks live on the detail views' reach charts).
  const xAxis = [0.25, 0.5, 0.75, 1].map((fill, k, arr) => {
    const anchor = k === arr.length - 1 ? "end" : "middle";
    return `<line x1="${x(fill).toFixed(1)}" y1="${m.t}" x2="${x(fill).toFixed(1)}" y2="${y(0).toFixed(1)}" class="mark"/>` +
      `<text x="${x(fill).toFixed(1)}" y="${H - m.b + 16}" class="htick" text-anchor="${anchor}">${pctText(fill)}</text>`;
  }).join("");

  return `<svg viewBox="0 0 ${W} ${H}" class="hist frontier-chart" role="img" aria-label="Share of forecasts reaching each fill level, by priority mode">
  ${yAxis}${xAxis}${groups}
  <text x="${m.l + iw / 2}" y="${H - 4}" class="haxis" text-anchor="middle">FILL PERCENTAGE</text>
  <text x="12" y="${m.t + ih / 2}" class="haxis" text-anchor="middle" transform="rotate(-90 12 ${m.t + ih / 2})">PERCENT OF FORECASTS</text>
</svg>`;
}

function renderModeComparison(s: ReportData): string {
  const configurations = [
    { label: "Base", combo: 0 },
    ...s.groups.map((g, i) => ({ label: `+${g.label}`, combo: 1 << i })),
  ];
  const head = s.modes.map((m) => `<th>${esc(modeLabel(m))}</th>`).join("");
  const view = (m: number, combo: number) => s.views[`${m}:${combo}`];
  // One row per mode: the median message it produces, drawn. Every row shares the same day
  // pitch, so the modes' different shapes — hourly front vs whole-horizon coverage — read
  // directly as colour and coverage down the stack.
  const perMode = s.modes.map((m) => {
    const vs = view(m, s.defaultCombo);
    return `<div class="striprow">
      <div class="striplabel"><strong>${esc(modeLabel(m))}</strong> · ${pctText(vs.medianSeq / vs.maxSeq)} filled</div>
      ${renderLayoutStrip(vs, vs.medianSeq, s.requestHour, FILL_SLOTS)}
    </div>`;
  }).join("\n");
  const rows = configurations.map(({ label, combo }) => `<tr><td class="name">${esc(label)}</td>` +
    s.modes.map((m) => {
      const fill = fillBox(view(m, combo)).mean;
      return `<td><div class="pcell"><span class="pmean">${pctText(fill)}</span>${renderFillBar(fill)}</div></td>`;
    }).join("") + `</tr>`).join("\n");
  return `<h2>Median message by priority mode</h2>
  <p class="note">The chart shows the layout of the median message in each priority mode.</p>
  ${renderRungLegend()}
  <div class="striphead"><div></div>${renderStripAxis(FILL_SLOTS)}</div>
  <div class="strips">${perMode}</div>
  <h2>Mean fill percentage by priority mode and variable selection</h2>
  <table class="period-comparison">
    <tr><th>Variables</th>${head}</tr>
    ${rows}
  </table>
  <h2>Fill frontier</h2>
  <p class="note">Percent of forecasts reaching each fill level, averaged over the base
  variables and each optional variable added on its own — so the line moves when any variable's
  encoding changes. An encoding improvement moves the curves to the right. Hover a mode to break
  it into those component curves.</p>
  <div class="legend"><span class="legend-label">mode</span>${s.modes.map((m, i) =>
    `<span class="key"><i class="sw c${i + 1}"></i>${esc(modeLabel(m))}</span>`).join("")}</div>
  ${renderFrontier(s)}`;
}

// The per-stratum breakdown: where the format struggles by climate. Only rendered when the run
// actually spans strata (a --location run has one group — nothing to compare).
function renderStrata(s: ReportData): string {
  if (s.strata.length <= 1) return "";
  const head = s.modes.map((m) => `<th>${esc(modeLabel(m))}</th>`).join("");
  const rows = s.strata.map((st) =>
    `<tr><td class="name">${esc(st.group)}</td><td class="num">${st.locations}</td>` +
    st.perMode.map((p) => p.n === 0
      ? `<td class="num">—</td>`
      : `<td><div class="pcell" title="${p.n} messages · ${p.bpp.toFixed(2)} body bits/period"><span class="pmean">${p.fillPct.toFixed(1)}%</span>${renderFillBar(p.fillPct / 100)}</div></td>`,
    ).join("") + `</tr>`).join("\n");
  return `<h2>Mean fill percentage by corpus stratum</h2>
  <p class="note">Base variables only. Sampled land sites roll up to Köppen major groups (A tropical,
  B arid, C temperate, D continental, E polar) and ocean sites to 30° latitude bands; favorites are
  the curated registry, always held out of codebook training. Hover a cell for the message count and
  body bits/period.</p>
  <table class="period-comparison">
    <tr><th>Stratum</th><th class="rt">locations</th>${head}</tr>
    ${rows}
  </table>`;
}

// One toggleable view = a mode × variable-combo: fill summary, the percentile strips, the seq
// histogram, and the occupancy table. All are emitted hidden; the client shows the selected one.
function renderView(vk: string, vs: ViewStats, versionBits: number, headerBits: number, requestHour: number): string {
  const [mode, combo] = vk.split(":");
  const occupancyBits = versionBits + headerBits + vs.bodyBits;
  const rows = [
    { name: "version", bits: versionBits, bpp: null as number | null, bppStats: null as BoxStats | null },
    { name: "header", bits: headerBits, bpp: null as number | null, bppStats: null as BoxStats | null },
    ...vs.columns.map((c) => ({ name: c.name, bits: c.bits, bpp: c.bitsPerPeriod as number | null, bppStats: c.bppStats as BoxStats | null })),
  ].sort((a, b) => b.bits - a.bits);
  const bppScaleMax = Math.max(...vs.columns.map((c) => c.bppStats.max), 1);
  const occHtml = rows.map((r) => `<tr>
      <td class="name">${esc(r.name)}</td>
      <td class="num">${r.bits.toFixed(1)}</td>
      <td class="num">${r.bpp == null ? "—" : r.bpp.toFixed(2)}</td>
      <td class="num">${(100 * r.bits / occupancyBits).toFixed(1)}%</td>
      <td class="boxcell">${r.bppStats ? renderMiniBox(r.bppStats, bppScaleMax) : ""}</td>
    </tr>`).join("\n");
  return `<section class="view" data-mode="${mode}" data-combo="${combo}" hidden>
  <h3>Fill resolution distribution</h3>
  <div class="strips">${renderPercentileStrips(vs, requestHour)}</div>
  <h3>Percent of forecasts reaching each fill resolution</h3>
  ${renderReachArea(vs)}
  <h3>Mean bit cost per column</h3>
  <table>
    <tr><th>column</th><th class="rt">bits</th><th class="rt">bits/period</th><th class="rt">share</th><th>bits/period spread <span class="muted">(0–${bppScaleMax.toFixed(1)})</span></th></tr>
    ${occHtml}
    <tr class="total"><td>total</td><td class="num">${occupancyBits.toFixed(1)}</td><td class="num"></td><td class="num">100%</td><td class="modes">≈ ${Math.round(occupancyBits / 6.409)} chars</td></tr>
  </table>
</section>`;
}

function renderHtml(s: ReportData): string {
  const viewFragments = Object.entries(s.views).map(([vk, vs]) => renderView(vk, vs, s.versionBits, s.headerBits, s.requestHour)).join("\n");
  const comparison = renderModeComparison(s);
  const modeRadios = s.modes.map((m) =>
    `<label><input type="radio" name="mode" value="${m}"${m === s.defaultMode ? " checked" : ""}> ${esc(modeLabel(m))}</label>`).join("");
  const groupChecks = s.groups.map((g, i) =>
    `<label><input type="checkbox" class="group" value="${g.id}" data-bit="${1 << i}"${s.defaultCombo & (1 << i) ? " checked" : ""}> ${esc(g.label)}</label>`).join("");
  const notes = [
    s.skipped ? `Skipped ${s.skipped} forecast(s) with an incomplete base series.` : "",
    s.uncovered ? `Skipped ${s.uncovered} (forecast, mode) pair(s) the corpus window doesn't cover.` : "",
    s.dropped.length ? `Dropped ${s.dropped.map(modeLabel).join(", ")} entirely — no forecast in the corpus covers that mode. Re-collect: the cached windows are shorter than the ${HORIZON_DAYS}-day window this report needs.` : "",
  ].filter(Boolean);
  const quality = notes.length ? `<div class="quality">${notes.map((n) => `<p>${esc(n)}</p>`).join("")}</div>` : "";

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Going Blue Encoding Benchmark — ${esc(s.timestamp)}</title>
<style>
  /* Resolution rungs: one hue, coarse → fine (an ordinal ramp; both modes validated against their
     own surface, so dark is its own steps rather than a flip of light). */
  :root {
    color-scheme: light dark;
    /* Every chart spans this width, so they all share the same left and right edges. */
    --chart-w: 900px;
    --r1: #86b6ef;  /* 12h — coarsest */
    --r2: #3987e5;  /* 6h  */
    --r3: #1c5cab;  /* 3h  */
    --r4: #0d366b;  /* 1h  — finest */
  }
  /* Duration series on the frontier chart: categorical, fixed slot order (the ordering is the
     CVD-safety mechanism, not cosmetic). Dark mode gets its own steps for the dark surface. */
  :root { --c1: #2a78d6; --c2: #1baf7a; --c3: #eda100; --c4: #008300; }
  @media (prefers-color-scheme: dark) {
    :root { --r1: #184f95; --r2: #2a78d6; --r3: #6da7ec; --r4: #cde2fb; }
    :root { --c1: #3987e5; --c2: #199e70; --c3: #c98500; --c4: #008300; }
  }
  /* One centred column; content inside it stays left-aligned and spans the full column width. */
  body { font: 14px/1.5 -apple-system, system-ui, sans-serif; margin: 0 auto; padding: 2rem; max-width: var(--chart-w); }
  h1 { font-size: 1.4rem; margin: 0 0 .25rem; }
  h2 { font-size: 1rem; margin: 2rem 0 .6rem; }
  h3 { font-size: .9rem; margin: 1.5rem 0 .4rem; color: #666; }
  .meta { color: #888; font-size: .85rem; margin-bottom: 1rem; }
  .meta code { background: rgba(128,128,128,.15); padding: .05rem .35rem; border-radius: 3px; }
  .selectors { display: flex; flex-wrap: wrap; gap: 1.5rem; padding: .9rem 1.1rem; background: rgba(128,128,128,.08); border-radius: 8px; margin: 1rem 0 .4rem; }
  .sel { display: flex; align-items: center; gap: .7rem; flex-wrap: wrap; }
  .sel-label { font-size: .7rem; text-transform: uppercase; letter-spacing: .05em; color: #888; }
  .sel label { display: inline-flex; align-items: center; gap: .3rem; font-size: .85rem; cursor: pointer; }
  .muted { color: #999; }
  .quality { background: rgba(230,160,30,.12); border-left: 3px solid #e6a01e; padding: .6rem .9rem; border-radius: 4px; font-size: .85rem; margin: 1rem 0; }
  .quality p { margin: .2rem 0; }
  table { width: 100%; border-collapse: collapse; font-variant-numeric: tabular-nums; }
  th, td { text-align: left; padding: .35rem .5rem; border-bottom: 1px solid rgba(128,128,128,.2); }
  th { font-size: .75rem; text-transform: uppercase; letter-spacing: .04em; color: #888; }
  th.rt { text-align: right; }
  td.num { text-align: right; font-family: ui-monospace, monospace; }
  td.name { font-weight: 500; }
  td.modes { color: #888; font-size: .8rem; }
  tr.total td { font-weight: 600; border-top: 2px solid rgba(128,128,128,.4); border-bottom: none; }
  .hist { width: 100%; max-width: var(--chart-w); height: auto; margin: .5rem 0 .25rem; }
  .area { stroke: none; }
  .frontier { fill: none; stroke-width: 2; }
  .frontier.c1 { stroke: var(--c1); } .frontier.c2 { stroke: var(--c2); }
  .frontier.c3 { stroke: var(--c3); } .frontier.c4 { stroke: var(--c4); }
  .frontier.variant { stroke-width: 1.5; stroke-opacity: .5; }
  .flabel.variant { font-size: 10px; font-weight: 500; }
  /* One dash pattern per variable selection, so the components are told apart by shape as well as
     by their label — colour is already spent on the duration. */
  .frontier.dash1 { stroke-dasharray: 9 3; }
  .frontier.dash2 { stroke-dasharray: 5 3; }
  .frontier.dash3 { stroke-dasharray: 2 2; }
  .frontier.dash4 { stroke-dasharray: 1 3; }
  /* A duration's component curves stay hidden until that duration is hovered: four lines at rest,
     one duration's detail at a time. The .fhit path is a fat invisible line over the solid curve —
     a 2px stroke is far too thin to hover; the hidden components must not steal the pointer. */
  .fhit { fill: none; stroke: transparent; stroke-width: 16; pointer-events: stroke; }
  .dseries .variant { opacity: 0; pointer-events: none; transition: opacity .12s ease; }
  .dseries:hover .variant { opacity: 1; }
  /* Hovering one duration recedes the others — line and name together. Only the solid series is
     touched: :not(.variant) keeps this from out-specifying the rule that hides components, which
     would otherwise reveal every duration's component labels at once. */
  .frontier-chart:hover .dseries:not(:hover) .frontier:not(.variant) { stroke-opacity: .2; }
  .frontier-chart:hover .dseries:not(:hover) .flabel:not(.variant) { fill: #999; opacity: .5; }
  .flabel { font-size: 11px; font-weight: 600; font-variant-numeric: tabular-nums; }
  .flabel.c1 { fill: var(--c1); } .flabel.c2 { fill: var(--c2); }
  .flabel.c3 { fill: var(--c3); } .flabel.c4 { fill: var(--c4); }
  .sw.c1 { background: var(--c1); } .sw.c2 { background: var(--c2); }
  .sw.c3 { background: var(--c3); } .sw.c4 { background: var(--c4); }
  .bwhisker { stroke: #888; stroke-width: 1.5; }
  .bbox { fill: rgba(59,130,246,.25); stroke: #3b82f6; stroke-width: 1.5; }
  .bmedian { stroke: #3b82f6; stroke-width: 2; }
  .bmean { fill: #e6a01e; }
  .boxcell { width: 210px; }
  .mbox { display: block; width: 200px; height: 20px; }
  .reachline { fill: none; stroke: #555; stroke-width: 1.5; }
  @media (prefers-color-scheme: dark) { .reachline { stroke: #ddd; } }
  .hit { fill: transparent; }
  .hgrid { stroke: rgba(128,128,128,.25); stroke-width: 1; }
  .htick { fill: #888; font-size: 11px; }
  .haxis { fill: #888; font-size: 9.5px; letter-spacing: .06em; }
  table.period-comparison { width: 100%; max-width: var(--chart-w); }
  .pcell { display: grid; grid-template-columns: 3.3rem 1fr; align-items: center; gap: .4rem; }
  .pmean { font: .78rem ui-monospace, monospace; white-space: nowrap; }
  .fillbar { display: block; width: 100%; max-width: 150px; height: 10px; }
  .fbtrack { fill: rgba(128,128,128,.18); }
  .mark { stroke: #e6a01e; stroke-width: 1; stroke-dasharray: 3 3; }
  .marklabel { fill: #e6a01e; font-size: 10px; font-variant-numeric: tabular-nums; }
  .strips { max-width: var(--chart-w); margin: .4rem 0 1.25rem; }
  .striphead, .striprow { display: grid; grid-template-columns: 8.5rem 1fr; align-items: center; gap: .7rem; max-width: var(--chart-w); }
  .striphead.indent { padding-left: 2.2rem; } /* clears the entropy axis, so the day labels stay aligned */
  .striprow { padding: .18rem 0; }
  .stripwrap { display: flex; align-items: stretch; gap: .6rem; max-width: var(--chart-w); }
  .stripstack { flex: 1; min-width: 0; }
  .entropy-axis { width: 1.6rem; display: flex; flex-direction: column; align-items: center;
    color: #888; font-size: .66rem; text-transform: uppercase; letter-spacing: .04em; }
  .entropy-axis span:not(.entropy-line) { writing-mode: vertical-rl; transform: rotate(180deg); white-space: nowrap; }
  /* The rule spans the stack, arrowheaded at both ends: up toward stormy (p1), down toward stable (p99). */
  .entropy-line { position: relative; flex: 1; width: 1px; min-height: 1.2rem; margin: .35rem 0; background: rgba(128,128,128,.4); }
  .entropy-line::before, .entropy-line::after { content: ""; position: absolute; left: 50%; transform: translateX(-50%);
    border-left: 3.5px solid transparent; border-right: 3.5px solid transparent; }
  .entropy-line::before { top: -1px; border-bottom: 6px solid rgba(128,128,128,.55); }
  .entropy-line::after { bottom: -1px; border-top: 6px solid rgba(128,128,128,.55); }
  .striplabel { font-size: .78rem; font-variant-numeric: tabular-nums; white-space: nowrap; color: #888; }
  .striplabel strong { font-size: .9rem; color: inherit; }
  .strip, .stripaxis { width: 100%; height: auto; display: block; }
  .legend { display: flex; flex-wrap: wrap; align-items: center; gap: .8rem; margin: .5rem 0 .4rem; font-size: .76rem; color: #888; }
  .legend-label { font-size: .7rem; text-transform: uppercase; letter-spacing: .05em; }
  .key { display: inline-flex; align-items: center; gap: .3rem; }
  .sw { display: inline-block; width: 11px; height: 11px; border-radius: 2px; }
  .sw.r1 { background: var(--r1); } .sw.r2 { background: var(--r2); }
  .sw.r3 { background: var(--r3); } .sw.r4 { background: var(--r4); }
  .rung.r1 { fill: var(--r1); }
  .rung.r2 { fill: var(--r2); }
  .rung.r3 { fill: var(--r3); }
  .rung.r4 { fill: var(--r4); }
  .slot-past { fill: rgba(128,128,128,.15); }
  .slot-empty { fill: none; stroke: rgba(128,128,128,.4); stroke-width: 1; stroke-dasharray: 3 3; }
  .sliplabel { fill: #888; font-size: 10px; font-variant-numeric: tabular-nums; }
  .intro { max-width: var(--chart-w); margin: 1rem 0 1.75rem; }
  .intro p { margin: .5rem 0; }
  .note { color: #777; font-size: .82rem; max-width: 640px; margin: .2rem 0 .8rem; }
  .note code { background: rgba(128,128,128,.15); padding: .05rem .3rem; border-radius: 3px; }
</style>
</head>
<body>
<h1>Going Blue Encoding Benchmark</h1>
<div class="meta">
  ${esc(s.timestamp)} · ${s.forecasts} forecasts · ${s.locations} locations · ${esc(s.model)} ·
  split <code>${esc(s.split)}</code> · max <code>${s.maxChars}</code> chars ·
  request at <code>${s.requestHour}:00</code> local
</div>

<div class="intro">
  <p>Going Blue uses an entropy coding scheme where the number of forecast periods in each message
  depends on the entropy of the weather forecast. Forecasts for stable conditions with little entropy
  use far less information than those for stormy, variable conditions. This dashboard helps visualize
  how much data is transmitted at each forecast length.</p>

  <p>The user picks a priority mode — Detail, Auto, or Range — and the server fills the message
  by walking that mode's refinement path: every step either covers one more day at 12h or makes
  one covered day a rung finer. Detail plays resolution first (hourly detail before coverage),
  Range plays coverage first (the whole 12-day horizon before any refinement), and Auto
  balances the two. How far the fill gets along the path is expressed through a sequence number;
  the highest value is the top of the mode's path.</p>

  <p>The units of this dashboard are fill percentage, which represents the sequence number as a
  percentage of the maximum possible.</p>
</div>

${comparison}

${renderStrata(s)}

<h2>Benchmark detail</h2>
<div class="selectors">
  <div class="sel"><span class="sel-label">Priority</span>${modeRadios}</div>
  <div class="sel"><span class="sel-label">Variables</span>${groupChecks}</div>
</div>
${quality}

<div id="views">${viewFragments}</div>

<script>
const views = [...document.querySelectorAll(".view")];
const modeRadios = [...document.querySelectorAll('input[name=mode]')];
const groupBoxes = [...document.querySelectorAll('input.group')];

const mode = () => modeRadios.find((r) => r.checked).value;
const combo = () => groupBoxes.reduce((c, b) => c | (b.checked ? +b.dataset.bit : 0), 0);

function update() {
  const m = mode(), c = combo();
  views.forEach((v) => v.hidden = !(v.dataset.mode === m && +v.dataset.combo === c));
}

[...modeRadios, ...groupBoxes].forEach((el) => el.addEventListener("change", update));
update();
</script>
</body>
</html>
`;
}

// ── Inspection: --validate and --dump ───────────────────────────────────────────────

// Sanity envelopes for the range check — values outside these are units bugs, not weather.
const RANGE_CHECKS: Record<string, [number, number]> = {
  temperature_2m: [-95, 60],          // °C
  wind_speed_10m: [0, 400],           // km/h
  freezing_level_height: [0, 10_000], // m
  snowfall: [0, 50],                  // cm/h
  rain: [0, 300],                     // mm/h
  cape: [0, 10_000],                  // J/kg
  pressure_msl: [850, 1090],          // hPa
};

// Data-quality report over the corpus DB (see CorpusPlan.md, Phase 2): the capability matrix is
// what settles per-center variable availability (GEM freezing level, visibility/CAPE, 600/400
// levels) before the backfill is committed. The drift section re-fetches a few stored
// gfs cells and compares — the archive should be stable; differences mean it revises data.
// Tolerance covers the fetch path's 2 dp rounding vs the old JSON tree's per-variable rounding.
async function validate(args: Args): Promise<void> {
  const db = openDb();
  const windows = sampleWindows();

  console.log(`== Corpus DB: ${DB_PATH.replace(REPO_ROOT + "/", "")} ==`);
  const sums = db.prepare(
    `SELECT source, count(DISTINCT location_id) locs, count(DISTINCT window_start) windows,
            count(*) rows, min(window_start) oldest, max(window_start) newest
     FROM series GROUP BY source ORDER BY source`,
  ).all() as { source: string; locs: number; windows: number; rows: number; oldest: string; newest: string }[];
  if (sums.length === 0) { console.log("  (empty — collect or import first)"); db.close(); return; }
  for (const s of sums) {
    console.log(`  ${s.source.padEnd(14)} ${String(s.rows).padStart(7)} rows  ${String(s.locs).padStart(4)} locations  ${String(s.windows).padStart(4)}/${windows.length} windows  ${s.oldest} … ${s.newest}`);
  }

  console.log(`\n== Capability matrix (% non-null; blank = never fetched) ==`);
  const caps = db.prepare(
    `SELECT source, variable, count(*) n, sum(null_count) nulls FROM series GROUP BY source, variable`,
  ).all() as { source: string; variable: string; n: number; nulls: number }[];
  const sources = sums.map((s) => s.source);
  const variables = [...new Set(caps.map((c) => c.variable))].sort();
  const capOf = new Map(caps.map((c) => [`${c.source}|${c.variable}`, 100 * (1 - c.nulls / (c.n * WINDOW_HOURS))]));
  console.log(`  ${"variable".padEnd(28)}${sources.map((s) => s.padStart(15)).join("")}`);
  for (const v of variables) {
    const cols = sources.map((s) => {
      const pct = capOf.get(`${s}|${v}`);
      return (pct === undefined ? "" : pct === 0 ? "MISSING" : `${pct.toFixed(pct < 99 ? 1 : 0)}%`).padStart(15);
    });
    console.log(`  ${v.padEnd(28)}${cols.join("")}`);
  }

  console.log(`\n== Pinned-elevation check (registry elev_m vs model grid) ==`);
  const pins = db.prepare(
    `SELECT m.source, m.location_id, l.elev_m, m.model_elevation
     FROM location_meta m JOIN locations l ON l.id = m.location_id
     WHERE l.elev_m IS NOT NULL ORDER BY m.location_id, m.source`,
  ).all() as { source: string; location_id: string; elev_m: number; model_elevation: number }[];
  if (pins.length === 0) console.log("  (no pinned locations collected yet)");
  for (const p of pins) {
    const ok = Math.abs(p.model_elevation - p.elev_m) < 1;
    console.log(`  ${p.location_id.padEnd(20)} ${p.source.padEnd(14)} pinned ${p.elev_m}m → model ${p.model_elevation}m ${ok ? "" : " ⚠ pin not honoured"}`);
  }

  console.log(`\n== Range sanity (json_each over every stored hour) ==`);
  for (const [variable, [lo, hi]] of Object.entries(RANGE_CHECKS)) {
    const rows = db.prepare(
      `SELECT s.source, min(je.value) lo, max(je.value) hi
       FROM series s, json_each(s.values_json) je
       WHERE s.variable = ? AND je.value IS NOT NULL GROUP BY s.source`,
    ).all(variable) as { source: string; lo: number; hi: number }[];
    for (const r of rows) {
      const bad = r.lo < lo || r.hi > hi;
      console.log(`  ${variable.padEnd(24)} ${r.source.padEnd(14)} [${r.lo} … ${r.hi}]${bad ? `  ⚠ outside [${lo} … ${hi}]` : ""}`);
    }
  }

  // Drift: re-fetch a few stored cells (no writes) and diff. Skipped quietly when offline.
  console.log(`\n== Archive drift (re-fetch vs stored, ${REPORT_SOURCE.id}) ==`);
  const sample = db.prepare(
    `SELECT DISTINCT location_id, window_start FROM series WHERE source = ? ORDER BY random() LIMIT 3`,
  ).all(REPORT_SOURCE.id) as { location_id: string; window_start: string }[];
  const locs = dbLocations(db);
  for (const cell of sample) {
    const loc = locs.get(cell.location_id);
    if (!loc) continue;
    const stored = db.prepare(
      `SELECT variable, values_json FROM series WHERE source = ? AND location_id = ? AND window_start = ?`,
    ).all(REPORT_SOURCE.id, cell.location_id, cell.window_start) as { variable: string; values_json: string }[];
    try {
      const res = await fetchWindow({
        apiModel: REPORT_SOURCE.id, lat: loc.lat, lon: loc.lon, elevM: loc.elev_m ?? undefined,
        windowStart: cell.window_start, variables: stored.map((s) => s.variable),
      });
      // Compare in units of each variable's stored quantum: rows imported from the JSON tree
      // carry that API's per-variable rounding (wind direction is whole degrees), coarser than
      // the fetch path's 2 dp, and .5 edge cases round differently between the two paths — so
      // one quantum of disagreement is representation noise; more is a real archive revision.
      let worst = 0, worstVar = ""; // in quanta
      for (const s of stored) {
        const fresh = res.series.get(s.variable)?.values ?? [];
        const old = JSON.parse(s.values_json) as (number | null)[];
        const decimals = old.reduce<number>((d, v) =>
          Math.max(d, v == null ? 0 : (String(v).split(".")[1]?.length ?? 0)), 0);
        const quantum = Math.pow(10, -decimals);
        for (let i = 0; i < old.length; i++) {
          if (old[i] == null || fresh[i] == null) continue;
          const d = Math.abs(old[i]! - fresh[i]!) / quantum;
          if (d > worst) { worst = d; worstVar = s.variable; }
        }
      }
      console.log(`  ${cell.location_id} ${cell.window_start}: max |Δ| ${worst.toFixed(2)} quanta${worstVar ? ` (${worstVar})` : ""}${worst > 1.001 ? "  ⚠ archive revised since stored" : ""}`);
    } catch (err) {
      console.log(`  ${cell.location_id} ${cell.window_start}: re-fetch failed (${(err as Error).message.slice(0, 80)}) — skipping drift`);
    }
  }

  db.close();
  void args;
}

// Inspect one (source, location, window) cell — the debugging replacement for greppable files.
function dump(source: string, locationId: string, windowStart: string): void {
  const db = openDb();
  const rows = db.prepare(
    `SELECT variable, values_json, unit, fetched_at, null_count
     FROM series WHERE source = ? AND location_id = ? AND window_start = ? ORDER BY variable`,
  ).all(source, locationId, windowStart) as
    { variable: string; values_json: string; unit: string | null; fetched_at: string; null_count: number }[];
  if (rows.length === 0) {
    console.log(`no rows for (${source}, ${locationId}, ${windowStart})`);
    const near = db.prepare(`SELECT DISTINCT window_start FROM series WHERE source = ? AND location_id = ? LIMIT 5`).all(source, locationId) as { window_start: string }[];
    if (near.length) console.log(`windows present for that location: ${near.map((n) => n.window_start).join(", ")} …`);
    db.close();
    return;
  }
  console.log(`${source} / ${locationId} / ${windowStart} — ${rows.length} variables, fetched ${rows[0].fetched_at}`);
  for (const r of rows) {
    const values = JSON.parse(r.values_json) as (number | null)[];
    const nums = values.filter((v): v is number => v != null);
    const stats = nums.length
      ? `min ${Math.min(...nums)} max ${Math.max(...nums)} mean ${(nums.reduce((a, b) => a + b, 0) / nums.length).toFixed(2)}`
      : "all null";
    console.log(`  ${r.variable.padEnd(28)} ${(r.unit ?? "").padEnd(22)} nulls ${String(r.null_count).padStart(3)}/${values.length}  ${stats}`);
    console.log(`    ${values.slice(0, 8).map((v) => v ?? "·").join(", ")} …`);
  }
  db.close();
}

// ── Entry ──────────────────────────────────────────────────────────────────────────

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.dump) return dump(...args.dump);
  if (args.validate) return validate(args);
  const locations = args.location ? LOCATIONS.filter((l) => l.id === args.location) : LOCATIONS;
  if (locations.length === 0) throw new Error(`No location matches --location ${args.location}`);

  if (!args.reportOnly) await collect(args, locations);
  if (args.dryRun || args.collectOnly) return; // preview / expand-DB only — don't encode
  await report(args);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
