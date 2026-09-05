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

// The zone every "day" in this system is bounded by — the stats dashboard's daily buckets.
// Pacific, not UTC: an evening request should count on the evening it happened, and UTC would
// push everything after 5pm into tomorrow. A named zone rather than a fixed offset is what
// makes the boundary follow DST.
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
//   accounts  one row per user token.
//   requests  one row per inbound message: who asked (token/account), how the attempt ended,
//             and — for served forecasts — what was asked for, as the codec reported it in the
//             shape header (approximate location, priority mode, model, variables, route).
//             Quotas, the /stats dashboard and corpus work all read this one table.
//
// The privacy line is that no phone number is stored, in any form. What remains is an anonymous
// token tied to an approximate (~1 km) location, which is the accepted trade: the token maps to
// no name, number or address anywhere in this system. The sending number and the full message
// contents live in Twilio's own logs regardless — this table is deliberately not a second copy
// of that correlation.
//
// This replaces an earlier design that split identity (`requests`) from content
// (`request_shapes`) into two unjoinable tables. At this traffic volume timestamps and
// character counts joined them anyway, so the separation was cosmetic; dropping the stored
// number is what actually protects the sensitive link.
export async function migrate(): Promise<void> {
  await query(`
    create table if not exists accounts (
      token       text primary key,
      created_at  timestamptz not null default now()
    )
  `);
  // sms_consent was written during a two-day window in June 2026, before messaging opt-in
  // became consumer-initiated (a user opts in by texting a request); nothing reads it.
  await query(`
    alter table accounts drop column if exists sms_consent
  `);
  // A surrogate key for the account, so a request can name its account without naming its
  // token. `bigserial` in ALTER creates the sequence and numbers the existing rows.
  await query(`
    alter table accounts add column if not exists id bigserial
  `);
  await query(`
    create unique index if not exists accounts_id_idx on accounts (id)
  `);
  // Coordinates are rounded to 0.01 degrees (~1 km) by the codec server before they ever reach
  // this process, so numeric(4,2)/(5,2) is the full stored precision rather than a truncation.
  await query(`
    create table if not exists requests (
      id          bigserial primary key,
      token       text references accounts(token),
      created_at  timestamptz not null default now(),
      chars       int,
      version     int,
      account_id  bigint,
      outcome     text,
      lat         numeric(4,2),
      lon         numeric(5,2),
      loc         text,
      mode        text,
      model       text,
      vars        text[],
      max_chars   int,
      messages    int,
      device      text,
      periods     jsonb,
      codec_ms    int,
      fetch_ms    int,
      encode_ms   int
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
  // How the request ended: 'ok', a dispatch failure, or the non-forecast messages ('help',
  // 'probe'). Rows written before this column existed are all successes — read a null as 'ok'.
  await query(`
    alter table requests add column if not exists outcome text
  `);
  // The shape columns: what a served request asked for, as the codec reported it in the
  // X-Request-Shape header (dispatch.ts, parseShapeHeader). All null for failures and for
  // containers frozen before the header existed. `device` is the `d:` route code, reported by
  // the codec since 2026-08-31 (before that the gateway read it itself); `messages` and
  // `max_chars` are the reply budget it implies.
  await query(`
    alter table requests
      add column if not exists lat numeric(4,2),
      add column if not exists lon numeric(5,2),
      add column if not exists loc text,
      add column if not exists mode text,
      add column if not exists model text,
      add column if not exists vars text[],
      add column if not exists max_chars int,
      add column if not exists messages int,
      add column if not exists device text
  `);
  // What the reply carried and what serving it cost. `periods` maps hours-per-period to how
  // many periods of that resolution the reply held (its sum is the total period count — the
  // quality users actually saw). `codec_ms` is the gateway's wall clock around the whole codec
  // call; `fetch_ms` (Open-Meteo) and `encode_ms` (the fill search) are the codec's own
  // components, so codec_ms minus their sum is container overhead. Codec-reported fields are
  // null from containers frozen before the codec sent them.
  await query(`
    alter table requests
      add column if not exists periods jsonb,
      add column if not exists codec_ms int,
      add column if not exists fetch_ms int,
      add column if not exists encode_ms int
  `);
  // The gateway's id for the message, the same value its logs and the codec's carry as
  // `request_id`, so a row leads straight to the lines that produced it. Null on rows written
  // before the id existed; every row since has one, because the gateway mints it before
  // anything else runs.
  await query(`
    alter table requests add column if not exists request_id text
  `);
  // The sending number is not stored in any form; this drops the hash an earlier design kept
  // (see the header comment above).
  await query(`
    drop index if exists requests_phone_created_idx
  `);
  await query(`
    alter table requests drop column if exists phone_hash
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
  // Accounts the /stats dashboard leaves out of every count, chart, table and the map: the
  // operator's own testing, which otherwise swamps real usage. Membership is edited from the
  // dashboard itself (pages/stats.ts). Nothing about serving reads this table.
  await query(`
    create table if not exists stats_hidden_accounts (
      account_id  bigint primary key,
      created_at  timestamptz not null default now()
    )
  `);
  // Fold the retired request_shapes table into the shape columns above, then drop it. The two
  // tables shared no key — that was the earlier design's point — so the fold re-derives the
  // pairing the split withheld: a shape matches the served request from the same Pacific day
  // with the same version and reply length, duplicates zipped in insertion order (both tables
  // were written back-to-back per message, so both id orders are the arrival order). The whole
  // block is guarded: it runs once against a database that still has the table, and never on a
  // fresh one. The inner branch finishes the models→model rename for a database that predates
  // it.
  await query(`
    do $$
    begin
      if to_regclass('request_shapes') is not null then
        if exists (select 1 from information_schema.columns
                   where table_name = 'request_shapes' and column_name = 'models') then
          alter table request_shapes add column if not exists model text;
          update request_shapes set model = models[1] where model is null;
          alter table request_shapes drop column models;
        end if;
        with s as (
          select *, row_number() over (partition by day, version, chars order by id) as k
            from request_shapes
        ), r as (
          select id, (created_at at time zone '${DAY_TZ}')::date as day, version, chars,
                 row_number() over (partition by (created_at at time zone '${DAY_TZ}')::date,
                                    version, chars order by id) as k
            from requests
           where coalesce(outcome, 'ok') = 'ok'
        )
        update requests q
           set lat = s.lat, lon = s.lon, loc = s.loc, mode = s.mode, model = s.model,
               vars = s.vars, max_chars = s.max_chars, messages = s.messages
          from s
          join r on r.day = s.day
                and r.version is not distinct from s.version
                and r.chars is not distinct from s.chars
                and r.k = s.k
         where q.id = r.id;
        drop table request_shapes;
      end if;
    end
    $$
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
