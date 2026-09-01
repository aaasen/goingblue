/**
 * Derive the model-agreement codebooks: AGREEMENT_WEIGHTS_BY_LEAD[leadBucket][prevRow][sym],
 * prevRow 0 = bootstrap, 1.. = previous symbol + 1 (see agreementBook in the protocol's
 * entropy.ts).
 *
 * Unlike every other derive script this does NOT train on the historical corpus: the
 * historical-forecast API stitches short-lead runs, so its inter-model deltas carry no
 * lead-time decay — the very structure the lead axis exists to price. Training reads the
 * `live_series` snapshots instead (scripts/collect-live-agreement.ts; each snapshot is a real
 * multi-model init at full horizon), pooling best_match-vs-center pairs across every snapshot.
 * The set is small for now and grows as snapshots accumulate; retrain then.
 *
 * The corpus-scan CellCounter is a no-op — the shared scan never sees these tables — but the
 * script still rides `pnpm generate` so the tables land in codebooks.gen.ts with the rest.
 */
import { DatabaseSync } from "node:sqlite";
import {
  AGREEMENT_CENTERS, AGREEMENT_LEAD_BUCKETS, agreementLeadBucket, agreementPeriodCount,
  AGREEMENT_NSYM, AGREEMENT_NO_DATA,
} from "@weather/protocol";
import { rowsFromWindows, type HourlyData, type Row } from "../src/forecast.ts";
import { computeAgreementLevels } from "../src/agreement.ts";
import { DB_PATH } from "./corpus-db.ts";
import { runStandalone, type CellCounter, type DerivedTables } from "./derive-lib.ts";

// The served side of every training pair: production's default center.
const SERVED_SOURCE = "best_match";
const CENTER_SOURCES = ["gfs_seamless", "gem_seamless", "ecmwf_ifs"]; // AGREEMENT_CENTERS order
const VARS = [
  "temperature_2m", "wind_speed_10m", "wind_direction_10m",
  "rain", "showers", "snowfall", "cloud_cover",
];

// Training period ladder, an Auto-like staircase over the snapshot's 16-day horizon: the
// tables key on the lead bucket, not the resolution, so the ladder only sets how many symbols
// each bucket contributes.
const LADDER_HOURS: number[] = [
  ...Array<number>(16).fill(3),   // days 0-1
  ...Array<number>(8).fill(6),    // days 2-3
  ...Array<number>(24).fill(12),  // days 4-15
];
const NPREV = AGREEMENT_NSYM + 1; // bootstrap row + one per previous symbol

export function counter(): CellCounter {
  return {
    tables: [],
    nSlots: 1,
    countCell() {},
    tablesFrom: () => ({}),
    costBits: () => new Float64Array(1),
  };
}

interface SeriesKey { location_id: string; window_start: string }

function loadHourly(
  db: DatabaseSync, source: string, key: SeriesKey,
): { h: HourlyData; times: string[] } | null {
  const rows = db.prepare(
    "SELECT variable, values_json FROM live_series WHERE source = ? AND location_id = ? AND window_start = ?",
  ).all(source, key.location_id, key.window_start) as unknown as
    { variable: string; values_json: string }[];
  const byVar = new Map(rows.map((r) => [r.variable, JSON.parse(r.values_json) as (number | null)[]]));
  if (VARS.some((v) => !byVar.has(v))) return null;
  const n = byVar.get("temperature_2m")!.length;
  const startMs = Date.parse(`${key.window_start}:00Z`);
  const times = Array.from({ length: n }, (_, i) =>
    new Date(startMs + i * 3600_000).toISOString().slice(0, 16));
  const h: Record<string, unknown> = { time: times };
  for (const v of VARS) h[v] = byVar.get(v);
  return { h: h as unknown as HourlyData, times };
}

function ladderRows(hourly: { h: HourlyData; times: string[] }): Row[] {
  let start = 0;
  const windows = LADDER_HOURS.map((hours) => {
    const idx = Array.from({ length: hours }, (_, i) => start + i);
    start += hours;
    return idx.filter((i) => i < hourly.times.length);
  });
  return rowsFromWindows(hourly.h, hourly.times, windows, 0);
}

export async function derive(_counts: Float64Array): Promise<DerivedTables> {
  const db = new DatabaseSync(DB_PATH, { readOnly: true });
  const hasTable = db.prepare(
    "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'live_series'",
  ).all().length > 0;
  if (!hasTable) throw new Error(
    "no live_series table in the corpus DB — run scripts/collect-live-agreement.ts first");

  const keys = db.prepare(
    "SELECT DISTINCT location_id, window_start FROM live_series WHERE source = ? ORDER BY location_id, window_start",
  ).all(SERVED_SOURCE) as unknown as SeriesKey[];

  const counts = Array.from({ length: AGREEMENT_LEAD_BUCKETS }, () =>
    Array.from({ length: NPREV }, () => new Array<number>(AGREEMENT_NSYM).fill(0)));
  const starts: number[] = [];
  {
    let s = 0;
    for (const hours of LADDER_HOURS) { starts.push(s); s += hours; }
  }

  let nSeries = 0;
  let nSyms = 0;
  for (const key of keys) {
    const served = loadHourly(db, SERVED_SOURCE, key);
    if (!served) continue;
    const servedRows = ladderRows(served);
    for (let ci = 0; ci < CENTER_SOURCES.length; ci++) {
      const center = loadHourly(db, CENTER_SOURCES[ci], key);
      if (!center) continue;
      const levels = computeAgreementLevels(servedRows, ladderRows(center), LADDER_HOURS);
      const nAg = agreementPeriodCount(LADDER_HOURS, AGREEMENT_CENTERS[ci].horizonHours);
      let prev: number | null = null;
      for (let p = 0; p < nAg; p++) {
        const sym = levels[p] ?? AGREEMENT_NO_DATA;
        counts[agreementLeadBucket(starts[p])][prev === null ? 0 : prev + 1][sym]++;
        prev = sym;
        nSyms++;
      }
      nSeries++;
    }
  }
  db.close();
  if (nSeries === 0) throw new Error("live_series held no complete served/center pairs");

  // Add-one smoothing: every row a decoder can key must give every symbol nonzero mass.
  const table = counts.map((rows) => rows.map((r) => r.map((c) => c + 1)));

  console.log(`agreement: ${nSeries} pair series, ${nSyms} symbols from ${keys.length} snapshot cells`);
  for (let b = 0; b < AGREEMENT_LEAD_BUCKETS; b++) {
    const tot = counts[b].flat().reduce((a, v) => a + v, 0);
    const bySym = Array.from({ length: AGREEMENT_NSYM }, (_, s) =>
      counts[b].reduce((a, r) => a + r[s], 0));
    const share = bySym.map((v) => (tot ? `${((100 * v) / tot).toFixed(0)}%` : "-"));
    console.log(`  lead bucket ${b}: ${tot} syms, levels 0..3+nodata = ${share.join(" ")}`);
  }

  return { AGREEMENT_WEIGHTS_BY_LEAD: table };
}

runStandalone(import.meta.url, () => derive(new Float64Array(1)));
