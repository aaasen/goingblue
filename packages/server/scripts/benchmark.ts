/**
 * Benchmark the forecast encoding against a corpus of real forecasts.
 *
 * One script, two phases:
 *   1. Collect — pull 10-day hourly GFS forecasts from Open-Meteo's Historical Forecast API (a
 *      continuous best-estimate archive, queried by start_date/end_date), sampling one window every
 *      ~10 days across the past year for seasonal coverage. Raw responses are cached to disk
 *      unchanged (idempotent/resumable), so re-runs don't re-hit the API.
 *   2. Report — for each cached forecast, run the exact production path (aggregateHourly →
 *      toFullPeriod → the v1 codec, via v1EncodeBreakdown) and binary-search the largest prefix of
 *      periods that fits one message. Report how many periods fit and how the bit budget splits
 *      across the header and each variable column (with the adaptive mode each column chose).
 *
 *   node packages/server/scripts/benchmark.ts                     # collect (idempotent) then report
 *   node packages/server/scripts/benchmark.ts --collect-only      # expand the cache, no report
 *   node packages/server/scripts/benchmark.ts --report-only       # report from cache, no collection
 *   node packages/server/scripts/benchmark.ts --dry-run           # preview collection plan, no fetch
 *   node packages/server/scripts/benchmark.ts --resolution 6h     # 1h/3h/6h (default 1h)
 *   # other flags: --limit <n>, --max-chars <n>, --location <id>, --verbose, --include-incomplete, --no-open
 *
 * Open-Meteo call weight ≈ max(1, nVars/10) × max(1, weeks/2). A 10-day GFS call (~18 vars) is ~1.8
 * units; the full-year, all-locations pull is ~9.1k units. Free tier is 10,000 units/day.
 */
import { mkdir, readdir, readFile, writeFile, rename, access } from "node:fs/promises";
import { spawn } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { aggregateHourly, toFullPeriod, HOURS_PER_PERIOD, type HourlyData } from "../src/forecast.ts";
import { VARS_BIT, v1EncodeBreakdown, type ForecastMessage } from "@weather/protocol";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, "..", "..", "..");
const DATA_DIR = join(REPO_ROOT, "data");         // gitignored
const CORPUS_DIR = join(DATA_DIR, "raw");          // cached Open-Meteo responses
const BENCHMARKS_DIR = join(DATA_DIR, "benchmarks"); // timestamped HTML reports

// ── Collection config ────────────────────────────────────────────────────────────

// Open-Meteo hourly series, grouped to mirror the app's variable selector (BuilderTab.tsx). Base is
// always requested; each optional group maps to protocol columns the user can toggle. The Historical
// Forecast API provides precipitation_probability (unlike single-runs, where it forced the ensemble
// variant), so it's collected as a base variable.
const BASE_HOURLY = [
  "temperature_2m", "wind_speed_10m", "wind_direction_10m", "precipitation_probability",
  "weather_code", "snowfall", "rain", "showers",
];
const GROUP_HOURLY = {
  clouds: ["cloud_cover_high", "cloud_cover_mid", "cloud_cover_low"], // app "Clouds" = high/mid/low
  highwind: ["wind_speed_500hPa", "wind_direction_500hPa", "wind_speed_600hPa",
    "wind_direction_600hPa", "wind_speed_700hPa", "wind_direction_700hPa"],
  freeze: ["freezing_level_height"],
} as const;
type GroupId = keyof typeof GROUP_HOURLY;
const GROUP_IDS: GroupId[] = ["clouds", "highwind", "freeze"];
const GROUP_LABEL: Record<GroupId, string> = {
  clouds: "Clouds", highwind: "High Altitude Winds", freeze: "Freezing Level",
};

// Collected models and which optional groups each supports. We collect GFS only: encoded size barely
// differs between models, and GFS supplies every group (clouds + high-alt winds + freezing level). The
// array is kept so more models can be added; the report encodes the first entry.
interface ModelDef { id: string; api: string; label: string; groups: Record<GroupId, boolean> }
const MODELS: ModelDef[] = [
  { id: "gfs", api: "gfs_seamless", label: "GFS", groups: { clouds: true, highwind: true, freeze: true } },
];

// Open-Meteo hourly variables to request for a model: base + every group it supports.
function modelHourly(m: ModelDef): string[] {
  return [...BASE_HOURLY, ...GROUP_IDS.filter((g) => m.groups[g]).flatMap((g) => GROUP_HOURLY[g])];
}

// Open-Meteo's Historical Forecast API: a continuous best-estimate archive going back a year+ (no run
// gaps), queried by start_date/end_date. We sample fixed-length windows across a full year for
// seasonal coverage. (This is best-estimate data, not a run-anchored 10-day-ahead forecast — fine for
// measuring how the encoding compresses realistic seasonal weather.)
const ENDPOINT = "https://historical-forecast-api.open-meteo.com/v1/forecast";

const HORIZON_DAYS = 10;       // window length (days)
const CADENCE_DAYS = 10;       // one window every ~10 days
const YEARS_BACK = 1;          // sample windows across the past year
const ANCHOR_LAG_DAYS = 5;     // newest window ends a few days ago so the best-estimate has settled

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

