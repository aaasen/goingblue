/**
 * The bulletin archive: SQLite (node:sqlite, no dependency) at data/avalanche.db, written by
 * collect.ts. `products` holds each bulletin's raw API JSON verbatim, keyed by product id.
 */
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";

const __dirname = dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = join(__dirname, "..", "..", "..", "..");
export const DB_PATH = join(REPO_ROOT, "data", "avalanche.db");

export function openDb(path: string = DB_PATH): DatabaseSync {
  mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec(`
    PRAGMA journal_mode = WAL;
    CREATE TABLE IF NOT EXISTS products (
      id           TEXT PRIMARY KEY,
      type         TEXT NOT NULL,
      owner        TEXT NOT NULL,
      area_id      TEXT NOT NULL,
      title        TEXT NOT NULL,
      date_issued  TEXT NOT NULL,
      valid_until  TEXT NOT NULL,
      timezone     TEXT,
      first_seen   TEXT NOT NULL,
      json         TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS walks (
      walk_date     TEXT PRIMARY KEY,
      fetched_at    TEXT NOT NULL,
      product_count INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS walk_products (
      walk_date  TEXT NOT NULL,
      product_id TEXT NOT NULL,
      PRIMARY KEY (walk_date, product_id)
    );
    CREATE INDEX IF NOT EXISTS products_owner_issued ON products (owner, date_issued);
  `);
  return db;
}
