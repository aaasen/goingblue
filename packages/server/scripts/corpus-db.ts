/**
 * The local weather database backing the benchmark corpus: SQLite (node:sqlite, no dependency)
 * at data/corpus.db. One `series` row per (source, location, window, variable), values as a JSON
 * array so ad-hoc SQL can reach individual hours via json_each. Variables, sources, and
 * locations are all addable incrementally — the collector fetches only missing rows — which is
 * the reason this replaced the raw-response JSON tree (call weight is linear in variable count,
 * so speculative over-pull multiplies corpus cost; and the FlatBuffers SDK decodes responses
 * anyway, so there is no "raw response" left to store).
 *
 * The window grid is fixed: HORIZON_DAYS of hourly UTC data anchored at window_start, so the
 * time axis is derived, never stored. Writers must assert their data is on this grid.
 */
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import type { HourlyData } from "../src/forecast.ts";
import { LOCATIONS, type Location } from "./locations.ts";
import { HORIZON_DAYS, WINDOW_HOURS } from "./lattice.ts";

export { HORIZON_DAYS, WINDOW_HOURS };

const __dirname = dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = join(__dirname, "..", "..", "..");
export const DB_PATH = join(REPO_ROOT, "data", "corpus.db");

// Window geometry lives in lattice.ts (shared with the sampler) and is re-exported above.

export interface SeriesRow {
  source: string;        // logical source id (= Open-Meteo model param), e.g. gfs_seamless
  locationId: string;
  windowStart: string;   // ISO minutes UTC, e.g. 2025-07-15T00:00 — the window anchor
  variable: string;      // canonical Open-Meteo name, e.g. wind_speed_700hPa
  values: (number | null)[]; // exactly WINDOW_HOURS entries
  unit: string | null;
  fetchedAt: string;
}

export function openDb(path: string = DB_PATH): DatabaseSync {
  mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec(`
    PRAGMA journal_mode = WAL;
    CREATE TABLE IF NOT EXISTS series (
      source        TEXT NOT NULL,
      location_id   TEXT NOT NULL,
      window_start  TEXT NOT NULL,
      variable      TEXT NOT NULL,
      values_json   TEXT NOT NULL,
      unit          TEXT,
      fetched_at    TEXT NOT NULL,
      null_count    INTEGER NOT NULL,
      PRIMARY KEY (source, location_id, window_start, variable)
    );
    CREATE TABLE IF NOT EXISTS locations (
      id TEXT PRIMARY KEY, name TEXT, lat REAL, lon REAL, elev_m REAL,
      stratum TEXT, koppen TEXT, split TEXT
    );
    CREATE TABLE IF NOT EXISTS location_meta (
      source TEXT NOT NULL, location_id TEXT NOT NULL,
      resolved_lat REAL, resolved_lon REAL, model_elevation REAL,
      PRIMARY KEY (source, location_id)
    );
  `);
  return db;
}

// Refresh the registry mirror so the DB is self-contained for ad-hoc SQL (joins on location_id).
// The committed registry (locations.ts) stays the source of truth.
export function mirrorLocations(db: DatabaseSync, locations: Location[] = LOCATIONS): void {
  const stmt = db.prepare(
    `INSERT INTO locations (id, name, lat, lon, elev_m, stratum, koppen, split)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET name=excluded.name, lat=excluded.lat, lon=excluded.lon,
       elev_m=excluded.elev_m, stratum=excluded.stratum, koppen=excluded.koppen, split=excluded.split`,
  );
  db.exec("BEGIN");
  try {
    for (const l of locations) {
      stmt.run(l.id, l.name, l.lat, l.lon, l.elev_m ?? null, l.stratum, l.koppen ?? null, l.split ?? null);
    }
    db.exec("COMMIT");
  } catch (e) {
    db.exec("ROLLBACK");
    throw e;
  }
}

