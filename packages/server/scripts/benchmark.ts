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
import { spawn } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { aggregateHourly, toFullPeriod, HOURS_PER_PERIOD, type HourlyData, type Row } from "../src/forecast.ts";
import { VARS_BIT, v1EncodeBreakdown, type ForecastMessage } from "@weather/protocol";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, "..", "..", "..");
const DATA_DIR = join(REPO_ROOT, "data");         // gitignored
const CORPUS_DIR = join(DATA_DIR, "raw");          // cached Open-Meteo responses
const BENCHMARKS_DIR = join(DATA_DIR, "benchmarks"); // timestamped HTML reports

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

// Curated locations. Denali is pinned to the summit elevation (the flagship use case, already
// collected); the rest are imported Windy favorites, id = kebab-case of the title, using Open-Meteo's
// grid elevation. Spans the North American ranges, the Alps, the Andes (SH winter), and NZ.
const LOCATIONS: Location[] = [
  { id: "denali", name: "Denali summit", lat: 63.069, lon: -151.003, elev_m: 6096 },
  { id: "liberty-bell-mountain", name: "Liberty Bell Mountain", lat: 48.515, lon: -120.658 },
  { id: "eldorado", name: "Eldorado", lat: 48.537, lon: -121.134 },
  { id: "aasgard", name: "Aasgard", lat: 47.479, lon: -120.822 },
  { id: "paradise", name: "Paradise", lat: 46.786, lon: -121.735 },
  { id: "glacier-peak", name: "Glacier Peak", lat: 48.113, lon: -121.114 },
  { id: "alta", name: "Alta", lat: 40.59, lon: -111.64 },
  { id: "snoqualmie-pass", name: "Snoqualmie Pass", lat: 47.42, lon: -121.41 },
  { id: "panorama-dome", name: "Panorama Dome", lat: 48.855, lon: -121.683 },
  { id: "crystal", name: "Crystal", lat: 46.926, lon: -121.5 },
  { id: "mount-glory", name: "Mount Glory, Jackson", lat: 43.508, lon: -110.95 },
  { id: "chamonix", name: "Chamonix", lat: 45.879, lon: 6.888 },
  { id: "kitzbuhel", name: "Kitzbühel", lat: 47.418, lon: 12.357 },
  { id: "rogers-pass", name: "Rogers Pass, Area A", lat: 51.302, lon: -117.52 },
  { id: "sub-peak", name: "Sub Peak, Area B", lat: 50.963, lon: -118.101 },
  { id: "cowboy-mountain", name: "Cowboy Mountain, Scenic", lat: 47.744, lon: -121.09 },
  { id: "jungbrunntobel", name: "Jungbrunntobel, Gemeinde Sankt Anton am Arlberg", lat: 47.133, lon: 10.243 },
  { id: "pointe-marie-louise", name: "Pointe Marie-Louise, La Grave", lat: 45.001, lon: 6.255 },
  { id: "seppenalm", name: "Seppenalm, Heiligenblut am Grossglockner", lat: 47.065, lon: 12.858 },
  { id: "grubegg", name: "Grubegg, Hotting", lat: 47.31, lon: 11.378 },
  { id: "fraulaskofel", name: "Fraulaskofel, Gemeinde Neustift im Stubaital", lat: 46.983, lon: 11.112 },
  { id: "gemsstock", name: "Gemsstock, Andermatt", lat: 46.603, lon: 8.612 },
  { id: "lizumer-grube", name: "Lizumer Grube, Gemeinde Axams", lat: 47.183, lon: 11.282 },
  { id: "trockener-steg", name: "Trockener Steg, Zermatt", lat: 45.971, lon: 7.724 },
  { id: "grindelwald-grund", name: "Grindelwald Grund, Grindelwald", lat: 46.623, lon: 8.024 },
  { id: "le-corridor", name: "Le Corridor, Chamonix-Mont-Blanc", lat: 45.834, lon: 6.864 },
  { id: "mount-toll", name: "Mount Toll, Ward", lat: 40.089, lon: -105.633 },
  { id: "narao-peak", name: "Narao Peak, Area A", lat: 51.411, lon: -116.313 },
  { id: "flattop-mountain", name: "Flattop Mountain, Grand Lake", lat: 40.31, lon: -105.688 },
  { id: "belen", name: "Belen, Huaraz", lat: -9.53, lon: -77.53 },
  { id: "chinchey", name: "Chinchey, San Miguel de Aco", lat: -9.382, lon: -77.331 },
  { id: "cima-andes", name: "Cima Andes, Lo Barnechea", lat: -33.337, lon: -70.264 },
  { id: "blackcomb-peak", name: "Blackcomb Peak, Whistler Resort Municipality", lat: 50.094, lon: -122.886 },
  { id: "bald-mountain", name: "Bald Mountain, Ketchum", lat: 43.655, lon: -114.41 },
  { id: "brewster-rock", name: "Brewster Rock, Banff", lat: 51.075, lon: -115.756 },
  { id: "mount-columbia", name: "Mount Columbia, Area A", lat: 52.145, lon: -117.441 },
  { id: "stanley-peak", name: "Stanley Peak, Area G", lat: 51.171, lon: -116.055 },
  { id: "robson-cirque", name: "Robson Cirque, Area H", lat: 53.108, lon: -119.155 },
  { id: "mount-andromeda", name: "Mount Andromeda", lat: 52.176, lon: -117.238 },
  { id: "temple-lake-ridge", name: "Temple Lake Ridge, Lake Louise", lat: 51.36, lon: -116.192 },
  { id: "mount-adams", name: "Mount Adams", lat: 46.203, lon: -121.492 },
  { id: "mount-hood", name: "Mount Hood, Government Camp", lat: 45.373, lon: -121.696 },
  { id: "wolf-peak", name: "Wolf Peak", lat: 48.015, lon: -121.516 },
  { id: "canoe-peak", name: "Canoe Peak, Skykomish", lat: 47.653, lon: -121.481 },
  { id: "summit-pyramid", name: "Summit Pyramid, Qutang", lat: 27.988, lon: 86.925 },
  { id: "ruth-mountain", name: "Ruth Mountain", lat: 48.86, lon: -121.534 },
  { id: "roman-wall", name: "Roman Wall, Glacier", lat: 48.774, lon: -121.817 },
  { id: "pisco", name: "Pisco, Caraz", lat: -9.01, lon: -77.633 },
  { id: "wye-dome", name: "Wye Dome, Jacks Point", lat: -45.054, lon: 168.815 },
  { id: "mount-cook", name: "Mount Cook", lat: -43.594, lon: 170.142 },
  { id: "ichupata", name: "Ichupata, Santa Teresa", lat: -13.345, lon: -72.567 },
  { id: "grand-teton", name: "Grand Teton", lat: 43.742, lon: -110.803 },
  { id: "mount-moran", name: "Mount Moran", lat: 43.836, lon: -110.776 },
  { id: "south-peak", name: "South Peak", lat: -43.491, lon: 171.534 },
  { id: "craigieburn-valley-ski-area", name: "Craigieburn Valley Ski Area", lat: -43.113, lon: 171.699 },
  { id: "temple-col", name: "Temple Col, Arthur's Pass", lat: -42.911, lon: 171.589 },
  { id: "mount-cardrona", name: "Mount Cardrona, Arrowtown", lat: -44.863, lon: 168.945 },
  { id: "mount-ollivier", name: "Mount Ollivier, Aoraki", lat: -43.725, lon: 170.064 },
  { id: "the-footstool", name: "The Footstool, Aoraki", lat: -43.675, lon: 170.065 },
  { id: "dobson-peak", name: "Dobson Peak", lat: -43.935, lon: 170.665 },
  { id: "mount-sutton", name: "Mount Sutton", lat: -44.221, lon: 169.773 },
  { id: "treble-cone", name: "Treble Cone", lat: -44.634, lon: 168.876 },
  { id: "westland-district", name: "Westland District", lat: -44.066, lon: 169.449 },
  { id: "mount-aspiring", name: "Mount Aspiring", lat: -44.386, lon: 168.727 },
  { id: "queenstown-lakes-district", name: "Queenstown-Lakes District", lat: -44.622, lon: 168.411 },
  { id: "homestead-peak", name: "Homestead Peak", lat: -44.463, lon: 168.764 },
  { id: "mount-alta", name: "Mount Alta", lat: -44.502, lon: 168.974 },
  { id: "tahurangi", name: "Tahurangi, Turoa Village", lat: -39.29, lon: 175.563 },
  { id: "sandfly-point", name: "Sandfly Point, Fiordland Community", lat: -44.673, lon: 167.921 },
  { id: "hochstetter-peak", name: "Hochstetter Peak", lat: -43.513, lon: 170.342 },
  { id: "erewhon-skifield", name: "Erewhon Skifield", lat: -43.505, lon: 170.925 },
  { id: "queenstown-lakes-district-2", name: "Queenstown-Lakes District", lat: -44.438, lon: 168.624 },
  { id: "mount-talbot", name: "Mount Talbot, Fiordland Community", lat: -44.75, lon: 167.998 },
  { id: "the-lizard", name: "The Lizard, North Egmont", lat: -39.296, lon: 174.065 },
  { id: "9975-ft", name: "9975 ft, Beaver Creek", lat: 43.696, lon: -110.789 },
  { id: "malad-summit", name: "Malad Summit, Downey", lat: 42.35, lon: -112.224 },
  { id: "freds-mountain", name: "Freds Mountain, Driggs", lat: 43.791, lon: -110.936 },
  { id: "cornucopia-peak", name: "Cornucopia Peak, Cornucopia", lat: 45.01, lon: -117.241 },
  { id: "matanuska-susitna", name: "Matanuska-Susitna", lat: 62.904, lon: -151.205 },
  { id: "bloody-mountain", name: "Bloody Mountain, Mammoth Lakes", lat: 37.56, lon: -118.906 },
  { id: "mount-shasta", name: "Mount Shasta", lat: 41.409, lon: -122.193 },
  { id: "mount-tallac", name: "Mount Tallac, Spring Creek", lat: 38.903, lon: -120.099 },
  { id: "lynx-peak", name: "Lynx Peak", lat: 61.855, lon: -149.119 },
  { id: "matanuska-susitna-2", name: "Matanuska-Susitna", lat: 62.715, lon: -151.219 },
  { id: "east-twin-peak", name: "East Twin Peak, Palmer", lat: 61.443, lon: -149.147 },
  { id: "villa-catedral", name: "Villa Catedral", lat: -41.199, lon: -71.486 },
  { id: "el-chalten", name: "El Chaltén", lat: -49.272, lon: -73.042 },
  { id: "curarrehue", name: "Curarrehue", lat: -39.636, lon: -71.503 },
  { id: "lago-escondido", name: "Lago Escondido", lat: -54.707, lon: -67.995 },
  { id: "lom", name: "Lom", lat: 61.635, lon: 8.313 },
  { id: "luster", name: "Luster", lat: 61.79, lon: 7.207 },
  { id: "luster-2", name: "Luster", lat: 61.464, lon: 7.875 },
  { id: "folldal", name: "Folldal", lat: 61.915, lon: 9.853 },
  { id: "rauma", name: "Rauma", lat: 62.486, lon: 7.719 },
  { id: "leavenworth", name: "Leavenworth", lat: 47.6, lon: -120.66 },
  { id: "area-c", name: "Area C", lat: 54.499, lon: -128.964 },
  { id: "denali-2", name: "Denali", lat: 62.961, lon: -151.4 },
  { id: "east-wenatchee", name: "East Wenatchee", lat: 47.274, lon: -120.406 },
  { id: "kittitas", name: "Kittitas", lat: 47.335, lon: -120.58 },
  { id: "wendy-thompson-memorial-hut-recreation-site", name: "Wendy Thompson Memorial Hut Recreation Site", lat: 50.43, lon: -122.474 },
  { id: "area-c-2", name: "Area C", lat: 50.63, lon: -122.68 },
  { id: "lewis-county", name: "Lewis County", lat: 46.605, lon: -121.406 },
  { id: "chelan", name: "Chelan", lat: 47.987, lon: -120.871 },
  { id: "yakima", name: "Yakima", lat: 46.795, lon: -121.256 },
  { id: "winthrop", name: "Winthrop", lat: 48.48, lon: -120.19 },
  { id: "area-a", name: "Area A", lat: 51.627, lon: -116.502 },
  { id: "area-a-2", name: "Area A", lat: 51.275, lon: -117.076 },
  { id: "lyngen", name: "Lyngen", lat: 69.469, lon: 19.879 },
  { id: "tromso", name: "Tromso", lat: 69.724, lon: 18.436 },
  { id: "tromso-2", name: "Tromso", lat: 69.414, lon: 19.198 },
  { id: "balsfjord", name: "Balsfjord", lat: 69.105, lon: 19.784 },
  { id: "area-f", name: "Area F", lat: 49.852, lon: -123.003 },
  { id: "matanuska-susitna-3", name: "Matanuska-Susitna", lat: 61.436, lon: -147.752 },
  { id: "tinn", name: "Tinn", lat: 59.856, lon: 8.648 },
  { id: "area-j", name: "Area J", lat: 51.376, lon: -125.263 },
  { id: "matanuska-susitna-4", name: "Matanuska-Susitna", lat: 63.024, lon: -150.462 },
  { id: "mount-sanford", name: "Mount Sanford", lat: 62.215, lon: -144.128 },
  { id: "mount-iliamna", name: "Mount Iliamna", lat: 60.032, lon: -153.09 },
  { id: "yukon", name: "Yukon", lat: 60.295, lon: -140.932 },
  { id: "kebnekaise-sydtoppen", name: "Kebnekaise sydtoppen", lat: 67.901, lon: 18.516 },
  { id: "star-peak", name: "Star Peak", lat: 48.252, lon: -120.429 },
  { id: "south-rim", name: "South Rim, Grand Canyon Village", lat: 36.056, lon: -112.122 },
  { id: "mount-alyeska", name: "Mount Alyeska, Anchorage", lat: 60.96, lon: -149.061 },
  { id: "red-tit-col", name: "Red Tit Col, Area B", lat: 49.795, lon: -123.307 },
  { id: "matanuska-susitna-5", name: "Matanuska-Susitna", lat: 61.581, lon: -152.444 },
  { id: "denali-3", name: "Denali", lat: 62.991, lon: -152.021 },
  { id: "gilbert-peak", name: "Gilbert Peak", lat: 46.487, lon: -121.41 },
  { id: "mystic-pass", name: "Mystic Pass", lat: 62.64118609716908, lon: -152.53349304199222 },
  { id: "chalcatongo-de-hidalgo", name: "Chalcatongo de Hidalgo", lat: 17.029, lon: -97.569 },
  { id: "joffre-peak", name: "Joffre Peak, Area B", lat: 50.342, lon: -122.445 },
  { id: "yak-peak", name: "Yak Peak, Area B", lat: 49.609, lon: -121.106 },
  { id: "fraser", name: "Fraser", lat: 59.669, lon: -135.112 },
  { id: "valdez-cordova", name: "Valdez-Cordova", lat: 61.148, lon: -145.723 },
  { id: "kenai-peninsula", name: "Kenai Peninsula", lat: 60.785, lon: -149.212 },
  { id: "rock-peak", name: "Rock Peak", lat: 62.908, lon: -150.54 },
  { id: "matanuska-susitna-borough", name: "Matanuska-Susitna Borough", lat: 62.984, lon: -150.427 },
  { id: "denali-borough", name: "Denali Borough", lat: 62.974, lon: -151.171 },
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
  open: boolean; // open the HTML report when done (default true; --no-open to suppress)
  // shared
  location?: string;
}

