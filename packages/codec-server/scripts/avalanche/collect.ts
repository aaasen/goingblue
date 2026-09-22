/**
 * Avalanche Canada bulletin archive collector.
 *
 * Walks a date range one day at a time and stores every product the public forecast API
 * reports as current at WALK_HOUR UTC. All centers on the platform issue the next day's
 * bulletin in the local afternoon, which lands between 20:00Z and 00:00Z depending on center
 * and daylight saving, so 19:00Z sees the complete set for the day plus any morning updates
 * issued before it. The archive holds the 2022-23 season onward.
 *
 * Raw product JSON is stored verbatim in data/avalanche.db (schema in db.ts), keyed by product
 * id, and never rewritten. `walks` records each day fetched so a rerun resumes where it stopped, and
 * `walk_products` records which products were current on each walk date. Derivation into
 * fields and prose happens in a separate script.
 *
 * Usage: pnpm avalanche-collect [--from YYYY-MM-DD] [--to YYYY-MM-DD] [--all-months] [--refetch]
 *   Defaults: 2022-11-01 through today, June through October skipped.
 */
import { openDb } from "./db.ts";

const API = "https://avcan-services-api.prod.avalanche.ca/forecasts";
const LANG = "en";
const WALK_HOUR = 19;
const DEFAULT_FROM = "2022-11-01";
const OFF_SEASON_MONTHS = new Set([6, 7, 8, 9, 10]);
const REQUEST_TIMEOUT_MS = 90_000;
const RETRIES = 4;
const DELAY_MS = 500;

interface Product {
  id: string;
  type: string;
  area: { id: string };
  owner: { value: string };
  report: {
    title: string;
    dateIssued: string;
    validUntil: string;
    timezone?: string | null;
  };
}

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i === -1 ? undefined : process.argv[i + 1];
}

function isoDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

function* walkDates(from: string, to: string, allMonths: boolean): Generator<string> {
  const d = new Date(`${from}T00:00:00Z`);
  const end = new Date(`${to}T00:00:00Z`);
  for (; d <= end; d.setUTCDate(d.getUTCDate() + 1)) {
    if (!allMonths && OFF_SEASON_MONTHS.has(d.getUTCMonth() + 1)) continue;
    yield isoDate(d);
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function fetchDay(date: string): Promise<Product[]> {
  const url = `${API}/${LANG}/products?date=${date}T${String(WALK_HOUR).padStart(2, "0")}:00:00.000Z`;
  let lastErr: unknown;
  for (let attempt = 1; attempt <= RETRIES; attempt++) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const body = (await res.json()) as unknown;
      if (!Array.isArray(body)) throw new Error("response is not an array");
      return body as Product[];
    } catch (err) {
      lastErr = err;
      const wait = 2000 * 2 ** (attempt - 1);
      console.warn(`  ${date}: attempt ${attempt} failed (${(err as Error).message}); retrying in ${wait} ms`);
      await sleep(wait);
    }
  }
  throw lastErr;
}

async function main(): Promise<void> {
  const from = arg("--from") ?? DEFAULT_FROM;
  const to = arg("--to") ?? isoDate(new Date());
  const allMonths = process.argv.includes("--all-months");
  const refetch = process.argv.includes("--refetch");

  const db = openDb();
  const walked = new Set(
    (db.prepare("SELECT walk_date FROM walks").all() as { walk_date: string }[]).map((r) => r.walk_date),
  );
  const insertProduct = db.prepare(
    `INSERT OR IGNORE INTO products
       (id, type, owner, area_id, title, date_issued, valid_until, timezone, first_seen, json)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  const insertWalk = db.prepare(
    `INSERT OR REPLACE INTO walks (walk_date, fetched_at, product_count) VALUES (?, ?, ?)`,
  );
  const insertWalkProduct = db.prepare(
    `INSERT OR IGNORE INTO walk_products (walk_date, product_id) VALUES (?, ?)`,
  );

  const dates = [...walkDates(from, to, allMonths)].filter((d) => refetch || !walked.has(d));
  console.log(`${dates.length} days to fetch (${from} to ${to}, ${allMonths ? "all months" : "winter months"})`);

  let totalNew = 0;
  for (const [i, date] of dates.entries()) {
    const t0 = Date.now();
    const products = await fetchDay(date);
    let added = 0;
    db.exec("BEGIN");
    try {
      for (const p of products) {
        const r = p.report;
        const { changes } = insertProduct.run(
          p.id, p.type, p.owner.value, p.area.id, r.title, r.dateIssued, r.validUntil,
          r.timezone ?? null, date, JSON.stringify(p),
        );
        added += Number(changes);
        insertWalkProduct.run(date, p.id);
      }
      insertWalk.run(date, new Date().toISOString(), products.length);
      db.exec("COMMIT");
    } catch (err) {
      db.exec("ROLLBACK");
      throw err;
    }
    totalNew += added;
    console.log(
      `[${i + 1}/${dates.length}] ${date}: ${products.length} products, ${added} new (${Date.now() - t0} ms)`,
    );
    await sleep(DELAY_MS);
  }

  const total = (db.prepare("SELECT COUNT(*) AS n FROM products").get() as { n: number }).n;
  console.log(`done: ${totalNew} new products this run, ${total} total`);
  db.close();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
