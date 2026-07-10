/**
 * Collect a corpus of historical HRES forecasts for encoding experiments.
 *
 * Pulls 10-day hourly forecasts from Open-Meteo's Single Runs API (each run is a full model
 * initialisation, queryable by its UTC init time via `&run=`), stepping back one year per location
 * so seasonal variation is covered. Raw responses are cached to disk unchanged, so the encoding
 * measurement layer (built later) can iterate over the corpus offline without re-hitting the API.
 *
 * This is the collector only. It samples locations, fetches, caches, and reports call weight +
 * data shape. It does not encode anything yet.
 *
 *   node packages/server/scripts/collect-corpus.ts --limit 3        # small verification run
 *   node packages/server/scripts/collect-corpus.ts --dry-run        # print plan + weight, no fetch
 *   node packages/server/scripts/collect-corpus.ts                  # full year for all locations
 *
 * Open-Meteo call weight ≈ max(1, nVars/10) × max(1, weeks/2). HRES drops the pressure/freezing
 * columns, so each 10-day call is ~1.2 units. Free tier is 10,000 units/day.
 */
import { mkdir, readFile, writeFile, access } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, "..", "..", "..");
const CORPUS_DIR = join(REPO_ROOT, "corpus", "raw");

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

const MODEL = "ecmwf_ifs"; // HRES
const ENDPOINT = "https://single-runs-api.open-meteo.com/v1/forecast";
const HRES_ARCHIVE_START = Date.UTC(2024, 2, 14); // 2024-03-14, earliest archived HRES run

// Collection shape.
const HORIZON_DAYS = 10;
// Candidate run hours per sampled day, in preference order: prefer 00Z, fall back to 12Z when a
// day's 00Z run is missing from the archive (some runs simply aren't stored). ~4 of 6 Denali gaps
// are recovered by 12Z; a handful have neither.
const RUN_HOURS = [0, 12];
const CADENCE_DAYS = 10; // one forecast every ~10 days → ~37 sampled days across a year
const YEARS_BACK = 1;
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

// ---- CLI ----------------------------------------------------------------------------------------

interface Args {
  limit: number; // max fetches this run (0 = unlimited); use a small value to verify first
  dryRun: boolean; // print the plan and estimated weight, fetch nothing
  location?: string; // restrict to one location id
}

function parseArgs(argv: string[]): Args {
  const args: Args = { limit: 0, dryRun: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--dry-run") args.dryRun = true;
    else if (a === "--limit") args.limit = parseInt(argv[++i], 10) || 0;
    else if (a === "--location") args.location = argv[++i];
    else throw new Error(`Unknown argument: ${a}`);
  }
  return args;
}

// ---- helpers ------------------------------------------------------------------------------------

function runIso(ms: number): string {
  // ISO 8601 without seconds, UTC, as required by &run= (e.g. 2026-07-07T00:00).
  return new Date(ms).toISOString().slice(0, 16);
}

// The UTC day-midnight timestamps to sample: from (today − ANCHOR_LAG_DAYS) stepping back
// CADENCE_DAYS for YEARS_BACK, clamped to the HRES archive start. Each day's actual run is chosen
// from RUN_HOURS at fetch time.
function sampleDays(): number[] {
  const day = 24 * 3600 * 1000;
  const now = new Date();
  const anchor = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()) -
    ANCHOR_LAG_DAYS * day;
  const earliest = anchor - YEARS_BACK * 365 * day;
  const days: number[] = [];
  for (let t = anchor; t >= earliest && t >= HRES_ARCHIVE_START; t -= CADENCE_DAYS * day) {
    days.push(t);
  }
  return days;
}

function estWeight(nVars: number, days: number): number {
  const weeks = days / 7;
  return Math.max(1, nVars / 10) * Math.max(1, weeks / 2);
}

function buildUrl(loc: Location, run: string): string {
  const params = new URLSearchParams({
    latitude: String(loc.lat),
    longitude: String(loc.lon),
    run,
    hourly: HRES_HOURLY_VARS.join(","),
    timezone: "UTC",
    forecast_days: String(HORIZON_DAYS),
    models: MODEL,
  });
  if (loc.elev_m !== undefined) params.set("elevation", String(loc.elev_m));
  return `${ENDPOINT}?${params}`;
}

function cachePath(loc: Location, run: string): string {
  return join(CORPUS_DIR, loc.id, `${run.replace(/[:]/g, "")}.json`);
}