function parseArgs(argv: string[]): Args {
  const args: Args = {
    limit: 0, dryRun: false, resolution: "1h", maxChars: 160, verbose: false, includeIncomplete: false, open: true,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--dry-run") args.dryRun = true;
    else if (a === "--verbose") args.verbose = true;
    else if (a === "--no-open") args.open = false;
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
  console.log(`  locations: ${locations.length}` + (args.location ? ` (${args.location})` : ""));
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
  let skipped = 0, used = 0;
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

  // Assemble the stats, then render an HTML report (kept as a timestamped file so old runs can be
  // compared side by side).
  const columns: ColStat[] = [...colBits.entries()].map(([name, bitsArr]) => ({
    name,
    bits: mean(bitsArr),
    bitsPerPeriod: mean(colBitsPerPeriod.get(name)!),
    modes: [...colModes.get(name)!.entries()]
      .sort((a, b) => b[1] - a[1])
      .map(([m, c]) => [m, c / bitsArr.length] as [string, number]),
  }));
  const bodyBits = columns.reduce((s, c) => s + c.bits, 0);

  const stats: BenchStats = {
    timestamp: new Date().toISOString(),
    resolution: args.resolution,
    maxChars: args.maxChars,
    encodedVars: ["weathercode", ...BENCH_VARS],
    forecasts: used,
    locations: new Set(records.map((r) => r.meta.location.id)).size,
    skipped,
    skipByColumn: [...skipByColumn.entries()].sort((a, b) => b[1] - a[1]),
    periods: {
      min: Math.min(...periodsFit), p50: pct(periodsFit, 50), mean: mean(periodsFit),
      p90: pct(periodsFit, 90), max: Math.max(...periodsFit),
    },
    chars: { mean: mean(charsUsed), min: Math.min(...charsUsed), max: Math.max(...charsUsed) },
    versionBits, headerBits, bodyBits,
    occupancyBits: versionBits + headerBits + bodyBits,
    columns,
  };

  await mkdir(BENCHMARKS_DIR, { recursive: true });
  const stamp = stats.timestamp.replace(/[:.]/g, "-").slice(0, 19);
  const outPath = join(BENCHMARKS_DIR, `${stamp}_${args.resolution}_${args.maxChars}c.html`);
  await writeFile(outPath, renderHtml(stats));

  console.log(`\n== Benchmark ==`);
  console.log(`  ${stats.forecasts} forecasts, ${stats.locations} locations` +
    `  |  resolution=${args.resolution}  max-chars=${args.maxChars}`);
  console.log(`  periods/msg: mean ${stats.periods.mean.toFixed(1)} (min ${stats.periods.min}, max ${stats.periods.max})`);
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

interface ColStat { name: string; bits: number; bitsPerPeriod: number; modes: [string, number][] }
interface BenchStats {
  timestamp: string;
  resolution: string;
  maxChars: number;
  encodedVars: string[];
  forecasts: number;
  locations: number;
  skipped: number;
  skipByColumn: [string, number][];
  periods: { min: number; p50: number; mean: number; p90: number; max: number };
  chars: { mean: number; min: number; max: number };
  versionBits: number;
  headerBits: number;
  bodyBits: number;
  occupancyBits: number;
  columns: ColStat[];
}

const esc = (s: string) =>
  s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]!));

