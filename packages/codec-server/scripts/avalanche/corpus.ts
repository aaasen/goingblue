/**
 * The archive as training and test documents: every product with a danger rating, as the
 * app's forecast, split into train and test by a hash of the product id.
 */
import { NAC_CENTERS, piecesInArea, sectionsOf, type AvalancheForecast } from "@weather/protocol";
import { openDb } from "./db.ts";
import { isForecast, toForecast, type RawProduct } from "../../src/avcan.ts";
import { isRated, toForecast as toNacForecast, type NacProduct } from "../../src/nac.ts";

export function arg(name: string, fallback: number): number {
  const i = process.argv.indexOf(name);
  return i === -1 ? fallback : Number(process.argv[i + 1]);
}

export interface Doc {
  id: string;
  dateIssued: string;
  forecast: AvalancheForecast;
}

// The pieces a product's area covers, from the geometry pieces.ts cached; empty for the areas
// it never fetched (those of seasons before the piece layout).
export function productPieces(db: ReturnType<typeof openDb>): (p: RawProduct) => number[] {
  const geometry = new Map((db.prepare("SELECT id, geometry FROM areas").all() as { id: string; geometry: string }[])
    .map((r) => [r.id, r.geometry]));
  const memo = new Map<string, number[]>();
  return (p) => {
    const key = `${p.area.id}|${p.owner.value}`;
    let pieces = memo.get(key);
    if (!pieces) {
      const g = geometry.get(p.area.id);
      memo.set(key, (pieces = g ? piecesInArea(JSON.parse(g), p.owner.value) : []));
    }
    return pieces;
  };
}

// Every archived product with a danger rating and some prose, as the app's forecast.
export function loadBulletins(): Doc[] {
  const db = openDb();
  const rows = db.prepare("SELECT json FROM products ORDER BY date_issued, id").all() as { json: string }[];
  const piecesOf = productPieces(db);
  db.close();
  const out: Doc[] = [];
  for (const { json } of rows) {
    const p = JSON.parse(json) as RawProduct;
    if (!isForecast(p)) continue;
    const forecast = toForecast(p, piecesOf(p));
    if (sectionsOf(forecast).some((s) => s.text)) out.push({ id: p.id, dateIssued: p.report.dateIssued, forecast });
  }
  return out;
}

// Every archived NWAC forecast with a danger rating and some prose, latest version of each. A
// product covering several zones counts once, under its first.
// Every rated forecast of the avalanche.org centers the app serves. A few from before 2023 carry
// values the adapter rejects (a null likelihood, a danger of 6); those are left out.
export function loadNacBulletins(): Doc[] {
  const db = openDb();
  const rows = db.prepare(
    `SELECT id, center, body, MAX(updated_at) FROM nac_products WHERE product_type = 'forecast' AND updated_at != ''
     GROUP BY id ORDER BY published_time, id`,
  ).all() as { id: number; center: string; body: string }[];
  db.close();
  const out: Doc[] = [];
  let rejected = 0;
  for (const { id, center, body } of rows) {
    const served = NAC_CENTERS[center.toLowerCase()];
    if (!served) continue;
    const p = JSON.parse(body) as NacProduct;
    if (!isRated(p)) continue;
    let forecast: AvalancheForecast;
    try { forecast = toNacForecast(p, served); } catch { rejected++; continue; }
    if (sectionsOf(forecast).some((s) => s.text)) out.push({ id: String(id), dateIssued: p.published_time, forecast });
  }
  if (rejected) console.log(`left out ${rejected} forecasts the adapter rejects`);
  return out;
}

// FNV-1a over the id, mapped to [0, 1).
function unitHash(id: string): number {
  let h = 2166136261;
  for (let i = 0; i < id.length; i++) h = Math.imul(h ^ id.charCodeAt(i), 16777619);
  return (h >>> 0) / 4294967296;
}

export function split(docs: Doc[], testFrac: number): { train: Doc[]; test: Doc[] } {
  return {
    train: docs.filter((d) => unitHash(d.id) >= testFrac),
    test: docs.filter((d) => unitHash(d.id) < testFrac),
  };
}
