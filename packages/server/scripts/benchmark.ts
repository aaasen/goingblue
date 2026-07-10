/**
 * Benchmark the forecast encoding against a corpus of real forecasts.
 *
 * One script, two phases:
 *   1. Collect — pull 10-day hourly HRES forecasts from Open-Meteo's Single Runs API (each run is a
 *      full model initialisation, queryable by its UTC init time via `&run=`), one every ~10 days
 *      from ARCHIVE_START (2026-04-02) to now, per location. Raw responses are cached to disk
 *      unchanged (idempotent/resumable), so re-runs don't re-hit the API.
 *   2. Report — for each cached forecast, run the exact production path (aggregateHourly →
 *      toFullPeriod → the v1 codec, via v1EncodeBreakdown) and binary-search the largest prefix of
 *      periods that fits one message. Report how many periods fit and how the bit budget splits
 *      across the header and each variable column (with the adaptive mode each column chose).
 *
 *   node packages/server/scripts/benchmark.ts                     # collect (idempotent) then report
 *   node packages/server/scripts/benchmark.ts --dry-run           # preview collection plan, no fetch
 *   node packages/server/scripts/benchmark.ts --resolution 6h     # daily/12h/6h/3h/1h (default 1h)
 *   node packages/server/scripts/benchmark.ts --location denali --verbose
 *   # other flags: --limit <n> (cap fetches), --max-chars <n>, --include-incomplete
 *
 * Open-Meteo call weight ≈ max(1, nVars/10) × max(1, weeks/2). HRES drops the pressure/freezing
 * columns, so each 10-day call is ~1.2 units. Free tier is 10,000 units/day.
 */
import { mkdir, readdir, readFile, writeFile, access } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { aggregateHourly, toFullPeriod, HOURS_PER_PERIOD, type HourlyData, type Row } from "../src/forecast.ts";
import { VARS_BIT, v1EncodeBreakdown, type ForecastMessage } from "@weather/protocol";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, "..", "..", "..");
const CORPUS_DIR = join(REPO_ROOT, "corpus", "raw");

// ── Collection config ────────────────────────────────────────────────────────────

// HRES (ecmwf_ifs) surface variables — mirrors SURFACE_VARS in server/src/forecast.ts minus:
//  - freezing_level_height: HRES does not provide it (see MODEL_NO_PRESSURE there);
//  - precipitation_probability: only produced by ECMWF's *ensemble* model (ecmwf_ifs025_ensemble),
//    which single-runs rejects as "model run not available". HRES has no deterministic precip
//    probability anyway, and the protocol's precip-prob column is a constant 3-bit fixed field, so
//    its absence does not affect encoding-strategy comparisons.
// Pressure-level wind/temp are also absent from HRES, so they are not requested.
const HRES_HOURLY_VARS = [
  "temperature_2m",
  "wind_speed_10m",
  "wind_direction_10m",
  "wind_gusts_10m",
  "weather_code",
  "snowfall",
  "rain",
  "showers",
  "cloud_cover",
  "cloud_cover_high",
  "cloud_cover_mid",
  "cloud_cover_low",
];

const COLLECT_MODEL = "ecmwf_ifs"; // HRES, as named by the Open-Meteo API
const ENDPOINT = "https://single-runs-api.open-meteo.com/v1/forecast";
// Sample only from 2026-04-02, when the single-runs archive begins for ALL models (HRES alone goes
// back to 2024-03-14, but those older runs are frequently incomplete — whole variables come back
// null — and we want a window that stays valid when other models are added later). This limits us
// to NH spring/summer for now; southern-hemisphere locations cover the other weather regimes. Re-run
// with an earlier start once more of the archive matures.
const ARCHIVE_START = Date.UTC(2026, 3, 2); // 2026-04-02

const HORIZON_DAYS = 10;
// Candidate run hours per sampled day, in preference order: prefer 00Z, fall back to 12Z when a
// day's 00Z run is missing from the archive (some runs simply aren't stored).
const RUN_HOURS = [0, 12];
const CADENCE_DAYS = 10; // one forecast every ~10 days
const ANCHOR_LAG_DAYS = 2; // start from N days ago so the latest run is fully archived