function renderHtml(s: BenchStats): string {
  const maxBits = Math.max(...s.columns.map((c) => c.bits), 1);
  const modeText = (m: [string, number][]) =>
    m.length ? m.map(([name, f]) => `${esc(name)} ${Math.round(100 * f)}%`).join(" · ") : "—";

  const bodyRows = s.columns.map((c) => {
    const share = (100 * c.bits / s.occupancyBits).toFixed(1);
    return `<tr>
      <td class="name">${esc(c.name)}</td>
      <td class="num">${c.bits.toFixed(1)}</td>
      <td class="num">${c.bitsPerPeriod.toFixed(2)}</td>
      <td class="num">${share}%</td>
      <td class="barcell"><div class="bar"><div class="fill${c.modes.length ? " adaptive" : ""}" style="width:${(100 * c.bits / maxBits).toFixed(1)}%"></div></div></td>
      <td class="modes">${modeText(c.modes)}</td>
    </tr>`;
  }).join("\n");

  const card = (num: string, label: string) => `<div class="card"><div class="num">${num}</div><div class="label">${label}</div></div>`;

  const quality: string[] = [];
  if (s.skipped) quality.push(`Skipped ${s.skipped} forecast(s) with a fully-null column [${s.skipByColumn.map(([c, n]) => `${esc(c)} ${n}`).join(", ")}].`);

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Encoding benchmark — ${esc(s.timestamp)}</title>
<style>
  :root { color-scheme: light dark; }
  body { font: 14px/1.5 -apple-system, system-ui, sans-serif; margin: 0; padding: 2rem; max-width: 900px; }
  h1 { font-size: 1.4rem; margin: 0 0 .25rem; }
  .meta { color: #888; font-size: .85rem; margin-bottom: 1.5rem; }
  .meta code { background: rgba(128,128,128,.15); padding: .05rem .35rem; border-radius: 3px; }
  .cards { display: flex; gap: 1rem; flex-wrap: wrap; margin: 1.5rem 0; }
  .card { background: rgba(128,128,128,.1); border-radius: 8px; padding: .9rem 1.2rem; min-width: 120px; }
  .card .num { font-size: 1.6rem; font-weight: 600; }
  .card .label { color: #888; font-size: .8rem; }
  .quality { background: rgba(230,160,30,.12); border-left: 3px solid #e6a01e; padding: .6rem .9rem; border-radius: 4px; font-size: .85rem; margin: 1rem 0; }
  .quality p { margin: .2rem 0; }
  h2 { font-size: 1rem; margin: 2rem 0 .6rem; }
  table { width: 100%; border-collapse: collapse; font-variant-numeric: tabular-nums; }
  th, td { text-align: left; padding: .35rem .5rem; border-bottom: 1px solid rgba(128,128,128,.2); }
  th { font-size: .75rem; text-transform: uppercase; letter-spacing: .04em; color: #888; }
  td.num { text-align: right; font-family: ui-monospace, monospace; }
  td.name { font-weight: 500; }
  td.modes { color: #888; font-size: .8rem; }
  .barcell { width: 34%; }
  .bar { background: rgba(128,128,128,.15); border-radius: 3px; height: 12px; }
  .fill { background: #6b7280; height: 100%; border-radius: 3px; }
  .fill.adaptive { background: #3b82f6; }
  tr.total td { font-weight: 600; border-top: 2px solid rgba(128,128,128,.4); border-bottom: none; }
  .legend { font-size: .75rem; color: #888; margin-top: .5rem; }
  .swatch { display: inline-block; width: .7rem; height: .7rem; border-radius: 2px; vertical-align: middle; margin: 0 .2rem 0 .6rem; }
</style>
</head>
<body>
<h1>Encoding benchmark</h1>
<div class="meta">
  ${esc(s.timestamp)} · resolution <code>${esc(s.resolution)}</code> · max <code>${s.maxChars}</code> chars ·
  encoded: ${s.encodedVars.map(esc).join(", ")}
</div>

<div class="cards">
  ${card(s.periods.mean.toFixed(1), "mean periods / msg")}
  ${card(`${s.periods.min}–${s.periods.max}`, "periods range")}
  ${card(s.chars.mean.toFixed(1), "mean chars")}
  ${card(String(s.forecasts), "forecasts")}
  ${card(String(s.locations), "locations")}
</div>

${quality.length ? `<div class="quality">${quality.map((q) => `<p>${q}</p>`).join("")}</div>` : ""}

<h2>Periods encoded per message</h2>
<table>
  <tr><th>min</th><th>p50</th><th>mean</th><th>p90</th><th>max</th></tr>
  <tr><td class="num">${s.periods.min}</td><td class="num">${s.periods.p50}</td><td class="num">${s.periods.mean.toFixed(1)}</td><td class="num">${s.periods.p90}</td><td class="num">${s.periods.max}</td></tr>
</table>

<h2>Mean bit occupancy per column</h2>
<table>
  <tr><th>column</th><th style="text-align:right">bits</th><th style="text-align:right">bits/period</th><th style="text-align:right">share</th><th>occupancy</th><th>modes</th></tr>
  <tr><td class="name">version</td><td class="num">${s.versionBits.toFixed(1)}</td><td class="num">—</td><td class="num">${(100 * s.versionBits / s.occupancyBits).toFixed(1)}%</td><td class="barcell"><div class="bar"><div class="fill" style="width:${(100 * s.versionBits / maxBits).toFixed(1)}%"></div></div></td><td class="modes">—</td></tr>
  <tr><td class="name">header</td><td class="num">${s.headerBits.toFixed(1)}</td><td class="num">—</td><td class="num">${(100 * s.headerBits / s.occupancyBits).toFixed(1)}%</td><td class="barcell"><div class="bar"><div class="fill" style="width:${(100 * s.headerBits / maxBits).toFixed(1)}%"></div></div></td><td class="modes">—</td></tr>
${bodyRows}
  <tr class="total"><td>total</td><td class="num">${s.occupancyBits.toFixed(1)}</td><td class="num"></td><td class="num">100%</td><td></td><td class="modes">payload ~${s.chars.mean.toFixed(0)} chars</td></tr>
</table>
<div class="legend">
  <span class="swatch" style="background:#3b82f6"></span>adaptive column (mode selected per message)
  <span class="swatch" style="background:#6b7280"></span>fixed-width column
</div>

<script type="application/json" id="benchmark-data">${JSON.stringify(s)}</script>
</body>
</html>
`;
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
