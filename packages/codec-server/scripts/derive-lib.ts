/**
 * Shared helpers for the codebook derivation scripts (derive-*.ts). Each derive script exports
 * `derive()`, returning the integer weight tables it owns keyed by the constant name they get in
 * packages/protocol/src/codebooks.gen.ts — generate-codebooks.ts collects them all and writes
 * that file. Run standalone (`pnpm exec tsx scripts/derive-foo.ts`), a script prints its tables and stats
 * without writing anything.
 */
import { fileURLToPath } from "node:url";
import { adjustPrecipPhase, type HourlyData } from "../src/forecast.ts";
import { dbLocations, listCells, loadCell, modelElevations, openDb } from "./corpus-db.ts";

// The derivation corpus: the production source's cells in the corpus DB (see corpus-db.ts).
// Only `split: "train"` locations are visited — eval sites (including all favorites) are
// reserved for the benchmark report and never influence a codebook.
export const DERIVE_SOURCE = "best_match";

// The hourly variables the derivation pipeline consumes: everything adjustPrecipPhase and
// rowsFromWindows/aggregateHourly read, plus the counters' direct accesses. eachForecast loads
// ONLY these by default — corpus cells carry every collected series (~80), and JSON-parsing the
// unused ones tripled scan time. IMPORTANT: a derive/analyze script that reads a variable not
// listed here sees an absent column and silently counts nothing — add the variable here (or
// pass `vars: null` to eachForecast for an unfiltered load) when introducing one.
export const DERIVE_VARS: readonly string[] = [
  "temperature_2m", "freezing_level_height", "weather_code",
  "rain", "showers", "snowfall", "precipitation_probability",
  "wind_speed_10m", "wind_direction_10m", "wind_gusts_10m",
  "wind_speed_500hPa", "wind_direction_500hPa",
  "wind_speed_600hPa", "wind_direction_600hPa",
  "wind_speed_700hPa", "wind_direction_700hPa",
  "cloud_cover", "cloud_cover_high", "cloud_cover_mid", "cloud_cover_low",
  // Air quality — served from a different corpus source, see EXTRA_SOURCE_VARS below.
  "us_aqi", "us_aqi_pm2_5", "us_aqi_ozone", "european_aqi", "european_aqi_pm2_5",
];

// Variables that live on a SECOND corpus source rather than DERIVE_SOURCE. Air quality was
// collected under `cams`, whose cells share the weather lattice cell-for-cell (same location, same
// window), so every AQ hour lines up with the same cell's weather hours and both can be counted in
// one pass. eachForecast routes each requested variable to the source that has it and merges the
// results into one HourlyData — the Open-Meteo names don't collide across the two APIs. A cell with
// no `cams` row just comes back without the AQ columns, and the AQ counter skips it.
export const EXTRA_SOURCE_VARS: Record<string, readonly string[]> = {
  cams: ["us_aqi", "us_aqi_pm2_5", "us_aqi_ozone", "european_aqi", "european_aqi_pm2_5"],
};
const EXTRA_SOURCE_VAR_SET = new Set(Object.values(EXTRA_SOURCE_VARS).flat());

// ── Wind quantization (must match v2.ts) ────────────────────────────────────────
// Every wind speed column quantizes to the extended Beaufort scale (forces 0..17): band lower
// bounds in km/h — the standard 13 forces plus the force 13..17 extension so hurricane-force
// gusts and jet winds don't clip (corpus maxima: gust 225, 500 hPa 293 kph). Chosen 2026-07-31:
// held-out sfc+gust 2.638 b/period vs 3.595 under linear 5 kph (analyze-wind-scale-heldout.ts);
// the scale spends resolution where wind differences are perceptible, which is also where the
// probability mass moves.
export const BEAUFORT_KPH_LOWER = [0, 1, 6, 12, 20, 29, 39, 50, 62, 75, 89, 103, 118, 134, 150, 167, 184, 202];
export const BEAUFORT_MAX = BEAUFORT_KPH_LOWER.length - 1; // 17
// Direction symbols are calm-gated at force ≤ 1 (< 6 kph) — the closest match to the old
// sub-one-step gate (< 5 kph), where direction is weather-model dither.
export const CALM_MAX_FORCE = 1;
export function quantWind(kph: number | undefined): number {
  const v = kph ?? 0;
  let f = 0;
  while (f < BEAUFORT_MAX && v >= BEAUFORT_KPH_LOWER[f + 1]) f++;
  return f;
}

// Tables a derive script contributes, keyed by their codebooks.gen.ts constant name.
export type DerivedTables = Record<string, number[] | number[][] | number[][][]>;