// daily/12h are omitted: at those resolutions a forecast almost always fits every period, so they're
// not size-constrained and add compute without insight. (Values are the v1 protocol resolution index.)
const RESOLUTION_IDX: Record<string, number> = { "6h": 2, "3h": 3, "1h": 4 };
const RESOLUTION_ORDER = ["1h", "3h", "6h"]; // selector order (fine → coarse)
const V1_MAX_PERIODS = 128;

// Protocol variable groups, mirroring the app (BuilderTab.tsx). weathercode is always encoded by the
// protocol (not in a mask). BASE is always on; each toggleable group maps to protocol var bits.
const BASE_VARS = ["precip", "temp", "tmin", "snow", "rain", "wind"];
const GROUP_VARS: Record<GroupId, string[]> = {
  clouds: ["cch", "ccm", "ccl"],
  highwind: ["w500", "w600", "w700"],
  freeze: ["freeze"],
};
const maskOf = (vars: string[]) => vars.reduce((m, v) => m | (1 << VARS_BIT[v]), 0);
const BASE_MASK = maskOf(BASE_VARS);

// At 1h resolution each period is a single hourly sample, so tmin is identical to temp (the
// max) — drop it so the report doesn't show a wasted, redundant column (mirrors forecast.ts).
const maskForRes = (mask: number, resolutionIdx: number) =>
  HOURS_PER_PERIOD[resolutionIdx] === 1 ? mask & ~(1 << VARS_BIT.tmin) : mask;

// All 8 variable-group combinations (bit i = GROUP_IDS[i]); combo 0b001 = Clouds only is the default.
const COMBOS = [...Array(1 << GROUP_IDS.length).keys()];
const comboGroups = (c: number): GroupId[] => GROUP_IDS.filter((_, i) => c & (1 << i));
const comboMask = (c: number) => BASE_MASK | maskOf(comboGroups(c).flatMap((g) => GROUP_VARS[g]));
const DEFAULT_COMBO = 0; // base variables only (no optional groups)

// Base Open-Meteo series required for a usable forecast (a fully-null one would encode as a silent
// zero column). rain counts as present if rain OR showers has data.
const REQUIRED_BASE: string[][] = [
  ["temperature_2m"], ["weather_code"], ["snowfall"], ["rain", "showers"], ["wind_speed_10m"],
];

// ── CLI ──────────────────────────────────────────────────────────────────────────

interface Args {
  // collect
  limit: number;         // max fetches this run (0 = unlimited); use a small value to verify first
  dryRun: boolean;       // preview the collection plan and estimated weight, fetch nothing, no report
  collectOnly: boolean;  // collect (expand the cache) and stop — no report
  reportOnly: boolean;   // skip collection, build the report from cached data
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
    limit: 0, dryRun: false, collectOnly: false, reportOnly: false,
    resolution: "1h", maxChars: 160, verbose: false, includeIncomplete: false, open: true,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--dry-run") args.dryRun = true;
    else if (a === "--collect-only") args.collectOnly = true;
    else if (a === "--report-only") args.reportOnly = true;
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
  if (args.collectOnly && args.reportOnly) throw new Error("--collect-only and --report-only are mutually exclusive");
  return args;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ── Phase 1: collect ───────────────────────────────────────────────────────────────

function runIso(ms: number): string {
  // ISO 8601 without seconds, UTC (e.g. 2025-07-15T00:00) — the window's anchor / start.
  return new Date(ms).toISOString().slice(0, 16);
}

function ymd(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10); // YYYY-MM-DD, for start_date/end_date
}

// The window start timestamps (00:00 UTC) to sample: from (today − ANCHOR_LAG_DAYS − HORIZON) back
// CADENCE_DAYS for YEARS_BACK, giving fixed-length windows spread across the year for seasonal coverage.
function sampleWindows(): number[] {
  const day = 24 * 3600 * 1000;
  const now = new Date();
  // Newest window ends ANCHOR_LAG_DAYS ago, so its start is HORIZON before that.
  const anchor = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()) -
    (ANCHOR_LAG_DAYS + HORIZON_DAYS - 1) * day;
  const earliest = anchor - YEARS_BACK * 365 * day;
  const starts: number[] = [];
  for (let t = anchor; t >= earliest; t -= CADENCE_DAYS * day) starts.push(t);
  return starts;
}

function estWeight(nVars: number, days: number): number {
  return Math.max(1, nVars / 10) * Math.max(1, days / 7 / 2);
}

function buildUrl(model: ModelDef, loc: Location, startMs: number): string {
  const day = 24 * 3600 * 1000;
  const params = new URLSearchParams({
    latitude: String(loc.lat),
    longitude: String(loc.lon),
    start_date: ymd(startMs),
    end_date: ymd(startMs + (HORIZON_DAYS - 1) * day),
    hourly: modelHourly(model).join(","),
    timezone: "UTC",
    models: model.api,
  });
  if (loc.elev_m !== undefined) params.set("elevation", String(loc.elev_m));
  return `${ENDPOINT}?${params}`;
}