interface Location {
  id: string;
  name: string;
  lat: number;
  lon: number;
  elev_m?: number; // pin model elevation (curated peaks); omit for generic grid points
}

// Curated locations. Starting with Denali only; more curated peaks + random global points to come.
const LOCATIONS: Location[] = [
  { id: "denali", name: "Denali summit", lat: 63.069, lon: -151.003, elev_m: 6096 },
];

// ── Report config ────────────────────────────────────────────────────────────────

const RESOLUTION_IDX: Record<string, number> = { daily: 0, "12h": 1, "6h": 2, "3h": 3, "1h": 4 };
const ENCODE_MODEL = "HRES"; // corpus is HRES-only; toFullPeriod strips the pressure/freeze columns

// Variables encoded in the benchmark: the HRES-available surface columns the v1 protocol can carry.
// weathercode is always encoded. precip (probability) is excluded — HRES has no deterministic value
// and it isn't collected; freeze / 500-700 hPa winds are excluded — HRES doesn't provide them.
// wind_gusts_10m is collected but the v1 model has no gust field yet, so it isn't encoded here.
const BENCH_VARS = ["temp", "tmin", "snow", "rain", "wind", "cc", "cch", "ccm", "ccl"] as const;
const BENCH_MASK = BENCH_VARS.reduce((m, v) => m | (1 << VARS_BIT[v]), 0);

const V1_MAX_PERIODS = 128;

// Raw Open-Meteo series backing each encoded column. A forecast is skipped if any column has no
// data at all (every value null), because nulls coerce to 0 downstream and would silently encode as
// an all-zero column — indistinguishable from a genuinely calm/clear/0°C forecast, and it inflates
// how many periods "fit". rain sums rain + showers, so it counts as present if either has data.
const REQUIRED_COLUMNS: { column: string; anyOf: string[] }[] = [
  { column: "weathercode", anyOf: ["weather_code"] },
  { column: "temp/tmin", anyOf: ["temperature_2m"] },
  { column: "snow", anyOf: ["snowfall"] },
  { column: "rain", anyOf: ["rain", "showers"] },
  { column: "wind", anyOf: ["wind_speed_10m"] },
  { column: "cc", anyOf: ["cloud_cover"] },
  { column: "cch", anyOf: ["cloud_cover_high"] },
  { column: "ccm", anyOf: ["cloud_cover_mid"] },
  { column: "ccl", anyOf: ["cloud_cover_low"] },
];

// ── CLI ──────────────────────────────────────────────────────────────────────────

interface Args {
  // collect
  limit: number;    // max fetches this run (0 = unlimited); use a small value to verify first
  dryRun: boolean;  // preview the collection plan and estimated weight, fetch nothing, no report
  // report
  resolution: string;
  maxChars: number;
  verbose: boolean;
  includeIncomplete: boolean;
  // shared
  location?: string;
}

function parseArgs(argv: string[]): Args {
  const args: Args = {
    limit: 0, dryRun: false, resolution: "1h", maxChars: 160, verbose: false, includeIncomplete: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--dry-run") args.dryRun = true;
    else if (a === "--verbose") args.verbose = true;
    else if (a === "--include-incomplete") args.includeIncomplete = true;
    else if (a === "--limit") args.limit = parseInt(argv[++i], 10) || 0;
    else if (a === "--resolution") args.resolution = argv[++i];
    else if (a === "--max-chars") args.maxChars = parseInt(argv[++i], 10);
    else if (a === "--location") args.location = argv[++i];
    else throw new Error(`Unknown argument: ${a}`);
  }
  if (!(args.resolution in RESOLUTION_IDX)) {
    throw new Error(`--resolution must be one of ${Object.keys(RESOLUTION_IDX).join(", ")}`);
  }
  return args;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ── Phase 1: collect ───────────────────────────────────────────────────────────────

function runIso(ms: number): string {
  // ISO 8601 without seconds, UTC, as required by &run= (e.g. 2026-07-07T00:00).
  return new Date(ms).toISOString().slice(0, 16);
}

// The UTC day-midnight timestamps to sample: from (today − ANCHOR_LAG_DAYS) stepping back
// CADENCE_DAYS to ARCHIVE_START. Each day's actual run is chosen from RUN_HOURS at fetch time.
function sampleDays(): number[] {
  const day = 24 * 3600 * 1000;
  const now = new Date();
  const anchor = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()) -
    ANCHOR_LAG_DAYS * day;
  const days: number[] = [];
  for (let t = anchor; t >= ARCHIVE_START; t -= CADENCE_DAYS * day) days.push(t);
  return days;
}

