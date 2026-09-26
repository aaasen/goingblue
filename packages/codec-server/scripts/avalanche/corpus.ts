/**
 * The archive as training and test documents: every product with a danger rating, as the
 * app's forecast, split into train and test by a hash of the product id.
 */
import { sectionsOf, type AvalancheForecast } from "@weather/protocol";
import { openDb } from "./db.ts";
import { isForecast, toForecast, type RawProduct } from "./forecast.ts";

export function arg(name: string, fallback: number): number {
  const i = process.argv.indexOf(name);
  return i === -1 ? fallback : Number(process.argv[i + 1]);
}

export interface Doc {
  id: string;
  dateIssued: string;
  forecast: AvalancheForecast;
}

// Every archived product with a danger rating and some prose, as the app's forecast.
export function loadBulletins(): Doc[] {
  const db = openDb();
  const rows = db.prepare("SELECT json FROM products ORDER BY date_issued, id").all() as { json: string }[];
  db.close();
  const out: Doc[] = [];
  for (const { json } of rows) {
    const p = JSON.parse(json) as RawProduct;
    if (!isForecast(p)) continue;
    const forecast = toForecast(p);
    if (sectionsOf(forecast).some((s) => s.text)) out.push({ id: p.id, dateIssued: p.report.dateIssued, forecast });
  }
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