function cachePath(modelId: string, loc: Location, run: string): string {
  return join(CORPUS_DIR, modelId, loc.id, `${run.replace(/[:]/g, "")}.json`);
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

// Summarise one raw response so the first fetch reveals whether the model returns each variable.
function shapeReport(raw: any, vars: string[]): string {
  const hourly = raw?.hourly ?? {};
  const n = Array.isArray(hourly.time) ? hourly.time.length : 0;
  const lines = vars.map((v) => {
    const arr: (number | null)[] | undefined = hourly[v];
    if (!Array.isArray(arr)) return `    ${v.padEnd(28)} MISSING`;
    return `    ${v.padEnd(28)} ${arr.filter((x) => x != null).length}/${arr.length} non-null`;
  });
  return `  timesteps=${n} model_elevation=${raw?.elevation}m\n${lines.join("\n")}`;
}

async function collect(args: Args, locations: Location[]): Promise<void> {
  const windows = sampleWindows();
  const totalCalls = MODELS.length * locations.length * windows.length;
  const totalUnits = MODELS.reduce((s, m) => s + locations.length * windows.length * estWeight(modelHourly(m).length, HORIZON_DAYS), 0);

  console.log(`== Collect (historical forecast) ==`);
  console.log(`  models: ${MODELS.map((m) => `${m.id}(${modelHourly(m).length} vars)`).join(", ")}`);
  console.log(`  locations: ${locations.length}` + (args.location ? ` (${args.location})` : ""));
  console.log(`  windows/location: ${windows.length} (${ymd(windows.at(-1)!)} … ${ymd(windows[0])}), ${HORIZON_DAYS}d each`);
  console.log(`  full plan: ${totalCalls} calls ≈ ${totalUnits.toFixed(0)} units (of 10,000/day)`);
  if (args.limit) console.log(`  --limit ${args.limit}: capping this run to ${args.limit} fetches`);

  let fetched = 0, cached = 0, failed = 0, attempts = 0, weightSpent = 0;
  const shapePrinted = new Set<string>(); // one shape summary per model

  outer: for (const model of MODELS) {
    const perCallWeight = estWeight(modelHourly(model).length, HORIZON_DAYS);
    for (const loc of locations) {
      for (const startMs of windows) {
        const run = runIso(startMs); // window anchor, 00:00 UTC
        const path = cachePath(model.id, loc, run);
        if (await exists(path)) { cached++; continue; } // resumable

        if (args.limit && attempts >= args.limit) break outer;
        attempts++;

        if (args.dryRun) {
          console.log(`  DRY ${model.id} ${loc.id} ${ymd(startMs)}…${ymd(startMs + (HORIZON_DAYS - 1) * 86400000)}`);
          weightSpent += perCallWeight;
          continue;
        }

        let res: FetchResult;
        try {
          res = await fetchRun(buildUrl(model, loc, startMs));
        } catch (err) {
          console.warn(`  FAIL ${model.id} ${loc.id} ${run} → ${(err as Error).message}`);
          failed++;
          continue;
        }
        if (res.status === 429) {
          console.warn(`  rate limited — backing off 60s`);
          await sleep(60_000);
          failed++;
          continue; // re-run later picks it up (not cached)
        }
        if (!res.ok) {
          console.warn(`  FAIL ${model.id} ${loc.id} ${run} → HTTP ${res.status}: ${(res.body ?? "").slice(0, 200)}`);
          failed++;
          continue;
        }

        await mkdir(dirname(path), { recursive: true });
        // Store the raw payload plus provenance so the corpus is self-describing.
        const record = {
          meta: { location: loc, run, model: model.id, api: model.api, url: buildUrl(model, loc, startMs), fetched_at: new Date().toISOString() },
          response: res.raw,
        };
        // Atomic write (tmp + rename) so a concurrent --report-only never reads a half-written file.
        await writeFile(`${path}.tmp`, JSON.stringify(record));
        await rename(`${path}.tmp`, path);
        fetched++;
        weightSpent += perCallWeight;
        console.log(`  OK   ${model.id} ${loc.id} ${run} → ${path.replace(REPO_ROOT + "/", "")}`);
        if (!shapePrinted.has(model.id)) { console.log(shapeReport(res.raw, modelHourly(model))); shapePrinted.add(model.id); }
        await sleep(250); // stay well under the 600/min rate limit
      }
    }
  }

  console.log(`  done: fetched=${fetched} cached=${cached} failed=${failed} est_weight_spent=${weightSpent.toFixed(1)} units`);
}

// ── Phase 2: report ────────────────────────────────────────────────────────────────

interface Record { meta: { location: { id: string; lat: number; lon: number }; run: string }; response: any }

async function loadModel(modelId: string, locationFilter?: string): Promise<Record[]> {
  const modelDir = join(CORPUS_DIR, modelId);
  if (!(await exists(modelDir))) return [];
  const locs = (await readdir(modelDir, { withFileTypes: true }))
    .filter((d) => d.isDirectory() && (!locationFilter || d.name === locationFilter))
    .map((d) => d.name);
  const records: Record[] = [];
  for (const loc of locs) {
    const dir = join(modelDir, loc);
    for (const f of await readdir(dir)) {
      if (!f.endsWith(".json")) continue;
      try {
        records.push(JSON.parse(await readFile(join(dir, f), "utf8")) as Record);
      } catch {
        // A concurrent --collect-only may be mid-write (or a leftover .tmp was renamed under us);
        // skip this file — the next report pass will include it once it's complete.
      }
    }
  }
  return records;
}

// True if any base series is entirely null (a single trailing null at the horizon boundary is fine).
function baseComplete(h: HourlyData): boolean {
  const hasData = (v: string) => (h[v] as (number | null)[] | undefined)?.some((x) => x != null) ?? false;
  return REQUIRED_BASE.every((anyOf) => anyOf.some(hasData));
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

function buildView(pf: number[], cb: Map<string, number[]>, cm: Map<string, Map<string, number>>): ViewStats {
  const pMin = Math.min(...pf), pMax = Math.max(...pf);
  const hcounts = new Map<number, number>();
  for (const p of pf) hcounts.set(p, (hcounts.get(p) ?? 0) + 1);
  const histogram: { period: number; count: number }[] = [];
  for (let p = pMin; p <= pMax; p++) histogram.push({ period: p, count: hcounts.get(p) ?? 0 });

  const columns: ColStat[] = [...cb.entries()].map(([name, bitsArr]) => {
    const bpp = bitsArr.map((b, i) => b / pf[i]);
    return {
      name,
      bits: mean(bitsArr),
      bitsPerPeriod: mean(bpp),
      bppStats: { min: Math.min(...bpp), p25: pct(bpp, 25), p50: pct(bpp, 50), mean: mean(bpp), p75: pct(bpp, 75), max: Math.max(...bpp) },
      modes: [...cm.get(name)!.entries()].sort((a, b) => b[1] - a[1]).map(([m, c]) => [m, c / bitsArr.length] as [string, number]),
    };
  });
  return {
    periods: { min: pMin, p25: pct(pf, 25), p50: pct(pf, 50), mean: mean(pf), p75: pct(pf, 75), p90: pct(pf, 90), max: pMax },
    histogram,
    bodyBits: columns.reduce((s, c) => s + c.bits, 0),
    columns,
  };
}

async function report(args: Args): Promise<void> {
  // Single model (GFS — it supplies every variable group, so no cross-model fallback is needed).
  const model = MODELS[0];
  const records = new Map<string, Record>();
  for (const rec of await loadModel(model.id, args.location)) records.set(`${rec.meta.location.id}|${rec.meta.run}`, rec);
  const keys = [...records.keys()].sort();
  if (keys.length === 0) throw new Error("No forecasts found — run collection first");

  // A view = resolution × variable-combo. Every (res, combo) is precomputed.
  const vkey = (res: string, combo: number) => `${res}:${combo}`;
  const periodsFit = new Map<string, number[]>();
  const colBits = new Map<string, Map<string, number[]>>();
  const colModes = new Map<string, Map<string, Map<string, number>>>();
  for (const res of RESOLUTION_ORDER) for (const c of COMBOS) {
    const vk = vkey(res, c);
    periodsFit.set(vk, []); colBits.set(vk, new Map()); colModes.set(vk, new Map());
  }

  const forecasts: { location: string; run: string; lat: number; lon: number }[] = [];
  // bits/period per (resolution → per-forecast {var: bpp}), for the detail table.
  const bpp: Record<string, Record<string, number>[]> = {};
  for (const res of RESOLUTION_ORDER) bpp[res] = [];
  const allMask = comboMask(COMBOS.length - 1); // every group on
  let versionBits = 0, headerBits = 0, skipped = 0;

  for (const key of keys) {
    const rec = records.get(key)!;
    if (!baseComplete(rec.response.hourly as HourlyData)) { skipped++; continue; }
    const [locId, run] = key.split("|");
    const meta = rec.meta.location;
    const runHour = Math.floor(Date.parse(run + "Z") / 3600000);
    const elevation = rec.response.elevation ?? 0;
    forecasts.push({ location: locId, run, lat: meta.lat, lon: meta.lon });

    for (const res of RESOLUTION_ORDER) {
      const resolutionIdx = RESOLUTION_IDX[res];
      const hoursPerPeriod = HOURS_PER_PERIOD[resolutionIdx];
      const startEpochHour = Math.floor(runHour / hoursPerPeriod) * hoursPerPeriod;
      const start = new Date(startEpochHour * 3600000);
      const h = rec.response.hourly as HourlyData;
      const n = Math.min(V1_MAX_PERIODS, Math.floor(h.time.length / hoursPerPeriod));
      const rows = aggregateHourly(h, h.time, n, resolutionIdx, startEpochHour);
      const msgFor = (periods: Period[], mask: number): ForecastMessage => ({
        version: 1, code: 0, days: Math.ceil(periods.length / (24 / hoursPerPeriod)),
        resolution: resolutionIdx, models_mask: 1, vars_mask: mask,
        month: start.getUTCMonth() + 1, day: start.getUTCDate(), hour: start.getUTCHours(),
        lat: 0, lon: 0, elevation, periods: [periods],
      });
      // One Period array with every field populated; vary only vars_mask per combo (columns encode
      // independently). "GFS" (non-HRES) so toFullPeriod keeps the pressure/freeze columns.
      const resAllMask = maskForRes(allMask, resolutionIdx);
      const allPeriods = rows.map((r) => toFullPeriod(r, resAllMask, "GFS", resolutionIdx));

      const bd = v1EncodeBreakdown(msgFor(allPeriods, resAllMask));
      bpp[res].push(Object.fromEntries(bd.columns.map((c) => [c.name, c.bits / allPeriods.length])));

      for (const c of COMBOS) {
        const { n: fittedN, breakdown } = fitBreakdown(msgFor(allPeriods, maskForRes(comboMask(c), resolutionIdx)), args.maxChars);
        const vk = vkey(res, c);
        periodsFit.get(vk)!.push(fittedN);
        versionBits = breakdown.versionBits; headerBits = breakdown.headerBits;
        const cb = colBits.get(vk)!, cm = colModes.get(vk)!;
        for (const col of breakdown.columns) {
          if (!cb.has(col.name)) { cb.set(col.name, []); cm.set(col.name, new Map()); }
          cb.get(col.name)!.push(col.bits);
          if (col.mode) { const mm = cm.get(col.name)!; mm.set(col.mode, (mm.get(col.mode) ?? 0) + 1); }
        }
      }
    }
  }

  // Build per-view stats + the interactive period data (res → combo → per-forecast periods).
  const views: Record<string, ViewStats> = {};
  const periodsByView: Record<string, Record<number, number[]>> = {};
  for (const res of RESOLUTION_ORDER) {
    periodsByView[res] = {};
    for (const c of COMBOS) {
      const vk = vkey(res, c);
      views[vk] = buildView(periodsFit.get(vk)!, colBits.get(vk)!, colModes.get(vk)!);
      periodsByView[res][c] = periodsFit.get(vk)!;
    }
  }

  const stats: ReportData = {
    timestamp: new Date().toISOString(),
    resolutions: RESOLUTION_ORDER,
    defaultResolution: args.resolution,
    maxChars: args.maxChars,
    forecasts: forecasts.length,
    locations: new Set(forecasts.map((f) => f.location)).size,
    skipped,
    versionBits, headerBits,
    model: model.label,
    groups: GROUP_IDS.map((g) => ({ id: g, label: GROUP_LABEL[g] })),
    groupVars: GROUP_VARS,
    baseVars: BASE_VARS,
    defaultCombo: DEFAULT_COMBO,
    views,
    forecastRows: forecasts,
    periodsByView,
    bpp,
  };

  await mkdir(BENCHMARKS_DIR, { recursive: true });
  const stamp = stats.timestamp.replace(/[:.]/g, "-").slice(0, 19);
  const outPath = join(BENCHMARKS_DIR, `${stamp}_${args.maxChars}c.html`);
  await writeFile(outPath, renderHtml(stats));

  const dv = views[vkey(args.resolution, stats.defaultCombo)];
  console.log(`\n== Benchmark ==`);
  console.log(`  ${stats.forecasts} forecasts, ${stats.locations} locations, ${model.label}, ${RESOLUTION_ORDER.length} resolutions  |  max-chars=${args.maxChars}`);
  if (skipped) console.log(`  skipped ${skipped} forecast(s) with an incomplete base series`);
  console.log(`  default view (${args.resolution}, base): periods/msg mean ${dv.periods.mean.toFixed(1)} (min ${dv.periods.min}, max ${dv.periods.max})`);
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
interface ColStat { name: string; bits: number; bitsPerPeriod: number; bppStats: BoxStats; modes: [string, number][] }
interface ViewStats {
  periods: { min: number; p25: number; p50: number; mean: number; p75: number; p90: number; max: number };
  histogram: { period: number; count: number }[];
  bodyBits: number;
  columns: ColStat[];
}
// Everything the report embeds. `views` holds one ViewStats per res:combo; the interactive detail
// table is rebuilt client-side from forecastRows + periodsByView + bpp.
interface ReportData {
  timestamp: string;
  resolutions: string[];
  defaultResolution: string;
  maxChars: number;
  forecasts: number;
  locations: number;
  skipped: number;
  versionBits: number;
  headerBits: number;
  model: string; // single model (label), shown in the meta line
  groups: { id: GroupId; label: string }[];
  groupVars: Record<GroupId, string[]>;
  baseVars: string[];
  defaultCombo: number;
  views: Record<string, ViewStats>;                        // "res:combo" → stats
  forecastRows: { location: string; run: string; lat: number; lon: number }[];
  // res → combo → per-forecast periods
  periodsByView: Record<string, Record<number, number[]>>;
  // res → per-forecast {var: bits/period}
  bpp: Record<string, Record<string, number>[]>;
}

const esc = (s: string) =>
  s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]!));

