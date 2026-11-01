/**
 * Avalanche bulletin archive collector, for Avalanche Canada by default and avalanche.org centers
 * with --source.
 *
 * Avalanche Canada: walks a date range one day at a time and stores every product the public forecast API
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
 * avalanche.org: lists every product in the range, then fetches each one by id, because the listing
 * leaves out the prose. Response bodies are stored as received, stubs included. A rerun fetches only
 * products whose listed updated_at is new, and keeps the earlier versions. Sends no Origin header.
 *
 * Usage: pnpm avalanche-collect [--from YYYY-MM-DD] [--to YYYY-MM-DD] [--all-months] [--refetch]
 *   Defaults: 2022-11-01 through today, June through October skipped.
 *        pnpm avalanche-collect --source nwac [--from YYYY-MM-DD] [--to YYYY-MM-DD]
 *   Defaults: 2018-01-01 through today, all months.
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

const NAC_API = "https://api.avalanche.org/v2/public";
const NAC_CENTERS: Record<string, string> = { nwac: "NWAC" };
const NAC_DEFAULT_FROM = "2018-01-01";
const NAC_DELAY_MS = 250;

interface NacListing {
  id: number;
  product_type: string;
  published_time: string;
  updated_at: string | null;
}

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

async function withRetries<T>(label: string, attemptFetch: () => Promise<T>): Promise<T> {
  let lastErr: unknown;
  for (let attempt = 1; attempt <= RETRIES; attempt++) {
    try {
      return await attemptFetch();
    } catch (err) {
      lastErr = err;
      const wait = 2000 * 2 ** (attempt - 1);
      console.warn(`  ${label}: attempt ${attempt} failed (${(err as Error).message}); retrying in ${wait} ms`);
      await sleep(wait);
    }
  }
  throw lastErr;
}

async function fetchDay(date: string): Promise<Product[]> {
  const url = `${API}/${LANG}/products?date=${date}T${String(WALK_HOUR).padStart(2, "0")}:00:00.000Z`;
  return withRetries(date, async () => {
    const res = await fetch(url, { signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const body = (await res.json()) as unknown;
    if (!Array.isArray(body)) throw new Error("response is not an array");
    return body as Product[];
  });
}

// Fatal decoding with the BOM kept, so the stored text is the body's exact UTF-8.
async function fetchExact(url: string, isValid: (body: unknown) => boolean): Promise<string> {
  return withRetries(url, async () => {
    const res = await fetch(url, { signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(await res.arrayBuffer());
    if (!isValid(JSON.parse(text))) throw new Error("unexpected response shape");
    return text;
  });
}

async function collectNac(center: string): Promise<void> {
  const from = arg("--from") ?? NAC_DEFAULT_FROM;
  const to = arg("--to") ?? isoDate(new Date());

  const db = openDb();
  const insertResponse = db.prepare(
    `INSERT INTO nac_responses (url, center, fetched_at, body) VALUES (?, ?, ?, ?)`,
  );
  const insertProduct = db.prepare(
    `INSERT INTO nac_products (id, updated_at, center, product_type, published_time, fetched_at, body)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  );
  const saveResponse = async (url: string, isValid: (body: unknown) => boolean): Promise<string> => {
    const body = await fetchExact(url, isValid);
    insertResponse.run(url, center, new Date().toISOString(), body);
    return body;
  };

  const isObject = (b: unknown) => typeof b === "object" && b !== null;
  await saveResponse(`${NAC_API}/avalanche-center/${center}`, isObject);
  await saveResponse(`${NAC_API}/products/map-layer/${center}`, isObject);
  // date_end is exclusive.
  const end = new Date(`${to}T00:00:00Z`);
  end.setUTCDate(end.getUTCDate() + 1);
  const listing = JSON.parse(
    await saveResponse(
      `${NAC_API}/products?avalanche_center_id=${center}&date_start=${from}&date_end=${isoDate(end)}`,
      Array.isArray,
    ),
  ) as NacListing[];

  const stored = new Set(
    (db.prepare("SELECT id, updated_at FROM nac_products WHERE center = ?").all(center) as {
      id: number;
      updated_at: string;
    }[]).map((r) => `${r.id}|${r.updated_at}`),
  );
  const missing = listing
    .filter((p) => !stored.has(`${p.id}|${p.updated_at ?? ""}`))
    .sort((a, b) => a.published_time.localeCompare(b.published_time));
  console.log(`${center}: ${listing.length} products listed (${from} to ${to}), ${missing.length} to fetch`);

  let failed = 0;
  for (const [i, p] of missing.entries()) {
    try {
      const body = await fetchExact(`${NAC_API}/product/${p.id}`, (b) => (b as { id?: number } | null)?.id === p.id);
      insertProduct.run(
        p.id, p.updated_at ?? "", center, p.product_type, p.published_time, new Date().toISOString(), body,
      );
    } catch (err) {
      failed++;
      console.error(`  product ${p.id}: gave up (${(err as Error).message})`);
    }
    if ((i + 1) % 100 === 0 || i + 1 === missing.length) {
      console.log(`[${i + 1}/${missing.length}] through ${p.published_time}, ${failed} failed`);
    }
    await sleep(NAC_DELAY_MS);
  }

  const total = (db.prepare("SELECT COUNT(*) AS n FROM nac_products WHERE center = ?").get(center) as { n: number }).n;
  console.log(`done: ${missing.length - failed} fetched this run, ${failed} failed, ${total} stored for ${center}`);
  db.close();
  if (failed > 0) process.exitCode = 1;
}

async function main(): Promise<void> {
  const source = arg("--source");
  if (source !== undefined) {
    const center = NAC_CENTERS[source];
    if (!center) throw new Error(`unknown --source ${source}; expected ${Object.keys(NAC_CENTERS).join(", ")}`);
    return collectNac(center);
  }

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