function estWeight(nVars: number, days: number): number {
  return Math.max(1, nVars / 10) * Math.max(1, days / 7 / 2);
}

function buildUrl(loc: Location, run: string): string {
  const params = new URLSearchParams({
    latitude: String(loc.lat),
    longitude: String(loc.lon),
    run,
    hourly: HRES_HOURLY_VARS.join(","),
    timezone: "UTC",
    forecast_days: String(HORIZON_DAYS),
    models: COLLECT_MODEL,
  });
  if (loc.elev_m !== undefined) params.set("elevation", String(loc.elev_m));
  return `${ENDPOINT}?${params}`;
}

function cachePath(loc: Location, run: string): string {
  return join(CORPUS_DIR, loc.id, `${run.replace(/[:]/g, "")}.json`);
}

async function exists(p: string): Promise<boolean> {
  try { await access(p); return true; } catch { return false; }
}

interface FetchResult {
  ok: boolean;
  status: number;
  raw?: any;
  body?: string;
  unavailable: boolean; // 400 "model run is not available" → try the next candidate run hour
}

async function fetchRun(url: string): Promise<FetchResult> {
  const resp = await fetch(url);
  if (resp.ok) return { ok: true, status: resp.status, raw: await resp.json(), unavailable: false };
  const body = await resp.text();
  const unavailable = resp.status === 400 && /not available/i.test(body);
  return { ok: false, status: resp.status, body, unavailable };
}

// Summarise one raw response so the first fetch reveals whether HRES actually returns each variable.
function shapeReport(raw: any): string {
  const hourly = raw?.hourly ?? {};
  const n = Array.isArray(hourly.time) ? hourly.time.length : 0;
  const lines = HRES_HOURLY_VARS.map((v) => {
    const arr: (number | null)[] | undefined = hourly[v];
    if (!Array.isArray(arr)) return `    ${v.padEnd(28)} MISSING`;
    return `    ${v.padEnd(28)} ${arr.filter((x) => x != null).length}/${arr.length} non-null`;
  });
  return `  timesteps=${n} model_elevation=${raw?.elevation}m\n${lines.join("\n")}`;
}