// A static, self-contained SVG bar histogram of periods-per-message (offline-safe, no JS/CDN).
function renderHistogram(hist: { period: number; count: number }[]): string {
  const W = 720, H = 240, m = { t: 14, r: 14, b: 38, l: 46 };
  const iw = W - m.l - m.r, ih = H - m.t - m.b;
  const n = hist.length;
  const maxCount = Math.max(...hist.map((h) => h.count), 1);
  const bw = iw / n;
  const x = (i: number) => m.l + i * bw;
  const y = (c: number) => m.t + ih * (1 - c / maxCount);

  // y gridlines/ticks at 0, mid, max
  const yvals = [...new Set([0, Math.round(maxCount / 2), maxCount])];
  const yAxis = yvals.map((v) =>
    `<line x1="${m.l}" y1="${y(v).toFixed(1)}" x2="${W - m.r}" y2="${y(v).toFixed(1)}" class="hgrid"/>` +
    `<text x="${m.l - 8}" y="${(y(v) + 3.5).toFixed(1)}" class="htick" text-anchor="end">${v}</text>`).join("");

  const bars = hist.map((h, i) =>
    `<rect x="${(x(i) + bw * 0.12).toFixed(1)}" y="${y(h.count).toFixed(1)}" width="${(bw * 0.76).toFixed(1)}" ` +
    `height="${(ih * h.count / maxCount).toFixed(1)}" class="hbar"><title>${h.period} periods: ${h.count} forecasts</title></rect>`).join("");

  // Label ~8 evenly spaced x ticks (period values).
  const step = Math.max(1, Math.round(n / 8));
  const xAxis = hist.map((h, i) => (i % step === 0 || i === n - 1)
    ? `<text x="${(x(i) + bw / 2).toFixed(1)}" y="${H - m.b + 16}" class="htick" text-anchor="middle">${h.period}</text>` : "").join("");

  return `<svg viewBox="0 0 ${W} ${H}" class="hist" role="img" aria-label="Histogram of periods encoded per message">
  ${yAxis}${bars}${xAxis}
  <text x="${m.l + iw / 2}" y="${H - 4}" class="haxis" text-anchor="middle">periods / message</text>
  <text x="12" y="${m.t + ih / 2}" class="haxis" text-anchor="middle" transform="rotate(-90 12 ${m.t + ih / 2})">forecasts</text>
</svg>`;
}

