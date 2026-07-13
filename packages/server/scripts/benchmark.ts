/**
 * Benchmark the forecast encoding against a corpus of real forecasts.
 *
 * One script, two phases:
 *   1. Collect — pull 14-day hourly GFS forecasts from Open-Meteo's Historical Forecast API (a
 *      continuous best-estimate archive, queried by start_date/end_date), sampling one window every
 *      ~10 days across the past year for seasonal coverage. Raw responses are cached to disk
 *      unchanged (idempotent/resumable), so re-runs don't re-hit the API. The window is 14 days so
 *      the longest duration we benchmark (10d) is fully covered — see REQUIRED_HOURS.
 *   2. Report — for each cached forecast, run the exact production path: buildFillMessage (the
 *      duration-first layout: layoutFor → window aggregation → toFullPeriod) fed to the same
 *      fitFillToBudget binary search the request path uses, over the identical fill sequence. So
 *      the report answers the product question — for a requested duration, how far up the
 *      refinement ladder (12h → 6h → 3h → 1h) does one message get? — and shows how the bit
 *      budget splits across the header and each variable column (with each column's chosen mode).
 *
 *   node packages/server/scripts/benchmark.ts                     # collect (idempotent) then report
 *   node packages/server/scripts/benchmark.ts --collect-only      # expand the cache, no report
 *   node packages/server/scripts/benchmark.ts --report-only       # report from cache, no collection
 *   node packages/server/scripts/benchmark.ts --dry-run           # preview collection plan, no fetch
 *   node packages/server/scripts/benchmark.ts --duration 5        # 3/5/7/10 days (default 7)
 *   node packages/server/scripts/benchmark.ts --request-hour 18   # local hour of the request (default 7)
 *   # other flags: --limit <n>, --max-chars <n>, --location <id>, --verbose, --include-incomplete, --no-open
 *
 * Open-Meteo call weight ≈ max(1, nVars/10) × max(1, weeks/2). A 14-day GFS call (~18 vars) is ~1.8
 * units; the full-year, all-locations pull is ~9.1k units. Free tier is 10,000 units/day.
 */