async function collect(args: Args, locations: Location[]): Promise<void> {
  const days = sampleDays();
  const perCallWeight = estWeight(HRES_HOURLY_VARS.length, HORIZON_DAYS);

  console.log(`== Collect (HRES single runs) ==`);
  console.log(`  locations: ${locations.map((l) => l.id).join(", ")}`);
  console.log(`  days/location: ${days.length} (${runIso(days.at(-1)!)} … ${runIso(days[0])})`);
  console.log(`  vars: ${HRES_HOURLY_VARS.length}, horizon: ${HORIZON_DAYS}d, est. weight/call: ${perCallWeight.toFixed(2)} units`);
  console.log(`  full plan: ${locations.length * days.length} days ≈ ` +
    `${(locations.length * days.length * perCallWeight).toFixed(0)} units (of 10,000/day)`);
  if (args.limit) console.log(`  --limit ${args.limit}: capping this run to ${args.limit} fetches`);

  let fetched = 0, cached = 0, failed = 0, attempts = 0, weightSpent = 0;
  let firstShapePrinted = false;

  outer: for (const loc of locations) {
    for (const dayMs of days) {
      const candidates = RUN_HOURS.map((h) => runIso(dayMs + h * 3600 * 1000));

      // Resumable: skip the day if any candidate run (00Z or its 12Z fallback) is already cached.
      let already = false;
      for (const run of candidates) {
        if (await exists(cachePath(loc, run))) { already = true; break; }
      }
      if (already) { cached++; continue; }

      if (args.limit && attempts >= args.limit) break outer;
      attempts++;

      if (args.dryRun) {
        console.log(`  DRY ${loc.id} ${candidates[0]} (fallback: ${candidates.slice(1).join(", ")})`);
        weightSpent += perCallWeight;
        continue;
      }

      // Try each candidate run hour in order; stop at the first that exists.
      let saved = false, detailLogged = false;
      for (const run of candidates) {
        let res: FetchResult;
        try {
          res = await fetchRun(buildUrl(loc, run));
        } catch (err) {
          console.warn(`  FAIL ${loc.id} ${run} → ${(err as Error).message}`);
          detailLogged = true;
          break;
        }

        if (res.ok) {
          const path = cachePath(loc, run);
          await mkdir(dirname(path), { recursive: true });
          // Store the raw payload plus provenance so the corpus is self-describing.
          const record = {
            meta: { location: loc, run, model: COLLECT_MODEL, url: buildUrl(loc, run), fetched_at: new Date().toISOString() },
            response: res.raw,
          };
          await writeFile(path, JSON.stringify(record));
          fetched++;
          weightSpent += perCallWeight;
          const tag = run.endsWith("T12:00") ? " (12Z fallback)" : "";
          console.log(`  OK   ${loc.id} ${run}${tag} → ${path.replace(REPO_ROOT + "/", "")}`);
          if (!firstShapePrinted) { console.log(shapeReport(res.raw)); firstShapePrinted = true; }
          await sleep(250); // stay well under the 600/min rate limit
          saved = true;
          break;
        }

        if (res.status === 429) {
          console.warn(`  rate limited on ${run} — backing off 60s`);
          await sleep(60_000);
          continue; // retry the next candidate
        }
        if (res.unavailable) {
          await sleep(250);
          continue; // this run hour isn't archived — try the fallback
        }
        console.warn(`  FAIL ${loc.id} ${run} → HTTP ${res.status}: ${(res.body ?? "").slice(0, 200)}`);
        detailLogged = true;
        break;
      }

      if (!saved) {
        failed++;
        if (!detailLogged) console.warn(`  FAIL ${loc.id} ${candidates[0]} → no run archived (tried ${candidates.join(", ")})`);
      }
    }
  }

  console.log(`  done: fetched=${fetched} cached=${cached} failed=${failed} est_weight_spent=${weightSpent.toFixed(1)} units`);
}

// ── Phase 2: report ────────────────────────────────────────────────────────────────

interface Record { meta: { location: { id: string }; run: string }; response: any }

async function loadCorpus(locationFilter?: string): Promise<Record[]> {
  const locs = (await readdir(CORPUS_DIR, { withFileTypes: true }))
    .filter((d) => d.isDirectory() && (!locationFilter || d.name === locationFilter))
    .map((d) => d.name);
  const records: Record[] = [];
  for (const loc of locs) {
    const dir = join(CORPUS_DIR, loc);
    for (const f of await readdir(dir)) {
      if (!f.endsWith(".json")) continue;
      records.push(JSON.parse(await readFile(join(dir, f), "utf8")) as Record);
    }
  }
  return records;
}

// Columns whose backing series is entirely null in this response (a single trailing null at the
// horizon boundary is fine — `some` still sees the rest).
function missingColumns(h: HourlyData): string[] {
  const hasData = (v: string) => (h[v] as (number | null)[] | undefined)?.some((x) => x != null) ?? false;
  return REQUIRED_COLUMNS.filter((r) => !r.anyOf.some(hasData)).map((r) => r.column);
}