// Box-and-whisker of periods/message: min–max whiskers, Q1–Q3 box, median line, mean dot, with value
// labels (median above the box; min/Q1/Q3/max below). Shares the histogram's period x-scale.
function renderBoxPlot(p: ViewStats["periods"]): string {
  const W = 720, H = 92, m = { t: 22, r: 14, b: 18, l: 46 };
  const iw = W - m.l - m.r;
  const bins = Math.max(1, p.max - p.min + 1);
  const bw = iw / bins;
  const x = (v: number) => m.l + (v - p.min) * bw + bw / 2;
  const cy = m.t + (H - m.t - m.b) / 2;
  const half = 13, cap = 8, belowY = cy + cap + 15;
  const label = (v: number, xv: number, yv: number) => `<text x="${xv.toFixed(1)}" y="${yv}" class="blabel" text-anchor="middle">${v}</text>`;
  return `<svg viewBox="0 0 ${W} ${H}" class="box" role="img" aria-label="Box plot of periods per message">
  <line x1="${x(p.min).toFixed(1)}" y1="${cy}" x2="${x(p.max).toFixed(1)}" y2="${cy}" class="bwhisker"/>
  <line x1="${x(p.min).toFixed(1)}" y1="${cy - cap}" x2="${x(p.min).toFixed(1)}" y2="${cy + cap}" class="bwhisker"/>
  <line x1="${x(p.max).toFixed(1)}" y1="${cy - cap}" x2="${x(p.max).toFixed(1)}" y2="${cy + cap}" class="bwhisker"/>
  <rect x="${x(p.p25).toFixed(1)}" y="${cy - half}" width="${Math.max(1, x(p.p75) - x(p.p25)).toFixed(1)}" height="${2 * half}" class="bbox"/>
  <line x1="${x(p.p50).toFixed(1)}" y1="${cy - half}" x2="${x(p.p50).toFixed(1)}" y2="${cy + half}" class="bmedian"/>
  <circle cx="${x(p.mean).toFixed(1)}" cy="${cy}" r="3.5" class="bmean"><title>mean ${p.mean.toFixed(1)}</title></circle>
  ${label(p.p50, x(p.p50), cy - half - 6)}
  ${label(p.min, x(p.min), belowY)}
  ${label(p.p25, x(p.p25), belowY)}
  ${label(p.p75, x(p.p75), belowY)}
  ${label(p.max, x(p.max), belowY)}
</svg>`;
}