// ── Per-cell counting (shared by derive() and the class-clustering extractor) ────
//
// Each derive script factors its corpus counting into a CellCounter: a fixed flat "slot" space
// enumerating every (table row × symbol) its counted tables have, plus a per-cell counting
// function. derive() sums every train cell into one flat vector and assembles the shipped
// tables from it (identical results to the old inline loops); the codebook-class clustering
// (extract-cell-counts.ts / EM) keeps one sparse vector per cell instead, so table sets can be
// re-fit to any subset of cells without another corpus scan.

// One counted table: `dims` are its axes, the LAST dim being the symbol alphabet — so the table
// is a row-major sequence of rows of length dims.at(-1), each row one codebook's counts.
export interface CountedTable {
  name: string;
  dims: number[];
}

export const tableSlots = (t: CountedTable): number => t.dims.reduce((a, b) => a * b, 1);

// Slot offset of each counted table in the flat vector, in declaration order.
export function tableOffsets(tables: CountedTable[]): { offsets: Record<string, number>; nSlots: number } {
  const offsets: Record<string, number> = {};
  let n = 0;
  for (const t of tables) { offsets[t.name] = n; n += tableSlots(t); }
  return { offsets, nSlots: n };
}

export interface CellCounter {
  tables: CountedTable[];
  nSlots: number;
  // Adds this cell's symbol emissions (wire granularity — one add per symbol the encoder would
  // emit under these tables) into `add(slot)`.
  countCell(
    h: HourlyData, startHour: number, pos: { lat: number; lon: number } | undefined,
    add: (slot: number) => void,
  ): void;
  // Assembles the script's shipped weight tables from an accumulated count vector (applying the
  // same empty-row fallbacks the old inline derivation did).
  tablesFrom(counts: ArrayLike<number>): DerivedTables;
  // Per-slot model cost in bits under the tables tablesFrom would ship from `counts`, including
  // constant raw payloads (e.g. the temp escape field) — and 0 for slots whose wire cost is
  // carried by a parallel counted table (see the wind scripts' upper-conditioned tables).
  costBits(counts: ArrayLike<number>): Float64Array;
}

// Copies one row out of a flat count vector.
export function rowAt(counts: ArrayLike<number>, start: number, n: number): number[] {
  const r = new Array<number>(n);
  for (let i = 0; i < n; i++) r[i] = counts[start + i];
  return r;
}

// Model cost per symbol of the table scaledWeights(row) ships: -log2(w/Σw).
export function rowCostBits(weights: number[]): number[] {
  const total = weights.reduce((a, b) => a + b, 0);
  return weights.map((w) => -Math.log2(w / total));
}

// Sums every train-split cell's counts into one flat vector — the corpus-wide counts the old
// inline derive loops produced.
export async function deriveCounts(counter: CellCounter): Promise<Float64Array> {
  return (await deriveCountsMulti([counter]))[0];
}

// Same, for SEVERAL counters in one corpus scan — one loadCell + adjustPrecipPhase per cell
// instead of one per script. generate-codebooks.ts feeds every derive script's counter through
// this and hands each script its vector via derive(precounted); standalone runs still take the
// single-counter path above. Returns one count vector per counter, in order.
export async function deriveCountsMulti(counters: CellCounter[]): Promise<Float64Array[]> {
  const vecs = counters.map((c) => new Float64Array(c.nSlots));
  const adds = vecs.map((v) => (slot: number) => { v[slot]++; });
  await eachForecast((h, startHour, _loc, pos) => {
    for (let i = 0; i < counters.length; i++) counters[i].countCell(h, startHour, pos, adds[i]);
  });
  return vecs;
}

