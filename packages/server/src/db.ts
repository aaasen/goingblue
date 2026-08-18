import pg from "pg";
import { log } from "./log.js";

// Postgres access for the accounts/requests store. The pool is created lazily on first
// use so that importing this module (e.g. from tests) never opens a connection; tests that
// don't exercise the DB therefore need no Postgres running.
//
// Connection config comes entirely from the environment:
//   - Cloud Run: set INSTANCE_CONNECTION_NAME (project:region:instance) and attach the
//     instance with `gcloud run deploy --add-cloudsql-instances`. The driver then talks to
//     the Cloud SQL Auth Proxy over the Unix socket at /cloudsql/<INSTANCE_CONNECTION_NAME>.
//   - Local dev: set DB_HOST (default 127.0.0.1) / DB_PORT, e.g. a docker postgres or the
//     `cloud-sql-proxy` running on localhost.
// In both cases set DB_USER, DB_PASS, DB_NAME.
let pool: pg.Pool | null = null;

// The zone every "day" in this system is bounded by — the shape table's date column and the
// stats dashboard's daily buckets. Pacific, not UTC: an evening request should count on the
// evening it happened, and UTC would push everything after 5pm into tomorrow. A named zone
// rather than a fixed offset is what makes the boundary follow DST.
export const DAY_TZ = "America/Los_Angeles";

export function getPool(): pg.Pool {
  if (pool) return pool;

  const instance = process.env["INSTANCE_CONNECTION_NAME"];
  // A host beginning with "/" makes node-postgres connect over a Unix socket directory.
  const host = process.env["DB_HOST"] ?? (instance ? `/cloudsql/${instance}` : "127.0.0.1");

  pool = new pg.Pool({
    host,
    port: parseInt(process.env["DB_PORT"] ?? "5432"),
    user: process.env["DB_USER"] ?? "postgres",
    password: process.env["DB_PASS"] ?? "",
    database: process.env["DB_NAME"] ?? "postgres",
    // Cloud Run scales by adding instances, so keep each instance's pool small to avoid
    // exhausting Postgres connection slots.
    max: parseInt(process.env["DB_POOL_MAX"] ?? "5"),
    idleTimeoutMillis: 30_000,
  });
  // Without a listener, a backend-initiated socket error would crash the process.
  pool.on("error", (err) => log.error("db.pool_error", { err }));
  return pool;
}

export function query<T extends pg.QueryResultRow = pg.QueryResultRow>(
  text: string,
  params?: unknown[],
): Promise<pg.QueryResult<T>> {
  return getPool().query<T>(text, params as unknown[]);
}

// Idempotent schema setup, run on server startup.
//
// What we know about a request is deliberately split across two tables that share no key:
//
//   accounts        one row per user token.
//   requests        who asked and how much: the account, a hashed sending number, response
//                   size, protocol version, outcome. This is the usage record — quotas and
//                   the /stats dashboard read it.
//   request_shapes  what was asked for: an approximate location, priority mode, models and
//                   variables. Feeds encoding evaluation and corpus work.
//
// The split is the point. Usage accounting needs to tell users apart; corpus work needs
// locations; neither needs both, and joined together they would be a position history keyed to
// a person. `request_shapes` therefore carries no request id, no token and no number, and its
// timestamp is a date rather than a clock time — at this traffic volume a full timestamp would
// re-link the two tables by matching times, which would make the separation cosmetic.
export async function migrate(): Promise<void> {
  await query(`
    create table if not exists accounts (
      token        text primary key,
      sms_consent  boolean not null default false,
      created_at   timestamptz not null default now()
    )
  `);
  // Backfill the column for databases created before sms_consent existed.
  await query(`
    alter table accounts add column if not exists sms_consent boolean not null default false
  `);
  // A surrogate key for the account, so a request can name its account without naming its
  // token. `bigserial` in ALTER creates the sequence and numbers the existing rows.
  await query(`
    alter table accounts add column if not exists id bigserial
  `);
  await query(`
    create unique index if not exists accounts_id_idx on accounts (id)
  `);
  await query(`
    create table if not exists requests (
      id          bigserial primary key,
      token       text references accounts(token),
      created_at  timestamptz not null default now(),
      chars       int,
      version     int
    )
  `);
  // Backfill for databases created before the protocol version was recorded. Per-version
  // request counts are the sunset metric for frozen codec containers (VERSIONING.md).
  await query(`
    alter table requests add column if not exists version int
  `);
  // The account as an opaque number, and deliberately WITHOUT a foreign key: deleting an
  // account drops its `accounts` row, and a foreign key would force this column to be nulled
  // or the delete to be refused. Left standing, the number outlives the account it came from,
  // so `count(distinct account_id)` keeps reporting how many people used the service on a past
  // day. Nothing links it back to a person once the token is gone — that is exactly why it can
  // be kept (accounts.ts, deleteAccount).
  await query(`
    alter table requests add column if not exists account_id bigint
  `);
  // The sending number as an unkeyed HMAC (phone.ts), never the number itself. Enough to count
  // distinct senders and to spot one token texting from several handsets; not enough to call
  // anyone.
  await query(`
    alter table requests add column if not exists phone_hash bytea
  `);
  // How the request ended: 'ok', a dispatch failure, or the non-forecast messages ('help',
  // 'probe'). Rows written before this column existed are all successes — read a null as 'ok'.
  await query(`
    alter table requests add column if not exists outcome text
  `);
  // The device code the request named for itself (`d:` — iPhone, generic SMS, Zoleo, inReach,
  // Garmin email), extracted by the gateway from its frozen sliver of the grammar
  // (dispatch.ts). Null when the request named none: hand-typed messages and pre-`d:` clients.
  await query(`
    alter table requests add column if not exists device text
  `);
  // One-time backfill for rows written before account_id existed. Rows whose token was already
  // nulled by an earlier deletion cannot be recovered: the token that linked them is gone.
  await query(`
    update requests r set account_id = a.id
      from accounts a where a.token = r.token and r.account_id is null
  `);
  await query(`
    create index if not exists requests_token_created_idx on requests (token, created_at)
  `);
  await query(`
    create index if not exists requests_account_created_idx on requests (account_id, created_at)
  `);
  await query(`
    create index if not exists requests_phone_created_idx on requests (phone_hash, created_at)
  `);
  // Coordinates are rounded to 0.01 degrees (~1 km) by the codec server before they ever reach
  // this process, so numeric(4,2)/(5,2) is the full stored precision rather than a truncation.
  await query(`
    create table if not exists request_shapes (
      id         bigserial primary key,
      day        date not null,
      version    int,
      lat        numeric(4,2),
      lon        numeric(5,2),
      loc        text,
      mode       text,
      models     text[],
      vars       text[],
      max_chars  int,
      chars      int
    )
  `);
  // How many messages the reply was allowed to spread over (`n:`, default 1) — part of what was
  // asked for, alongside max_chars, which is derived from it.
  await query(`
    alter table request_shapes add column if not exists messages int
  `);
  await query(`
    create index if not exists request_shapes_day_idx on request_shapes (day)
  `);
}

// Lightweight liveness probe for the DB connection.
export async function ping(): Promise<boolean> {
  try {
    await query("select 1");
    return true;
  } catch (e) {
    log.error("db.ping_failed", { err: e });
    return false;
  }
}

export async function closePool(): Promise<void> {
  if (pool) {
    await pool.end();
    pool = null;
  }
}