const modeText = (m: [string, number][]) =>
  m.length ? m.map(([name, f]) => `${esc(name)} ${Math.round(100 * f)}%`).join(" · ") : "—";

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

// One toggleable view = a resolution × variable-combo: histogram, box plot, period summary, and the
// occupancy table (columns sorted by share). All are emitted hidden; the client shows the selected.
function renderView(vk: string, vs: ViewStats, versionBits: number, headerBits: number): string {
  const [res, combo] = vk.split(":");
  const occupancyBits = versionBits + headerBits + vs.bodyBits;
  const rows = [
    { name: "version", bits: versionBits, bpp: null as number | null, modes: [] as [string, number][], bppStats: null as BoxStats | null },
    { name: "header", bits: headerBits, bpp: null as number | null, modes: [] as [string, number][], bppStats: null as BoxStats | null },
    ...vs.columns.map((c) => ({ name: c.name, bits: c.bits, bpp: c.bitsPerPeriod as number | null, modes: c.modes, bppStats: c.bppStats as BoxStats | null })),
  ].sort((a, b) => b.bits - a.bits);
  const bppScaleMax = Math.max(...vs.columns.map((c) => c.bppStats.max), 1);
  const occHtml = rows.map((r) => `<tr>
      <td class="name">${esc(r.name)}</td>
      <td class="num">${r.bits.toFixed(1)}</td>
      <td class="num">${r.bpp == null ? "—" : r.bpp.toFixed(2)}</td>
      <td class="num">${(100 * r.bits / occupancyBits).toFixed(1)}%</td>
      <td class="boxcell">${r.bppStats ? renderMiniBox(r.bppStats, bppScaleMax) : ""}</td>
      <td class="modes">${modeText(r.modes)}</td>
    </tr>`).join("\n");
  const p = vs.periods;
  return `<section class="view" data-res="${res}" data-combo="${combo}" hidden>
  ${renderHistogram(vs.histogram)}
  ${renderBoxPlot(p)}
  <table class="summary">
    <tr><th>min</th><th>Q1</th><th>median</th><th>mean</th><th>Q3</th><th>p90</th><th>max</th></tr>
    <tr><td class="num">${p.min}</td><td class="num">${p.p25}</td><td class="num">${p.p50}</td><td class="num">${p.mean.toFixed(1)}</td><td class="num">${p.p75}</td><td class="num">${p.p90}</td><td class="num">${p.max}</td></tr>
  </table>
  <h3>Mean bit occupancy per column</h3>
  <table>
    <tr><th>column</th><th class="rt">bits</th><th class="rt">bits/period</th><th class="rt">share</th><th>bits/period spread <span class="muted">(0–${bppScaleMax.toFixed(1)})</span></th><th>modes</th></tr>
    ${occHtml}
    <tr class="total"><td>total</td><td class="num">${occupancyBits.toFixed(1)}</td><td class="num"></td><td class="num">100%</td><td></td><td class="modes">≈ ${Math.round(occupancyBits / 6.409)} chars</td></tr>
  </table>
</section>`;
}