async function exists(p: string): Promise<boolean> {
  try {
    await access(p);
    return true;
  } catch {
    return false;
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ---- data-shape report --------------------------------------------------------------------------

// Summarise one raw response so a small run reveals whether HRES actually returns each variable
// (e.g. precipitation_probability is often null for a deterministic model).
function shapeReport(raw: any): string {
  const hourly = raw?.hourly ?? {};
  const n = Array.isArray(hourly.time) ? hourly.time.length : 0;
  const lines: string[] = [];
  for (const v of HRES_HOURLY_VARS) {
    const arr: (number | null)[] | undefined = hourly[v];
    if (!Array.isArray(arr)) {
      lines.push(`    ${v.padEnd(28)} MISSING`);
      continue;
    }
    const nonNull = arr.filter((x) => x != null).length;
    lines.push(`    ${v.padEnd(28)} ${nonNull}/${arr.length} non-null`);
  }
  const elev = raw?.elevation;
  return `  timesteps=${n} model_elevation=${elev}m\n${lines.join("\n")}`;
}

// ---- fetch --------------------------------------------------------------------------------------

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

// ---- main ---------------------------------------------------------------------------------------

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const locations = args.location
    ? LOCATIONS.filter((l) => l.id === args.location)
    : LOCATIONS;
  if (locations.length === 0) throw new Error(`No location matches --location ${args.location}`);

  const days = sampleDays();
  const perCallWeight = estWeight(HRES_HOURLY_VARS.length, HORIZON_DAYS);

  console.log(`Corpus collector — HRES single runs`);
  console.log(`  locations: ${locations.map((l) => l.id).join(", ")}`);
  console.log(`  days/location: ${days.length} (${runIso(days.at(-1)!)} … ${runIso(days[0])})`);
  console.log(`  vars: ${HRES_HOURLY_VARS.length}, horizon: ${HORIZON_DAYS}d`);
  console.log(`  est. weight/call: ${perCallWeight.toFixed(2)} units`);
  console.log(
    `  full plan: ${locations.length * days.length} days ≈ ` +
      `${(locations.length * days.length * perCallWeight).toFixed(0)} units (of 10,000/day)`,
  );
  if (args.limit) console.log(`  --limit ${args.limit}: capping this run to ${args.limit} fetches`);
  console.log("");

  let fetched = 0;
  let cached = 0;
  let failed = 0;
  let attempts = 0; // non-cached items acted on this run; --limit caps this (counts failures too)
  let weightSpent = 0;
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
        console.log(`DRY ${loc.id} ${candidates[0]} (fallback: ${candidates.slice(1).join(", ")})`);
        weightSpent += perCallWeight;
        continue;
      }

      // Try each candidate run hour in order; stop at the first that exists.
      let saved = false;
      let detailLogged = false;
      for (const run of candidates) {
        let res: FetchResult;
        try {
          res = await fetchRun(buildUrl(loc, run));
        } catch (err) {
          console.warn(`FAIL ${loc.id} ${run} → ${(err as Error).message}`);
          detailLogged = true;
          break;
        }

        if (res.ok) {
          const path = cachePath(loc, run);
          await mkdir(dirname(path), { recursive: true });
          // Store the raw payload plus provenance so the corpus is self-describing.
          const record = {
            meta: { location: loc, run, model: MODEL, url: buildUrl(loc, run), fetched_at: new Date().toISOString() },
            response: res.raw,
          };
          await writeFile(path, JSON.stringify(record));
          fetched++;
          weightSpent += perCallWeight;
          const tag = run.endsWith("T12:00") ? " (12Z fallback)" : "";
          console.log(`OK   ${loc.id} ${run}${tag} → ${path.replace(REPO_ROOT + "/", "")}`);
          if (!firstShapePrinted) {
            console.log(shapeReport(res.raw));
            firstShapePrinted = true;
          }
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
        // Any other error: report it and give up on this day.
        console.warn(`FAIL ${loc.id} ${run} → HTTP ${res.status}: ${(res.body ?? "").slice(0, 200)}`);
        detailLogged = true;
        break;
      }

      if (!saved) {
        failed++;
        if (!detailLogged) {
          console.warn(`FAIL ${loc.id} ${candidates[0]} → no run archived (tried ${candidates.join(", ")})`);
        }
      }
    }
  }

  console.log("");
  console.log(
    `Done. fetched=${fetched} cached=${cached} failed=${failed} ` +
      `est_weight_spent=${weightSpent.toFixed(1)} units`,
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
