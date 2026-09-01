/**
 * Live-forecast snapshot collector for the model-agreement design.
 *
 * Pulls CURRENT forecasts (standard forecast API, full 16-day horizon) for the multi-model
 * location slice, one row per (source, location, variable), into `live_series` — a table
 * separate from `series` so codebook training never sees it. Unlike the historical-forecast
 * corpus (which stitches short-lead runs and so carries no lead-time signal), each snapshot
 * here is a single init: hour index IS forecast lead. Re-run on later days to accumulate
 * snapshots; window_start (today 00:00 UTC) keys each one.
 *
 * Always hits the free host with no API key: this is a ~700-call pull, well under the free
 * daily limit, and must not draw down the commercial quota.
 */
import { fetchWeatherApi } from "openmeteo";
import { Unit } from "@openmeteo/sdk/unit.js";
import type { VariableWithValues } from "@openmeteo/sdk/variable-with-values.js";
import { openDb } from "./corpus-db.ts";
import { canonicalName, ApiError } from "./om-fetch.ts";

const ENDPOINT = "https://api.open-meteo.com/v1/forecast";
const FORECAST_DAYS = 16;
const HOURS = FORECAST_DAYS * 24;
const CONCURRENCY = 6;

// ecmwf_ifs (9 km HRES) may be customer-only; ecmwf_ifs025 is the free-tier EU model.
// Per-source failures are reported and skipped, not fatal.
const ALL_SOURCES = [
  "best_match", "gfs_seamless", "gem_seamless", "ecmwf_ifs", "ecmwf_ifs025", "icon_seamless",
];
// --source <id> restricts a run to one model, e.g. to backfill a newly added source into an
// existing snapshot without refetching (and mixing init times into) the others.
const sourceArg = process.argv.indexOf("--source");
const SOURCES = sourceArg === -1 ? ALL_SOURCES : [process.argv[sourceArg + 1]];
const VARIABLES = [
  "temperature_2m", "wind_speed_10m", "wind_gusts_10m", "rain", "showers", "snowfall",
  "wind_direction_10m", "weather_code", "cloud_cover",
];

const round2 = (x: number) => Math.round(x * 100) / 100;

interface Cell { source: string; loc: { id: string; lat: number; lon: number; elev_m: number | null } }

async function fetchCell(cell: Cell): Promise<{
  windowStart: string;
  series: Map<string, { values: (number | null)[]; unit: string | null }>;
}> {
  const params: Record<string, unknown> = {
    latitude: cell.loc.lat,
    longitude: cell.loc.lon,
    forecast_days: FORECAST_DAYS,
    hourly: VARIABLES,
    models: cell.source,
  };
  if (cell.loc.elev_m != null) params.elevation = cell.loc.elev_m;

  let results;
  try {
    results = await fetchWeatherApi(ENDPOINT, params);
  } catch (err) {
    const msg = (err as Error).message ?? String(err);
    throw /limit exceeded|too many/i.test(msg) ? new ApiError(msg, 429) : err;
  }
  const hourly = results[0]?.hourly();
  if (!hourly) throw new Error("response has no hourly block");
  if (hourly.interval() !== 3600) throw new Error(`interval ${hourly.interval()} != 3600`);
  const startMs = Number(hourly.time()) * 1000;
  const windowStart = new Date(startMs).toISOString().slice(0, 16);

  const decoded = new Map<string, VariableWithValues>();
  for (let i = 0; i < hourly.variablesLength(); i++) {
    const v = hourly.variables(i);
    if (v) decoded.set(canonicalName(v), v);
  }
  const series = new Map<string, { values: (number | null)[]; unit: string | null }>();
  for (const name of VARIABLES) {
    const v = decoded.get(name);
    const raw = v?.valuesArray() ?? null;
    const values: (number | null)[] = Array.from({ length: HOURS }, (_, i) => {
      const x = raw?.[i];
      return x == null || Number.isNaN(x) ? null : round2(x);
    });
    series.set(name, { values, unit: v ? Unit[v.unit()] ?? null : null });
  }
  return { windowStart, series };
}

async function main(): Promise<void> {
  const db = openDb();
  db.exec(`
    CREATE TABLE IF NOT EXISTS live_series (
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
  `);

  // The multi-model slice: every location the per-center corpus sources cover.
  const locs = db.prepare(`
    SELECT l.id, l.lat, l.lon, l.elev_m
    FROM locations l
    WHERE l.id IN (SELECT DISTINCT location_id FROM series WHERE source = 'gfs_seamless')
    ORDER BY l.id
  `).all() as unknown as { id: string; lat: number; lon: number; elev_m: number | null }[];
  if (locs.length === 0) throw new Error("no multi-model locations found in corpus.db");

  const cells: Cell[] = SOURCES.flatMap((source) => locs.map((loc) => ({ source, loc })));
  console.log(`${locs.length} locations x ${SOURCES.length} sources = ${cells.length} calls (free host)`);

  const insert = db.prepare(`
    INSERT OR REPLACE INTO live_series
      (source, location_id, window_start, variable, values_json, unit, fetched_at, null_count)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `);

  const failures = new Map<string, number>();
  let done = 0;
  let queue = 0;
  const fetchedAt = new Date().toISOString();

  async function worker(): Promise<void> {
    while (queue < cells.length) {
      const cell = cells[queue++];
      for (let attempt = 0; ; attempt++) {
        try {
          const { windowStart, series } = await fetchCell(cell);
          for (const [variable, s] of series) {
            const nullCount = s.values.filter((v) => v == null).length;
            insert.run(cell.source, cell.loc.id, windowStart, variable,
              JSON.stringify(s.values), s.unit, fetchedAt, nullCount);
          }
          break;
        } catch (err) {
          if (err instanceof ApiError && err.status === 429 && attempt < 5) {
            await new Promise((r) => setTimeout(r, 15_000 * (attempt + 1)));
            continue;
          }
          failures.set(cell.source, (failures.get(cell.source) ?? 0) + 1);
          if ((failures.get(cell.source) ?? 0) <= 2) {
            console.error(`  ${cell.source}/${cell.loc.id}: ${(err as Error).message}`);
          }
          break;
        }
      }
      done++;
      if (done % 100 === 0) console.log(`  ${done}/${cells.length}`);
    }
  }

  await Promise.all(Array.from({ length: CONCURRENCY }, worker));

  console.log(`done: ${done} cells`);
  for (const [source, n] of failures) console.log(`  FAILED ${source}: ${n} locations`);
  const rows = db.prepare(
    "SELECT source, COUNT(*) AS n, SUM(null_count) AS nulls FROM live_series WHERE fetched_at = ? GROUP BY source",
  ).all(fetchedAt) as unknown as { source: string; n: number; nulls: number }[];
  for (const r of rows) console.log(`  ${r.source}: ${r.n} series rows, ${r.nulls} null hours`);
}

main().catch((err) => { console.error(err); process.exit(1); });