function renderHtml(s: ReportData): string {
  const viewFragments = Object.entries(s.views).map(([vk, vs]) => renderView(vk, vs, s.versionBits, s.headerBits)).join("\n");
  const resRadios = s.resolutions.map((r) =>
    `<label><input type="radio" name="res" value="${r}"${r === s.defaultResolution ? " checked" : ""}> ${esc(r)}</label>`).join("");
  const groupChecks = s.groups.map((g, i) =>
    `<label><input type="checkbox" class="group" value="${g.id}" data-bit="${1 << i}"${s.defaultCombo & (1 << i) ? " checked" : ""}> ${esc(g.label)}</label>`).join("");
  const quality = s.skipped ? `<div class="quality"><p>Skipped ${s.skipped} forecast(s) with an incomplete base series.</p></div>` : "";

  // Client data excludes the pre-rendered `views` (avoids duplicating them); the detail table is
  // rebuilt from these on every selection change.
  const clientData = {
    resolutions: s.resolutions, defaultResolution: s.defaultResolution,
    groups: s.groups, groupVars: s.groupVars, baseVars: s.baseVars, defaultCombo: s.defaultCombo,
    forecastRows: s.forecastRows, periodsByView: s.periodsByView, bpp: s.bpp,
  };

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
  table.summary { max-width: 360px; }
  tr.total td { font-weight: 600; border-top: 2px solid rgba(128,128,128,.4); border-bottom: none; }
  .legend { font-size: .75rem; color: #888; margin-top: .5rem; }
  .hist { width: 100%; max-width: 720px; height: auto; margin: .5rem 0 .25rem; }
  .hbar { fill: #3b82f6; }
  .hgrid { stroke: rgba(128,128,128,.25); stroke-width: 1; }
  .htick { fill: #888; font-size: 11px; }
  .haxis { fill: #888; font-size: 11px; }
  .box { width: 100%; max-width: 720px; height: auto; margin: 0 0 1rem; }
  .bwhisker { stroke: #888; stroke-width: 1.5; }
  .bbox { fill: rgba(59,130,246,.25); stroke: #3b82f6; stroke-width: 1.5; }
  .bmedian { stroke: #3b82f6; stroke-width: 2; }
  .bmean { fill: #e6a01e; }
  .blabel { fill: #888; font-size: 10px; font-variant-numeric: tabular-nums; }
  .boxcell { width: 210px; }
  .mbox { display: block; width: 200px; height: 20px; }
  .hint { font-size: .78rem; color: #888; margin: 0 0 .4rem; }
  .scroll { max-height: 460px; overflow: auto; border: 1px solid rgba(128,128,128,.2); border-radius: 6px; }
  table.detail { font-size: .78rem; }
  table.detail th, table.detail td { border-bottom: 1px solid rgba(128,128,128,.12); white-space: nowrap; }
  table.detail th { position: sticky; top: 0; background: Canvas; cursor: pointer; user-select: none; }
  table.detail th:hover { color: #3b82f6; }
  table.detail td.num { text-align: right; }
  table.detail th[data-dir=asc]::after { content: " ▲"; font-size: .7em; }
  table.detail th[data-dir=desc]::after { content: " ▼"; font-size: .7em; }
</style>
</head>
<body>
<h1>Encoding benchmark</h1>
<div class="meta">
  ${esc(s.timestamp)} · ${s.forecasts} forecasts · ${s.locations} locations · ${esc(s.model)} · max <code>${s.maxChars}</code> chars
</div>

<div class="selectors">
  <div class="sel"><span class="sel-label">Resolution</span>${resRadios}</div>
  <div class="sel"><span class="sel-label">Variables <span class="muted">(base always on)</span></span>${groupChecks}</div>
</div>
${quality}

<h2>Periods encoded per message</h2>
<div id="views">${viewFragments}</div>
<div class="legend">
  Box plots: box = Q1–Q3, blue line = median, orange dot = mean, whiskers = min–max. The per-column
  bits/period boxes share one x-scale (shown in the header); hover for exact values.
</div>

<h2>Per-forecast detail (${s.forecasts})</h2>
<p class="hint">Click a header to sort — e.g. by <code>periods</code> to find outliers. Per-variable values are bits/period at the full horizon (independent of the current selection).</p>
<div class="scroll"><table class="detail sortable" id="detail"></table></div>

<script type="application/json" id="benchmark-data">${JSON.stringify(clientData)}</script>
<script>
const D = JSON.parse(document.getElementById("benchmark-data").textContent);
const views = [...document.querySelectorAll(".view")];
const resRadios = [...document.querySelectorAll('input[name=res]')];
const groupBoxes = [...document.querySelectorAll('input.group')];
const detail = document.getElementById("detail");

const resolution = () => resRadios.find((r) => r.checked).value;
const combo = () => groupBoxes.reduce((c, b) => c | (b.checked ? +b.dataset.bit : 0), 0);
const selectedGroups = (c) => D.groups.filter((g, i) => c & (1 << i)).map((g) => g.id);

function attachSort(table) {
  const ths = table.tHead.rows[0].cells;
  for (let i = 0; i < ths.length; i++) ths[i].addEventListener("click", () => {
    const dir = ths[i].dataset.dir === "asc" ? "desc" : "asc";
    for (const th of ths) delete th.dataset.dir;
    ths[i].dataset.dir = dir;
    const mul = dir === "asc" ? 1 : -1, tb = table.tBodies[0];
    [...tb.rows].sort((a, b) => {
      const x = a.cells[i].textContent, y = b.cells[i].textContent;
      const nx = parseFloat(x), ny = parseFloat(y);
      return mul * (!isNaN(nx) && !isNaN(ny) ? nx - ny : x.localeCompare(y));
    }).forEach((r) => tb.appendChild(r));
  });
}

function buildDetail(res, c) {
  const cols = ["weathercode", ...D.baseVars, ...selectedGroups(c).flatMap((g) => D.groupVars[g])];
  const periods = D.periodsByView[res][c], bpp = D.bpp[res];
  const head = "<thead><tr><th>location</th><th>run</th><th class=rt>lat</th><th class=rt>lon</th><th class=rt>periods</th>" +
    cols.map((k) => "<th class=rt>" + k + "</th>").join("") + "</tr></thead>";
  const body = D.forecastRows.map((f, i) =>
    "<tr><td>" + f.location + "</td><td>" + f.run + "</td><td class=num>" + f.lat.toFixed(3) +
    "</td><td class=num>" + f.lon.toFixed(3) + "</td><td class=num>" + periods[i] + "</td>" +
    cols.map((k) => "<td class=num>" + (bpp[i][k] ?? 0).toFixed(2) + "</td>").join("") + "</tr>").join("");
  detail.innerHTML = head + "<tbody>" + body + "</tbody>";
  attachSort(detail);
}

function update() {
  const res = resolution(), c = combo();
  views.forEach((v) => v.hidden = !(v.dataset.res === res && +v.dataset.combo === c));
  buildDetail(res, c);
}

[...resRadios, ...groupBoxes].forEach((el) => el.addEventListener("change", update));
update();
</script>
</body>
</html>
`;
}

// ── Entry ──────────────────────────────────────────────────────────────────────────

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const locations = args.location ? LOCATIONS.filter((l) => l.id === args.location) : LOCATIONS;
  if (locations.length === 0) throw new Error(`No location matches --location ${args.location}`);

  if (!args.reportOnly) await collect(args, locations);
  if (args.dryRun || args.collectOnly) return; // preview / expand-cache only — don't encode
  await report(args);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