// Visits every train-split forecast in the corpus DB (WAL mode — safe alongside a concurrent
// collect). `loc` is the corpus location id — the unit held-out folds divide on. `pos` is the
// location's lat/lon from the registry mirror, for scripts that need geography (UTC offset,
// solar position). Cells are loaded with only the DERIVE_VARS series by default (see that
// list's caveat); pass `vars: null` for the full ~80-variable load.
export async function eachForecast(
  cb: (hourly: HourlyData, startHour: number, loc: string, pos?: { lat: number; lon: number },
       split?: string) => void,
  split: "train" | "all" = "train",
  vars: readonly string[] | null = DERIVE_VARS,
): Promise<void> {
  const db = openDb();
  const locs = dbLocations(db);
  // Site elevation for the precip-phase correction: the elevation the API downscaled the cell's
  // temperature to (grid-snap or pinned), same input production hands adjustPrecipPhase.
  const elevs = modelElevations(db, DERIVE_SOURCE);
  // Split the requested variables by which source carries them, once, outside the cell loop. A
  // source nobody asked for is never queried, so scripts that read no air quality pay nothing.
  const primaryVars = vars?.filter((v) => !EXTRA_SOURCE_VAR_SET.has(v)) ?? null;
  const extraLoads = Object.entries(EXTRA_SOURCE_VARS)
    .map(([source, srcVars]) => ({
      source,
      vars: vars ? srcVars.filter((v) => vars.includes(v)) : [...srcVars],
    }))
    .filter((e) => e.vars.length > 0);
  let cells = 0;
  const seen = new Set<string>();
  for (const { locationId, windowStart } of listCells(db, DERIVE_SOURCE)) {
    const loc = locs.get(locationId);
    if (!loc) continue;
    if (split === "train" && loc.split !== "train") continue; // eval/favorites: never trained on
    const raw = loadCell(db, DERIVE_SOURCE, locationId, windowStart, primaryVars);
    if (!raw) continue;
    for (const e of extraLoads) {
      const extra = loadCell(db, e.source, locationId, windowStart, e.vars);
      if (!extra) continue;
      for (const v of e.vars) if (extra[v]) raw[v] = extra[v];
    }
    const hourly = adjustPrecipPhase(raw, elevs.get(locationId) ?? loc.elev_m ?? null);
    cells++;
    seen.add(locationId);
    cb(hourly, Math.floor(Date.parse(windowStart + "Z") / 3600000), locationId,
      { lat: loc.lat, lon: loc.lon }, loc.split ?? undefined);
  }
  db.close();
  console.log(`  scanned ${cells} cells over ${seen.size} ${split === "train" ? "train " : ""}locations (${DERIVE_SOURCE})`);
}

// Deterministic 5-fold assignment by location id, for held-out (split-by-location) checks.
export const N_FOLDS = 5;
export function foldOf(loc: string): number {
  let h = 0;
  for (let i = 0; i < loc.length; i++) h = (h * 31 + loc.charCodeAt(i)) >>> 0;
  return h % N_FOLDS;
}

// Huffman code lengths per symbol via repeated merge of the two lowest-weight nodes (mirrors
// huffman.ts huffmanLengths), for the derive scripts' bit-cost estimates.
export function huffmanLengths(weights: number[]): number[] {
  const n = weights.length;
  interface Node { w: number; sym: number; left: number; right: number; }
  const nodes: Node[] = weights.map((w, i) => ({ w, sym: i, left: -1, right: -1 }));
  let alive = nodes.map((_, i) => i);
  while (alive.length > 1) {
    alive.sort((a, b) => nodes[a].w - nodes[b].w);
    const a = alive.shift()!, b = alive.shift()!;
    nodes.push({ w: nodes[a].w + nodes[b].w, sym: -1, left: a, right: b });
    alive.push(nodes.length - 1);
  }
  const lengths = new Array(n).fill(0);
  const walk = (i: number, depth: number) => {
    const nd = nodes[i];
    if (nd.sym >= 0) { lengths[nd.sym] = Math.max(depth, 1); return; }
    walk(nd.left, depth + 1); walk(nd.right, depth + 1);
  };
  walk(alive[0], 0);
  return lengths;
}

export const WEIGHT_SCALE = 1000;

// Counts → integer frequency weights: normalized to ~WEIGHT_SCALE total, every symbol ≥ 1 so any
// outlier stays representable. All-zero counts (a symbol never observed at all) become uniform.
export function scaledWeights(counts: number[]): number[] {
  const total = counts.reduce((a, b) => a + b, 0);
  if (total === 0) return counts.map(() => 1);
  return counts.map((c) => Math.max(1, Math.round((c / total) * WEIGHT_SCALE)));
}

// Renders one table as the `export const` declaration it gets in codebooks.gen.ts.
export function renderTable(name: string, t: number[] | number[][] | number[][][]): string {
  if (Array.isArray(t[0]) && Array.isArray((t[0] as number[][])[0])) {
    const outer = (t as number[][][]).map((m, i) =>
      `  [ // ${i}\n${m.map((r) => `    [${r.join(", ")}],`).join("\n")}\n  ],`).join("\n");
    return `export const ${name}: number[][][] = [\n${outer}\n];`;
  }
  if (Array.isArray(t[0]))
    return `export const ${name}: number[][] = [\n${(t as number[][]).map((r) => `  [${r.join(", ")}],`).join("\n")}\n];`;
  return `export const ${name}: number[] = [${(t as number[]).join(", ")}];`;
}

// Direct-run guard: `pnpm exec tsx scripts/derive-foo.ts` derives and prints that script's tables (stats
// go to the console from derive() itself) without touching codebooks.gen.ts.
export function runStandalone(moduleUrl: string, derive: () => Promise<DerivedTables>): void {
  if (process.argv[1] !== fileURLToPath(moduleUrl)) return;
  derive()
    .then((tables) => { for (const [name, t] of Object.entries(tables)) console.log(`\n${renderTable(name, t)}`); })
    .catch((e) => { console.error(e); process.exit(1); });
}
