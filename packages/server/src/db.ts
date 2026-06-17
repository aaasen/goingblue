import pg from "pg";

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
  pool.on("error", (err) => console.error("pg pool error:", err));
  return pool;
}

export function query<T extends pg.QueryResultRow = pg.QueryResultRow>(
  text: string,
  params?: unknown[],
): Promise<pg.QueryResult<T>> {
  return getPool().query<T>(text, params as unknown[]);
}

// Idempotent schema setup, run on server startup. `accounts` holds one row per user token;
// `requests` records each forecast request against its token, which is what per-user quotas
// will later count over a time window.
export async function migrate(): Promise<void> {
  await query(`
    create table if not exists accounts (
      token       text primary key,
      created_at  timestamptz not null default now()
    )
  `);
  await query(`
    create table if not exists requests (
      id          bigserial primary key,
      token       text references accounts(token),
      created_at  timestamptz not null default now(),
      chars       int
    )
  `);
  await query(`
    create index if not exists requests_token_created_idx on requests (token, created_at)
  `);
}

// Lightweight liveness probe for the DB connection.
export async function ping(): Promise<boolean> {
  try {
    await query("select 1");
    return true;
  } catch (e) {
    console.error("db ping failed:", e);
    return false;
  }
}

export async function closePool(): Promise<void> {
  if (pool) {
    await pool.end();
    pool = null;
  }
}
