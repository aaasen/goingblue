/**
 * Writes one archived product as an AvalancheForecast JSON document.
 *
 * Usage: pnpm avalanche-export <product id or prefix> [--out path]
 */
import { writeFileSync } from "node:fs";
import { openDb } from "./db.ts";
import { toForecast, type RawProduct } from "../../src/avcan.ts";
import { productPieces } from "./corpus.ts";

const args = process.argv.slice(2);
const outIdx = args.indexOf("--out");
const out = outIdx === -1 ? undefined : args[outIdx + 1];
const id = args.find((a, i) => !a.startsWith("--") && (outIdx === -1 || i !== outIdx + 1));
if (!id) {
  console.error("usage: pnpm avalanche-export <product id or prefix> [--out path]");
  process.exit(2);
}

const db = openDb();
const rows = db.prepare("SELECT id, json FROM products WHERE id LIKE ? ORDER BY date_issued").all(`${id}%`) as { id: string; json: string }[];
if (rows.length !== 1) {
  console.error(rows.length === 0 ? `no product matches ${id}` : `${rows.length} products match ${id}; give a longer prefix`);
  process.exit(1);
}
const product = JSON.parse(rows[0].json) as RawProduct;
const forecast = toForecast(product, productPieces(db)(product));
const text = `${JSON.stringify(forecast, null, 2)}\n`;
if (out) {
  writeFileSync(out, text);
  console.error(`wrote ${rows[0].id} to ${out}`);
} else {
  process.stdout.write(text);
}