import { mkdir, readdir, readFile, writeFile, rename, access } from "node:fs/promises";
import { spawn } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { buildFillMessage, fitFillToBudget, type ForecastParams, type HourlyData } from "../src/forecast.ts";
import {
  VARS_BIT, RESOLUTION_HOURS, FILL_STAGES, slotsFor, maxFillSeq, v1EncodeBreakdown,
  type ForecastMessage, type V1Breakdown,
} from "@weather/protocol";

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
// Short forms for the frontier chart, where each curve is labelled on the plot itself.
const GROUP_SHORT: Record<GroupId, string> = {
  clouds: "Cloud", highwind: "Wind", freeze: "FL",
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

// Window length. A D-day fill covers D + 1 local day slots from local midnight of the request day
// (slotsFor), and a non-zero UTC offset shifts that span up to a day past the UTC window — so the
// longest benchmarked duration (10d) needs 11 whole local days plus slack. 14 keeps every duration
// fully covered with room to spare; a shorter window would make the seq search hit a data gap and
// silently report *truncated* layouts as if the char budget had caused the truncation.
const HORIZON_DAYS = 14;       // window length (days)
const REQUIRED_HOURS = HORIZON_DAYS * 24; // complete cached response; short ones are re-fetched
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

// The report pivots on the requested duration (the `d:` request token), because that is what the
// user actually chooses: duration is an input to the encoder, and resolution is the *output* the
// fill sequence buys with whatever budget is left.
const DURATIONS = [3, 5, 7, 10];
const DEFAULT_DURATION = 7; // the server's default when a request carries no `d:`

// The messages the detail view draws: the whole spread, from the worst forecasts to encode (p1 —
// stormy, high-entropy) to the easiest (p99 — stable).
const PERCENTILES = [1, 10, 25, 50, 75, 90, 99];

// Rung labels by resolution index (RESOLUTION_HOURS). The fill ladder walks 1..4 (12h → 1h).
const RUNG = Object.fromEntries(
  Object.entries(RESOLUTION_HOURS).map(([i, h]) => [i, `${h}h`]),
) as Record<number, string>;

// The fill sequence, in words. Mirrors layoutFor's arithmetic (layout.ts): over S = D + 1 day
// slots, seq < S is a truncated all-12h forecast, and stage k (seq = (k−1)S + j) refines the
// first j slots one rung finer — so seq = kS is exactly "the whole window at rung k". Those four
// multiples of S are the landmarks the report marks on every seq axis.
function seqLabel(durationDays: number, seq: number): string {
  const S = slotsFor(durationDays);
  if (seq < S) return `${seq}/${S} slots @ ${RUNG[1]} (truncated)`;
  const t = seq - S;
  const fine = t === 0 ? 1 : Math.ceil(t / S) + 1;
  const nFine = t === 0 ? S : t - (fine - 2) * S;
  return nFine === S
    ? `all ${S} slots @ ${RUNG[fine]}`
    : `${nFine}/${S} slots @ ${RUNG[fine]}, rest @ ${RUNG[fine - 1]}`;
}

// Full-fill landmarks: seq = k × S is the whole window at rung k (12h, 6h, 3h, 1h).
function fullFillMarks(durationDays: number): { seq: number; label: string }[] {
  const S = slotsFor(durationDays);
  return Array.from({ length: FILL_STAGES }, (_, k) => ({ seq: (k + 1) * S, label: RUNG[k + 1] }));
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
const BASE_VARS = ["precip", "temp", "snow", "rain", "wind"];
const GROUP_VARS: Record<GroupId, string[]> = {
  clouds: ["cch", "ccm", "ccl"],
  highwind: ["w500", "w600", "w700"],
  freeze: ["freeze"],
};
const maskOf = (vars: string[]) => vars.reduce((m, v) => m | (1 << VARS_BIT[v]), 0);
const BASE_MASK = maskOf(BASE_VARS);

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
  duration: number;      // which duration the report opens on (all of DURATIONS are computed)
  requestHour: number;   // local hour of day the request is assumed to arrive at
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
    duration: DEFAULT_DURATION, requestHour: 7, maxChars: 160, verbose: false,
    includeIncomplete: false, open: true,
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
    else if (a === "--duration") args.duration = parseInt(argv[++i], 10);
    else if (a === "--request-hour") args.requestHour = parseInt(argv[++i], 10);
    else if (a === "--max-chars") args.maxChars = parseInt(argv[++i], 10);
    else if (a === "--location") args.location = argv[++i];
    else throw new Error(`Unknown argument: ${a}`);
  }
  if (!DURATIONS.includes(args.duration)) {
    throw new Error(`--duration must be one of ${DURATIONS.join(", ")}`);
  }
  if (!(args.requestHour >= 0 && args.requestHour <= 23)) {
    throw new Error(`--request-hour must be 0..23`);
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

// A cached record is reusable only if it covers the whole window. HORIZON_DAYS grew (10 → 14) when
// the report moved to duration-first fill, so records from an earlier pull are short — reuse one and
// the longest layouts would hit a data gap and be misreported as budget-truncated. Re-fetch instead.
async function cachedComplete(path: string): Promise<boolean> {
  try {
    const rec = JSON.parse(await readFile(path, "utf8")) as CorpusRecord;
    return (rec.response?.hourly?.time?.length ?? 0) >= REQUIRED_HOURS;
  } catch {
    return false; // unreadable or half-written — treat as absent and re-fetch
  }
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

  let fetched = 0, cached = 0, stale = 0, failed = 0, attempts = 0, weightSpent = 0;
  const shapePrinted = new Set<string>(); // one shape summary per model

  outer: for (const model of MODELS) {
    const perCallWeight = estWeight(modelHourly(model).length, HORIZON_DAYS);
    for (const loc of locations) {
      for (const startMs of windows) {
        const run = runIso(startMs); // window anchor, 00:00 UTC
        const path = cachePath(model.id, loc, run);
        if (await exists(path)) {                          // resumable
          if (await cachedComplete(path)) { cached++; continue; }
          stale++; // short window (pre-14d pull) — fall through and re-fetch, overwriting it
        }

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

  console.log(`  done: fetched=${fetched} cached=${cached} stale=${stale} failed=${failed} est_weight_spent=${weightSpent.toFixed(1)} units`);
}

// ── Phase 2: report ────────────────────────────────────────────────────────────────

interface CorpusRecord { meta: { location: { id: string; lat: number; lon: number }; run: string }; response: any }

async function loadModel(modelId: string, locationFilter?: string): Promise<CorpusRecord[]> {
  const modelDir = join(CORPUS_DIR, modelId);
  if (!(await exists(modelDir))) return [];
  const locs = (await readdir(modelDir, { withFileTypes: true }))
    .filter((d) => d.isDirectory() && (!locationFilter || d.name === locationFilter))
    .map((d) => d.name);
  const records: CorpusRecord[] = [];
  for (const loc of locs) {
    const dir = join(modelDir, loc);
    for (const f of await readdir(dir)) {
      if (!f.endsWith(".json")) continue;
      try {
        records.push(JSON.parse(await readFile(join(dir, f), "utf8")) as CorpusRecord);
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

// The layout the production search landed on for one (forecast, duration, variable-combo), plus its
// bit breakdown.
interface Fit {
  seq: number;       // seq < slotsFor(D) means the budget forced truncation below the duration
  periods: number;   // periods in the fitted message
  breakdown: V1Breakdown;
}

// The production fit, exactly: fitFillToBudget's binary search over the fill sequence, with each
// candidate encoded through the real codec. The only difference from the request path is that we
// keep the breakdown instead of just the string (fitFillToBudget is generic over that).
function fitFill(
  msgAt: (seq: number) => ForecastMessage | null,
  durationDays: number,
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
    maxFillSeq(durationDays),
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
  durationDays: number,
  fits: Fit[],
  cb: Map<string, number[]>,
  cm: Map<string, Map<string, number>>,
): ViewStats {
  const seqs = fits.map((f) => f.seq);
  const periods = fits.map((f) => f.periods);
  const slots = slotsFor(durationDays);
  const maxSeq = maxFillSeq(durationDays);

  // Histogram over the whole sequence (1..4S), not just the observed range, so the four full-fill
  // landmarks are always on the axis and every duration's chart reads the same way.
  const counts = new Map<number, number>();
  for (const s of seqs) counts.set(s, (counts.get(s) ?? 0) + 1);
  const histogram = Array.from({ length: maxSeq }, (_, i) => ({ seq: i + 1, count: counts.get(i + 1) ?? 0 }));

  // How often the budget carried the message all the way to a full fill at each rung.
  const stages = fullFillMarks(durationDays).map(({ seq, label }) => ({
    seq, label, share: seqs.filter((s) => s >= seq).length / seqs.length,
  }));

  const columns: ColStat[] = [...cb.entries()].map(([name, bitsArr]) => {
    const bpp = bitsArr.map((b, i) => b / periods[i]);
    return {
      name,
      bits: mean(bitsArr),
      bitsPerPeriod: mean(bpp),
      bppStats: box(bpp),
      modes: [...cm.get(name)!.entries()].sort((a, b) => b[1] - a[1]).map(([m, c]) => [m, c / bitsArr.length] as [string, number]),
    };
  });

  const medianSeq = pct(seqs, 50);
  return {
    durationDays, slots, maxSeq,
    seq: box(seqs),
    periods: box(periods),
    percentiles: PERCENTILES.map((p) => ({ p, seq: pct(seqs, p) })),
    medianSeq,
    medianLabel: seqLabel(durationDays, medianSeq),
    stages,
    histogram,
    bodyBits: columns.reduce((s, c) => s + c.bits, 0),
    columns,
  };
}

async function report(args: Args): Promise<void> {
  // Single model (GFS — it supplies every variable group, so no cross-model fallback is needed).
  const model = MODELS[0];
  const records = new Map<string, CorpusRecord>();
  for (const rec of await loadModel(model.id, args.location)) records.set(`${rec.meta.location.id}|${rec.meta.run}`, rec);
  const keys = [...records.keys()].sort();
  if (keys.length === 0) throw new Error("No forecasts found — run collection first");

  // A view = duration × variable-combo. Every (duration, combo) is precomputed.
  const vkey = (durationDays: number, combo: number) => `${durationDays}:${combo}`;
  const fitsFor = new Map<string, Fit[]>();
  const colBits = new Map<string, Map<string, number[]>>();
  const colModes = new Map<string, Map<string, Map<string, number>>>();
  for (const d of DURATIONS) for (const c of COMBOS) {
    const vk = vkey(d, c);
    fitsFor.set(vk, []); colBits.set(vk, new Map()); colModes.set(vk, new Map());
  }

  const forecasts: { location: string }[] = [];
  const allMask = comboMask(COMBOS.length - 1); // every group on
  let versionBits = 0, headerBits = 0, skipped = 0, short = 0, uncovered = 0;

  for (const key of keys) {
    const rec = records.get(key)!;
    const h = rec.response.hourly as HourlyData;
    // Records from a pull with a shorter HORIZON_DAYS are still on disk (growing the horizon moves
    // the window anchor, so re-collection writes new keys rather than overwriting them). Skip them:
    // a short record can't serve the longest durations, and mixing them in would silently give each
    // duration a different sample of forecasts.
    if (h.time.length < REQUIRED_HOURS) { short++; continue; }
    if (!baseComplete(h)) { skipped++; continue; }
    const [locId, run] = key.split("|");
    const { lat, lon } = rec.meta.location;
    const elevation = rec.response.elevation ?? 0;
    const utcOffsetHours = utcOffsetFor(lon);
    const startEpochHour = requestUtcHour(
      Math.floor(Date.parse(run + "Z") / 3600000), utcOffsetHours, args.requestHour);
    forecasts.push({ location: locId });

    for (const durationDays of DURATIONS) {
      // Build layouts with every column populated (varsMask = allMask), then override vars_mask per
      // combo: columns encode independently, so one aggregation per seq serves all eight combos.
      // "GFS" (non-HRES) keeps the pressure/freeze columns in toFullPeriod.
      const params: ForecastParams = {
        locationIdx: 0, lat, lon, durationDays, utcOffsetHours,
        modelsMask: 1, varsMask: allMask, maxChars: args.maxChars,
        decoderVersion: 1, code: 0, startEpochHour, userToken: null,
      };
      const memo = new Map<number, ForecastMessage | null>();
      const msgAt = (seq: number): ForecastMessage | null => {
        if (!memo.has(seq)) {
          memo.set(seq, buildFillMessage(h, h.time, params, seq, lat, lon, elevation, model.label));
        }
        return memo.get(seq)!;
      };

      // The corpus window must cover the whole fill span. If it doesn't, the seq search would read
      // the data gap as "doesn't fit" and report a *truncated* layout as though the char budget had
      // caused it. Every untruncated seq spans the same days, so checking the all-1h layout is
      // enough. (With a 14-day window this should never fire; it guards the metric if it ever does.)
      if (msgAt(maxFillSeq(durationDays)) === null) { uncovered++; continue; }

      for (const c of COMBOS) {
        const fit = fitFill(msgAt, durationDays, comboMask(c), args.maxChars)!; // seq=1 is covered
        const vk = vkey(durationDays, c);
        fitsFor.get(vk)!.push(fit);
        versionBits = fit.breakdown.versionBits; headerBits = fit.breakdown.headerBits;
        const cb = colBits.get(vk)!, cm = colModes.get(vk)!;
        for (const col of fit.breakdown.columns) {
          if (!cb.has(col.name)) { cb.set(col.name, []); cm.set(col.name, new Map()); }
          cb.get(col.name)!.push(col.bits);
          if (col.mode) { const mm = cm.get(col.name)!; mm.set(col.mode, (mm.get(col.mode) ?? 0) + 1); }
        }
        // Column bits are model costs; the rANS stream adds a constant flush/renorm slack per
        // message. Track it as a pseudo-column so the occupancy total reconciles with the chars.
        if (!cb.has("coder")) { cb.set("coder", []); cm.set("coder", new Map()); }
        cb.get("coder")!.push(fit.breakdown.overheadBits);
      }
    }
  }

  // Build per-view stats. A duration the corpus can't cover for *any* forecast has no fits at all —
  // drop it rather than render a view full of NaNs (it means the window is too short; see
  // HORIZON_DAYS).
  const durations = DURATIONS.filter((d) => fitsFor.get(vkey(d, DEFAULT_COMBO))!.length > 0);
  if (durations.length === 0) throw new Error("No (forecast, duration) pair is covered by the corpus — re-collect with a longer window");
  const views: Record<string, ViewStats> = {};
  for (const d of durations) {
    for (const c of COMBOS) {
      const vk = vkey(d, c);
      views[vk] = buildView(d, fitsFor.get(vk)!, colBits.get(vk)!, colModes.get(vk)!);
    }
  }
  const dropped = DURATIONS.filter((d) => !durations.includes(d));
  const defaultDuration = durations.includes(args.duration) ? args.duration : durations[0];

  const stats: ReportData = {
    timestamp: new Date().toISOString(),
    durations,
    dropped,
    defaultDuration,
    requestHour: args.requestHour,
    maxChars: args.maxChars,
    forecasts: forecasts.length,
    locations: new Set(forecasts.map((f) => f.location)).size,
    skipped,
    short,
    uncovered,
    versionBits, headerBits,
    model: model.label,
    groups: GROUP_IDS.map((g) => ({ id: g, label: GROUP_LABEL[g], short: GROUP_SHORT[g] })),
    defaultCombo: DEFAULT_COMBO,
    views,
  };

  await mkdir(BENCHMARKS_DIR, { recursive: true });
  const stamp = stats.timestamp.replace(/[:.]/g, "-").slice(0, 19);
  const outPath = join(BENCHMARKS_DIR, `${stamp}_${args.maxChars}c.html`);
  await writeFile(outPath, renderHtml(stats));

  const dv = views[vkey(defaultDuration, stats.defaultCombo)];
  console.log(`\n== Benchmark ==`);
  console.log(`  ${stats.forecasts} forecasts, ${stats.locations} locations, ${model.label}, durations ${durations.join("/")}d  |  max-chars=${args.maxChars}, request ${args.requestHour}:00 local`);
  if (short) console.log(`  ignored ${short} cached forecast(s) from a shorter-window pull (< ${HORIZON_DAYS}d — leftovers, safe to delete)`);
  if (skipped) console.log(`  skipped ${skipped} forecast(s) with an incomplete base series`);
  if (uncovered) console.log(`  skipped ${uncovered} (forecast, duration) pair(s) the corpus window doesn't cover`);
  if (dropped.length) console.log(`  dropped ${dropped.join("/")}d entirely — no forecast in the corpus covers them (re-collect: the window must be ≥ ${HORIZON_DAYS}d)`);
  console.log(`  default view (${args.duration}d, base): seq mean ${dv.seq.mean.toFixed(1)} of ${dv.maxSeq}, median ${dv.medianSeq} = ${dv.medianLabel}`);
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
// A full-fill landmark: seq = k × S is the whole window at rung `label`, reached by `share` of messages.
interface StageStat { seq: number; label: string; share: number }
interface ViewStats {
  durationDays: number;
  slots: number;   // S = D + 1 day slots
  maxSeq: number;  // 4S — the whole window at 1h, the top of the ladder
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
// Everything the report embeds. `views` holds one ViewStats per duration:combo.
interface ReportData {
  timestamp: string;
  durations: number[];   // durations the corpus can serve (a view exists for each)
  dropped: number[];     // requested durations no forecast covers — corpus window too short
  defaultDuration: number;
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
  groups: { id: GroupId; label: string; short: string }[];
  defaultCombo: number;
  views: Record<string, ViewStats>;                        // "duration:combo" → stats
}

// Fill as a fraction of the sequence: seq / 4S. 100% is the top of the ladder — the whole window at
// 1h — and the four rungs land at 25/50/75/100% (the whole window at 12h/6h/3h/1h). Normalizing by
// the sequence length is what makes different durations comparable on one axis.
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
function stripLayout(durationDays: number, seq: number, requestHour: number): StripSlot[] {
  const S = slotsFor(durationDays);
  const truncated = seq < S;
  const days = truncated ? seq : S;
  const t = truncated ? 0 : seq - S;
  const fine = t === 0 ? 1 : Math.ceil(t / S) + 1;
  const nFine = t === 0 ? days : t - (fine - 2) * S;
  return Array.from({ length: S }, (_, d) => {
    if (d >= days) return { res: 0, periodHours: 0, startHour: 0 }; // truncated away
    const res = d < nFine ? fine : fine - 1;
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
  const slots = stripLayout(vs.durationDays, seq, requestHour);
  const { W, l, r, periodGap, dayGap } = STRIP;
  const H = 34, m = { t: 1, b: 1 };
  const barH = H - m.t - m.b;
  const slotW = (W - l - r) / (scaleSlots ?? slots.length);
  const dayW = slotW - dayGap; // the day's fills; the remainder is the gap to the next day

  const cells = slots.map((slot, d) => {
    const x0 = l + d * slotW;
    if (slot.res === 0) {
      return `<rect x="${x0.toFixed(1)}" y="${m.t}" width="${dayW.toFixed(1)}" height="${barH}" class="slot-empty">` +
        `<title>${dayName(d)} — not covered: the budget truncated the forecast below ${vs.durationDays}d</title></rect>`;
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

  return `<svg viewBox="0 0 ${W} ${H}" class="strip" role="img" aria-label="One message: ${esc(seqLabel(vs.durationDays, seq))}">
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
  const keys = Array.from({ length: FILL_STAGES }, (_, i) => i + 1)
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
  <div class="striphead indent"><div></div>${renderStripAxis(slotsFor(vs.durationDays))}</div>
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
  const { maxSeq, slots } = vs;
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

  // One stepped polygon per ladder stage, so each quarter of the x-axis carries its rung's colour.
  const areas = Array.from({ length: FILL_STAGES }, (_, k) => {
    const from = k * slots + 1, to = (k + 1) * slots;
    const pts: string[] = [`${xEdge(from - 1).toFixed(1)},${base.toFixed(1)}`];
    for (let seq = from; seq <= to; seq++) {
      pts.push(`${xEdge(seq - 1).toFixed(1)},${y(reach[seq]).toFixed(1)}`);
      pts.push(`${xEdge(seq).toFixed(1)},${y(reach[seq]).toFixed(1)}`);
    }
    pts.push(`${xEdge(to).toFixed(1)},${base.toFixed(1)}`);
    return `<polygon points="${pts.join(" ")}" class="rung r${k + 1} area"/>`;
  }).join("");

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
    `<title>${pctText(seq / maxSeq)} filled (seq ${seq} — ${esc(seqLabel(vs.durationDays, seq))})\n` +
    `${(100 * reach[seq]).toFixed(1)}% of forecasts reach at least this far</title></rect>`).join("");

  // y: share of forecasts, 0–100%.
  const yAxis = [0, 0.25, 0.5, 0.75, 1].map((v) =>
    `<line x1="${m.l}" y1="${y(v).toFixed(1)}" x2="${W - m.r}" y2="${y(v).toFixed(1)}" class="hgrid"/>` +
    `<text x="${m.l - 8}" y="${(y(v) + 3.5).toFixed(1)}" class="htick" text-anchor="end">${(100 * v).toFixed(0)}%</text>`).join("");

  // x: fill percentage, ticked at the rungs (the stage boundaries are exactly 25/50/75/100%). Each
  // rung is labelled with the share of forecasts that reach it — the four numbers worth reading off
  // this curve, stated rather than left to the eye.
  const xAxis = vs.stages.map((st, k) => {
    const x = xEdge(st.seq);
    const anchor = k + 1 === FILL_STAGES ? "end" : "middle";
    return `<line x1="${x.toFixed(1)}" y1="${m.t}" x2="${x.toFixed(1)}" y2="${base.toFixed(1)}" class="mark"/>` +
      `<text x="${x.toFixed(1)}" y="${m.t - 10}" class="marklabel" text-anchor="${anchor}">` +
      `${esc(st.label)} · ${(100 * st.share).toFixed(1)}%</text>` +
      `<text x="${x.toFixed(1)}" y="${H - m.b + 16}" class="htick" text-anchor="${anchor}">${pctText((k + 1) / FILL_STAGES)}</text>`;
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

const modeText = (m: [string, number][]) =>
  m.length ? m.map(([name, f]) => `${esc(name)} ${Math.round(100 * f)}%`).join(" · ") : "—";

// Mean fill as a bar: a fixed 0–100% track with the value filled in, so a row of cells can be
// compared at a glance without reading the numbers. The track is always the full scale — a short bar
// means a small share of a full 1h fill, never a rescaled axis.
//
// The fill is segmented by rung, in the same colours the message strips use: each quarter of the bar
// is one stage of the ladder, so a bar reaching into the third segment has covered the duration at
// 6h and is partway through refining it to 3h. Colour therefore means the same thing everywhere on
// the page — darker is finer.
function renderFillBar(fill: number): string {
  const W = 150, H = 10, r = 2, gap = 1;
  const stage = 1 / FILL_STAGES;
  const segments = Array.from({ length: FILL_STAGES }, (_, k) => {
    const from = k * stage, to = Math.min(fill, (k + 1) * stage);
    if (to <= from) return "";
    const w = W * (to - from) - gap;
    if (w <= 0) return "";
    return `<rect x="${(W * from).toFixed(1)}" y="0" width="${w.toFixed(1)}" height="${H}" rx="${r}" class="rung r${k + 1}"/>`;
  }).join("");
  return `<svg viewBox="0 0 ${W} ${H}" class="fillbar" role="img" aria-label="${pctText(fill)} of a full 1h fill">` +
    `<title>${pctText(fill)} filled — 25% = the whole duration at 12h, 50% at 6h, 75% at 3h, 100% at 1h</title>` +
    `<rect x="0" y="0" width="${W}" height="${H}" rx="${r}" class="fbtrack"/>${segments}` +
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

// The frontier: for each duration, a solid curve for the base variables and a faint dashed curve per
// optional variable group, added one at a time (never in combination — that would be 32 lines). This
// is the regression chart: an encoding improvement pushes every curve right (more resolution for the
// same 160 characters), and because these are whole distributions you see *where* it lands rather
// than just a mean. x is fill percentage, which is what makes durations with different sequence
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

  // Direct labels on the plot: the duration on each solid curve, the variable selection on each
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

  // One group per duration. The solid line pools exactly the selections drawn beneath it — the base
  // variables plus each optional group on its own — so it reads as the average of its components and
  // still moves when any single variable's encoding changes. (Pooling all 2^n *combinations* would
  // weight the heavy ones and pull the solid line away from the curves it sits among.) Components
  // stay hidden until the duration is hovered, so the chart is four lines at rest. The fat
  // transparent path over the solid curve is the hit target — a 2px line is too thin to hover.
  const groups = s.durations.map((d, i) => {
    const slot = i + 1;
    const components = [
      { combo: s.defaultCombo, label: "Base", share: 0.8 },
      ...s.groups.map((g, gi) => ({
        combo: 1 << gi, label: g.short, share: [0.65, 0.5, 0.35][gi] ?? 0.5,
      })),
    ].map((c, ci) => ({ ...c, dash: ci + 1, vs: s.views[`${d}:${c.combo}`] }))
      .filter((c) => c.vs);
    if (components.length === 0) return "";

    const componentSvg = components.map((c) =>
      draw([c.vs], `c${slot} variant dash${c.dash}`, c.label, c.share)).join("");
    const meanPts = reachPoints(components.map((c) => c.vs));
    return `<g class="dseries">${componentSvg}` +
      `${draw(components.map((c) => c.vs), `c${slot}`, `${d}d`, 0.5)}` +
      `<path d="${smoothPath(meanPts)}" class="fhit"/></g>`;
  }).join("");

  const yAxis = [0, 0.25, 0.5, 0.75, 1].map((v) =>
    `<line x1="${m.l}" y1="${y(v).toFixed(1)}" x2="${W - m.r}" y2="${y(v).toFixed(1)}" class="hgrid"/>` +
    `<text x="${m.l - 8}" y="${(y(v) + 3.5).toFixed(1)}" class="htick" text-anchor="end">${(100 * v).toFixed(0)}%</text>`).join("");

  const xAxis = Array.from({ length: FILL_STAGES }, (_, k) => {
    const fill = (k + 1) / FILL_STAGES;
    const anchor = k + 1 === FILL_STAGES ? "end" : "middle";
    return `<line x1="${x(fill).toFixed(1)}" y1="${m.t}" x2="${x(fill).toFixed(1)}" y2="${y(0).toFixed(1)}" class="mark"/>` +
      `<text x="${x(fill).toFixed(1)}" y="${m.t - 10}" class="marklabel" text-anchor="${anchor}">${esc(RUNG[k + 1])}</text>` +
      `<text x="${x(fill).toFixed(1)}" y="${H - m.b + 16}" class="htick" text-anchor="${anchor}">${pctText(fill)}</text>`;
  }).join("");

  return `<svg viewBox="0 0 ${W} ${H}" class="hist frontier-chart" role="img" aria-label="Share of forecasts reaching each fill level, by forecast duration">
  ${yAxis}${xAxis}${groups}
  <text x="${m.l + iw / 2}" y="${H - 4}" class="haxis" text-anchor="middle">FILL PERCENTAGE</text>
  <text x="12" y="${m.t + ih / 2}" class="haxis" text-anchor="middle" transform="rotate(-90 12 ${m.t + ih / 2})">PERCENT OF FORECASTS</text>
</svg>`;
}

function renderDurationComparison(s: ReportData): string {
  const configurations = [
    { label: "Base", combo: 0 },
    ...s.groups.map((g, i) => ({ label: `+${g.label}`, combo: 1 << i })),
  ];
  const head = s.durations.map((d) => `<th>${d}d</th>`).join("");
  const view = (d: number, combo: number) => s.views[`${d}:${combo}`];
  // One row per forecast length: the median message it produces, drawn. Every row shares the day
  // pitch of the longest duration, so a longer forecast reads as a longer strip — and the resolution
  // it had to give up to get there is the colour shift down the stack.
  const maxSlots = Math.max(...s.durations.map(slotsFor));
  const perDuration = s.durations.map((d) => {
    const vs = view(d, s.defaultCombo);
    return `<div class="striprow">
      <div class="striplabel"><strong>${d}d</strong> · ${pctText(vs.medianSeq / vs.maxSeq)} filled</div>
      ${renderLayoutStrip(vs, vs.medianSeq, s.requestHour, maxSlots)}
    </div>`;
  }).join("\n");
  const rows = configurations.map(({ label, combo }) => `<tr><td class="name">${esc(label)}</td>` +
    s.durations.map((d) => {
      const fill = fillBox(view(d, combo)).mean;
      return `<td><div class="pcell"><span class="pmean">${pctText(fill)}</span>${renderFillBar(fill)}</div></td>`;
    }).join("") + `</tr>`).join("\n");
  return `<h2>Median message by forecast duration</h2>
  <p class="note">The chart shows the resolution of the median message at each forecast duration.</p>
  ${renderRungLegend()}
  <div class="striphead"><div></div>${renderStripAxis(maxSlots)}</div>
  <div class="strips">${perDuration}</div>
  <h2>Mean fill percentage by forecast duration and variable selection</h2>
  <table class="period-comparison">
    <tr><th>Variables</th>${head}</tr>
    ${rows}
  </table>
  <h2>Fill frontier</h2>
  <p class="note">Percent of forecasts reaching each fill resolution, averaged over the base
  variables and each optional variable added on its own — so the line moves when any variable's
  encoding changes. An encoding improvement moves the curves to the right. Hover a duration to break
  it into those component curves.</p>
  <div class="legend"><span class="legend-label">duration</span>${s.durations.map((d, i) =>
    `<span class="key"><i class="sw c${i + 1}"></i>${d}d</span>`).join("")}</div>
  ${renderFrontier(s)}`;
}

// One toggleable view = a duration × variable-combo: fill summary, the percentile strips, the seq
// histogram, and the occupancy table. All are emitted hidden; the client shows the selected one.
function renderView(vk: string, vs: ViewStats, versionBits: number, headerBits: number, requestHour: number): string {
  const [duration, combo] = vk.split(":");
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
  return `<section class="view" data-duration="${duration}" data-combo="${combo}" hidden>
  <h3>Fill resolution distribution</h3>
  <div class="strips">${renderPercentileStrips(vs, requestHour)}</div>
  <h3>Percent of forecasts reaching each fill resolution</h3>
  ${renderReachArea(vs)}
  <h3>Mean bit cost per column</h3>
  <table>
    <tr><th>column</th><th class="rt">bits</th><th class="rt">bits/period</th><th class="rt">share</th><th>bits/period spread <span class="muted">(0–${bppScaleMax.toFixed(1)})</span></th><th>modes</th></tr>
    ${occHtml}
    <tr class="total"><td>total</td><td class="num">${occupancyBits.toFixed(1)}</td><td class="num"></td><td class="num">100%</td><td></td><td class="modes">≈ ${Math.round(occupancyBits / 6.409)} chars</td></tr>
  </table>
</section>`;
}

function renderHtml(s: ReportData): string {
  const viewFragments = Object.entries(s.views).map(([vk, vs]) => renderView(vk, vs, s.versionBits, s.headerBits, s.requestHour)).join("\n");
  const comparison = renderDurationComparison(s);
  const durationRadios = s.durations.map((d) =>
    `<label><input type="radio" name="duration" value="${d}"${d === s.defaultDuration ? " checked" : ""}> ${d}d</label>`).join("");
  const groupChecks = s.groups.map((g, i) =>
    `<label><input type="checkbox" class="group" value="${g.id}" data-bit="${1 << i}"${s.defaultCombo & (1 << i) ? " checked" : ""}> ${esc(g.label)}</label>`).join("");
  const notes = [
    s.skipped ? `Skipped ${s.skipped} forecast(s) with an incomplete base series.` : "",
    s.uncovered ? `Skipped ${s.uncovered} (forecast, duration) pair(s) the corpus window doesn't cover.` : "",
    s.dropped.length ? `Dropped ${s.dropped.map((d) => `${d}d`).join(", ")} entirely — no forecast in the corpus covers that duration. Re-collect: the cached windows are shorter than the ${HORIZON_DAYS}-day window this report needs.` : "",
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
  ${esc(s.timestamp)} · ${s.forecasts} forecasts · ${s.locations} locations · ${esc(s.model)} · max <code>${s.maxChars}</code> chars ·
  request at <code>${s.requestHour}:00</code> local
</div>

<div class="intro">
  <p>Going Blue uses an entropy coding scheme where the number of forecast periods in each message
  depends on the entropy of the weather forecast. Forecasts for stable conditions with little entropy
  use far less information than those for stormy, variable conditions. This dashboard helps visualize
  how much data is transmitted at each forecast length.</p>

  <p>The forecast length is fixed and the time resolution is dynamic. Going Blue tries to fit as much
  data as possible into each message. It fills the entire time duration with the highest resolution it
  can, then partially fills the message with as much of the next higher resolution as possible. For
  example, a 10 day forecast might have the first 2 days at 3h resolution and the remaining 8 days at
  6h resolution. How far the algorithm gets in this process is expressed through a sequence number,
  where the highest possible value represents a forecast where the full duration is at 1h
  resolution.</p>

  <p>The units of this dashboard are fill percentage, which represents the sequence number as a
  percentage of the maximum possible.</p>
</div>

${comparison}

<h2>Benchmark detail</h2>
<div class="selectors">
  <div class="sel"><span class="sel-label">Duration</span>${durationRadios}</div>
  <div class="sel"><span class="sel-label">Variables</span>${groupChecks}</div>
</div>
${quality}

<div id="views">${viewFragments}</div>

<script>
const views = [...document.querySelectorAll(".view")];
const durationRadios = [...document.querySelectorAll('input[name=duration]')];
const groupBoxes = [...document.querySelectorAll('input.group')];

const duration = () => durationRadios.find((r) => r.checked).value;
const combo = () => groupBoxes.reduce((c, b) => c | (b.checked ? +b.dataset.bit : 0), 0);

function update() {
  const d = duration(), c = combo();
  views.forEach((v) => v.hidden = !(v.dataset.duration === d && +v.dataset.combo === c));
}

[...durationRadios, ...groupBoxes].forEach((el) => el.addEventListener("change", update));
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