export function upsertSeries(db: DatabaseSync, rows: SeriesRow[]): void {
  const stmt = db.prepare(
    `INSERT OR REPLACE INTO series
       (source, location_id, window_start, variable, values_json, unit, fetched_at, null_count)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  db.exec("BEGIN");
  try {
    for (const r of rows) {
      if (r.values.length !== WINDOW_HOURS) {
        throw new Error(`series ${r.source}/${r.locationId}/${r.windowStart}/${r.variable}: ${r.values.length} values, expected ${WINDOW_HOURS}`);
      }
      const nulls = r.values.reduce((n, v) => n + (v == null ? 1 : 0), 0);
      stmt.run(r.source, r.locationId, r.windowStart, r.variable,
        JSON.stringify(r.values), r.unit, r.fetchedAt, nulls);
    }
    db.exec("COMMIT");
  } catch (e) {
    db.exec("ROLLBACK");
    throw e;
  }
}

// Grid snap: the coordinates and elevation Open-Meteo resolved the requested point to, which
// differ per source (model grids differ). The registry can't know these; responses do.
export function upsertLocationMeta(
  db: DatabaseSync, source: string, locationId: string,
  resolvedLat: number, resolvedLon: number, modelElevation: number,
): void {
  db.prepare(
    `INSERT OR REPLACE INTO location_meta (source, location_id, resolved_lat, resolved_lon, model_elevation)
     VALUES (?, ?, ?, ?, ?)`,
  ).run(source, locationId, resolvedLat, resolvedLon, modelElevation);
}

// Which variables each (location, window) cell already has for a source — the fetch planner
// diffs this against the wanted set and fetches only what's missing, batched per cell.
export function presentVars(db: DatabaseSync, source: string): Map<string, Set<string>> {
  const rows = db.prepare(
    `SELECT location_id, window_start, group_concat(variable) AS vars
     FROM series WHERE source = ? GROUP BY location_id, window_start`,
  ).all(source) as { location_id: string; window_start: string; vars: string }[];
  return new Map(rows.map((r) => [cellKey(r.location_id, r.window_start), new Set(r.vars.split(","))]));
}

export const cellKey = (locationId: string, windowStart: string) => `${locationId}|${windowStart}`;

export function listCells(db: DatabaseSync, source: string, locationId?: string): { locationId: string; windowStart: string }[] {
  const rows = (locationId
    ? db.prepare(`SELECT DISTINCT location_id, window_start FROM series WHERE source = ? AND location_id = ? ORDER BY location_id, window_start`).all(source, locationId)
    : db.prepare(`SELECT DISTINCT location_id, window_start FROM series WHERE source = ? ORDER BY location_id, window_start`).all(source)
  ) as { location_id: string; window_start: string }[];
  return rows.map((r) => ({ locationId: r.location_id, windowStart: r.window_start }));
}

// The derived hourly time axis for a window, in the API's ISO-minutes format the encode path
// already parses (e.g. "2025-07-15T13:00").
export function windowTimes(windowStart: string): string[] {
  const start = Date.parse(windowStart + ":00Z");
  return Array.from({ length: WINDOW_HOURS }, (_, i) =>
    new Date(start + i * 3600_000).toISOString().slice(0, 16));
}

// Reassemble one cell into the HourlyData shape the production encode path consumes
// (aggregateHourly/toFullPeriod key it by canonical variable names). Null if the cell is empty.
export function loadCell(db: DatabaseSync, source: string, locationId: string, windowStart: string): HourlyData | null {
  const rows = db.prepare(
    `SELECT variable, values_json FROM series WHERE source = ? AND location_id = ? AND window_start = ?`,
  ).all(source, locationId, windowStart) as { variable: string; values_json: string }[];
  if (rows.length === 0) return null;
  const h: Record<string, unknown> = { time: windowTimes(windowStart) };
  for (const r of rows) h[r.variable] = JSON.parse(r.values_json);
  return h as unknown as HourlyData;
}

export interface LocationRow {
  id: string; name: string; lat: number; lon: number; elev_m: number | null;
  stratum: string; koppen: string | null; split: string | null;
}

export function dbLocations(db: DatabaseSync): Map<string, LocationRow> {
  const rows = db.prepare(`SELECT id, name, lat, lon, elev_m, stratum, koppen, split FROM locations`).all() as unknown as LocationRow[];
  return new Map(rows.map((r) => [r.id, r]));
}

// model_elevation per (source, location) — the report's elevation input (the old JSON tree took
// it from response.elevation). Missing rows fall back to 0 at the call site, as before.
export function modelElevations(db: DatabaseSync, source: string): Map<string, number> {
  const rows = db.prepare(
    `SELECT location_id, model_elevation FROM location_meta WHERE source = ?`,
  ).all(source) as { location_id: string; model_elevation: number | null }[];
  return new Map(rows.filter((r) => r.model_elevation != null).map((r) => [r.location_id, r.model_elevation!]));
}
