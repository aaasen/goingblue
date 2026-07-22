/**
 * One-time import of the old raw-JSON corpus tree into the corpus SQLite DB — no fetching, so
 * the year of GFS already collected survives the storage change and the benchmark continuity
 * gate can compare like for like.
 *
 *   node packages/codec-server/scripts/import-corpus-json.ts [tree]   # default data/raw/gfs
 *
 * Old records are whole Historical Forecast API responses keyed (location, window); they become
 * one `series` row per hourly variable under source=gfs_seamless. Unit strings are the JSON
 * API's symbols ("°C") rather than the SDK's enum names ("celsius") — informational only, both
 * vocabularies coexist in the `unit` column. Keep the tree until the continuity gate passes
 * (`pnpm benchmark --report-only` matches the pre-migration report), then archive or delete it.
 */
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import {
  REPO_ROOT, WINDOW_HOURS, mirrorLocations, openDb, upsertLocationMeta, upsertSeries,
  type SeriesRow,
} from "./corpus-db.ts";
import { LOCATIONS } from "./locations.ts";

const TREE = process.argv[2] ?? join(REPO_ROOT, "data", "raw", "gfs");
const SOURCE = "gfs_seamless";

async function main(): Promise<void> {
  const db = openDb();
  mirrorLocations(db);
  const registryIds = new Set(LOCATIONS.map((l) => l.id));

  let cells = 0, rows = 0, skipped = 0;
  const unknownLocs: string[] = [];
  for (const loc of await readdir(TREE)) {
    const dir = join(TREE, loc);
    if (!registryIds.has(loc)) unknownLocs.push(loc); // imported anyway; the report skips them
    for (const f of await readdir(dir)) {
      if (!f.endsWith(".json")) continue;
      let rec: any;
      try {
        rec = JSON.parse(await readFile(join(dir, f), "utf8"));
      } catch {
        skipped++; // half-written leftover
        continue;
      }
      const windowStart: string | undefined = rec?.meta?.run;
      const hourly = rec?.response?.hourly;
      if (!windowStart || !hourly?.time || hourly.time.length < WINDOW_HOURS) { skipped++; continue; }
      if (hourly.time[0] !== windowStart) {
        throw new Error(`${loc}/${f}: time axis starts ${hourly.time[0]}, expected ${windowStart}`);
      }
      const fetchedAt: string = rec.meta.fetched_at ?? "unknown";
      const batch: SeriesRow[] = Object.entries(hourly)
        .filter(([name]) => name !== "time")
        .map(([variable, values]) => ({
          source: SOURCE, locationId: loc, windowStart, variable,
          values: (values as (number | null)[]).slice(0, WINDOW_HOURS),
          unit: rec.response.hourly_units?.[variable] ?? null,
          fetchedAt,
        }));
      upsertSeries(db, batch);
      upsertLocationMeta(db, SOURCE, loc,
        rec.response.latitude, rec.response.longitude, rec.response.elevation ?? 0);
      cells++;
      rows += batch.length;
    }
  }

  console.log(`imported ${cells} cells (${rows} series rows) from ${TREE.replace(REPO_ROOT + "/", "")}${skipped ? `, skipped ${skipped}` : ""}`);
  if (unknownLocs.length) {
    console.log(`note: ${unknownLocs.length} location dir(s) not in the registry (imported, but the report ignores them): ${unknownLocs.join(", ")}`);
  }
  db.close();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