// Largest prefix of `periods` whose encoded message fits `maxChars`, with its breakdown. Encoded
// length is monotonic in the period count, so binary-search the cutoff (mirrors the server's
// fitEncodedToBudget). Always keeps at least one period.
function fitBreakdown(base: ForecastMessage, maxChars: number) {
  const at = (n: number) => v1EncodeBreakdown({ ...base, periods: [base.periods[0].slice(0, n)] });
  let lo = 1, hi = base.periods[0].length;
  let best = { n: 1, breakdown: at(1) };
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const breakdown = at(mid);
    if (breakdown.chars <= maxChars) { best = { n: mid, breakdown }; lo = mid + 1; }
    else hi = mid - 1;
  }
  return best;
}

const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;
function pct(xs: number[], p: number): number {
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))];
}

async function report(args: Args): Promise<void> {
  const resolutionIdx = RESOLUTION_IDX[args.resolution];
  const hoursPerPeriod = HOURS_PER_PERIOD[resolutionIdx];
  const records = await loadCorpus(args.location);
  if (records.length === 0) throw new Error("No forecasts found in corpus");

  // Per-column accumulators, keyed by column name in first-seen (body) order.
  const colBits = new Map<string, number[]>();       // bits per fitted message
  const colBitsPerPeriod = new Map<string, number[]>();
  const colModes = new Map<string, Map<string, number>>(); // name → mode → count
  const periodsFit: number[] = [];
  const charsUsed: number[] = [];
  let versionBits = 0, headerBits = 0;
  let skipped = 0, tempUnderflow = 0, used = 0;
  const skipByColumn = new Map<string, number>();

  for (const rec of records) {
    const hourly = rec.response.hourly as HourlyData;
    const times = hourly.time;

    // Data-quality guard: skip a forecast if any encoded column has no data (all null) in the raw
    // response, since it would encode as a silent all-zero column and inflate the fit count.
    const missing = missingColumns(hourly);
    if (missing.length && !args.includeIncomplete) {
      skipped++;
      for (const c of missing) skipByColumn.set(c, (skipByColumn.get(c) ?? 0) + 1);
      continue;
    }
    // Denali summit temps (~-43°C) underflow the protocol's -40°C floor and clamp to empty — a real
    // protocol limitation, tracked here as a caveat on the temp/tmin numbers.
    const coldest = Math.min(...(hourly.temperature_2m ?? []).filter((x): x is number => x != null));
    if (coldest < -40) tempUnderflow++;
    used++;

    // Anchor to the run start, aligned down to the resolution boundary (as parseRequest does).
    const runHour = Math.floor(Date.parse(rec.meta.run + "Z") / 3600000);
    const startEpochHour = Math.floor(runHour / hoursPerPeriod) * hoursPerPeriod;
    const available = Math.floor(times.length / hoursPerPeriod);
    const nPeriods = Math.min(V1_MAX_PERIODS, available);

    const rows: Row[] = aggregateHourly(hourly, times, nPeriods, resolutionIdx, startEpochHour);
    const periods = rows.map((r) => toFullPeriod(r, BENCH_MASK, ENCODE_MODEL));
    const elevation = rec.response.elevation ?? 0;
    const start = new Date(startEpochHour * 3600000);

    const base: ForecastMessage = {
      version: 1, code: 0, days: Math.ceil(nPeriods / (24 / hoursPerPeriod)),
      resolution: resolutionIdx, models_mask: 1, vars_mask: BENCH_MASK,
      month: start.getUTCMonth() + 1, day: start.getUTCDate(), hour: start.getUTCHours(),
      lat: 0, lon: 0, elevation, periods: [periods],
    };

    const { n: fittedN, breakdown } = fitBreakdown(base, args.maxChars);
    periodsFit.push(fittedN);
    charsUsed.push(breakdown.chars);
    versionBits = breakdown.versionBits;
    headerBits = breakdown.headerBits;

    for (const c of breakdown.columns) {
      if (!colBits.has(c.name)) {
        colBits.set(c.name, []); colBitsPerPeriod.set(c.name, []); colModes.set(c.name, new Map());
      }
      colBits.get(c.name)!.push(c.bits);
      colBitsPerPeriod.get(c.name)!.push(c.bits / fittedN);
      if (c.mode) {
        const mm = colModes.get(c.name)!;
        mm.set(c.mode, (mm.get(c.mode) ?? 0) + 1);
      }
    }

    if (args.verbose) {
      console.log(`  ${rec.meta.location.id} ${rec.meta.run}  periods=${fittedN}  chars=${breakdown.chars}`);
    }
  }

  console.log(`\n== Benchmark ==`);
  console.log(`Corpus: ${used} forecasts encoded` +
    (args.location ? ` (${args.location})` : "") +
    `  |  resolution=${args.resolution}  max-chars=${args.maxChars}`);
  console.log(`Encoded vars: weathercode, ${BENCH_VARS.join(", ")}`);
  if (skipped) {
    const by = [...skipByColumn.entries()].sort((a, b) => b[1] - a[1]).map(([c, n]) => `${c} ${n}`).join(", ");
    console.log(`Data quality: skipped ${skipped} forecast(s) with a fully-null column [${by}] (--include-incomplete to keep)`);
  }
  if (tempUnderflow) console.log(`Data quality: ${tempUnderflow}/${used} forecast(s) have temps < -40°C → temp/tmin clamp to the protocol floor`);
  console.log("");

  console.log(`Periods encoded per message:`);
  console.log(`  min ${Math.min(...periodsFit)}   p50 ${pct(periodsFit, 50)}   ` +
    `mean ${mean(periodsFit).toFixed(1)}   p90 ${pct(periodsFit, 90)}   max ${Math.max(...periodsFit)}`);
  console.log(`Message chars: mean ${mean(charsUsed).toFixed(1)}  min ${Math.min(...charsUsed)}  max ${Math.max(...charsUsed)}\n`);

  console.log(`Mean bit occupancy per column of the fitted message (over ${used} forecasts):`);
  console.log(`  ${"column".padEnd(14)} ${"bits".padStart(7)} ${"bits/period".padStart(12)}   modes`);
  const fixedRow = (name: string, bits: number) =>
    console.log(`  ${name.padEnd(14)} ${bits.toFixed(1).padStart(7)} ${"-".padStart(12)}   -`);
  fixedRow("version", versionBits);
  fixedRow("header", headerBits);
  let bodyTotal = 0;
  for (const [name, bitsArr] of colBits) {
    const b = mean(bitsArr);
    bodyTotal += b;
    const bpp = mean(colBitsPerPeriod.get(name)!);
    const modes = colModes.get(name)!;
    const modeStr = modes.size === 0 ? "-"
      : [...modes.entries()].sort((a, b) => b[1] - a[1])
          .map(([m, c]) => `${m} ${Math.round((100 * c) / bitsArr.length)}%`).join("  ");
    console.log(`  ${name.padEnd(14)} ${b.toFixed(1).padStart(7)} ${bpp.toFixed(2).padStart(12)}   ${modeStr}`);
  }
  console.log(`  ${"body total".padEnd(14)} ${bodyTotal.toFixed(1).padStart(7)}`);
  // Occupancy is the bits each column emits into the packed body; the actual payload is smaller when
  // the most-significant body column is zero-heavy (its high-order zero bits are elided). Base-85
  // packs ~6.409 bits/char, so payload chars ≈ meaningful body bits / 6.409 + 5 header chars.
  const occupancy = versionBits + headerBits + bodyTotal;
  console.log(`  ${"occupancy".padEnd(14)} ${occupancy.toFixed(1).padStart(7)} bits  (~${(occupancy / 6.409).toFixed(0)} chars if no elision)`);
  console.log(`  actual payload: mean ${mean(charsUsed).toFixed(1)} chars`);
}

// ── Entry ──────────────────────────────────────────────────────────────────────────

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const locations = args.location ? LOCATIONS.filter((l) => l.id === args.location) : LOCATIONS;
  if (locations.length === 0) throw new Error(`No location matches --location ${args.location}`);

  await collect(args, locations);
  if (args.dryRun) return; // preview only — don't encode
  await report(args);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
