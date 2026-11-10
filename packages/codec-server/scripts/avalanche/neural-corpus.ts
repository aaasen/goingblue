/**
 * Corpus for the shared neural prose model (avalanche/ at the repo root): every rated NAC forecast
 * and every Avalanche Canada bulletin (exact-text duplicates removed within a center), as the
 * app's AvalancheForecast sections plus the structured fields the decoder already has, as context
 * strings.
 *
 * Split by season: train before 2024-08, val 2024-08 to 2025-08, test 2025-08 to 2026-08; later
 * forecasts are left out. PPM baselines: the shared pool trained before each held-out season
 * (ppmBits), and for Avalanche Canada also its own pool (ownBits).
 *
 * Usage: NODE_OPTIONS=--max-old-space-size=13000 pnpm avalanche-neural-corpus [out dir, default data/neural]
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { sectionsOf } from "@weather/protocol";
import { sectionBits } from "@weather/protocol/avalanche-codec/codec";
import { isRated, toForecast } from "../../src/nac.ts";
import { loadBulletins } from "./corpus.ts";
import { openDb } from "./db.ts";
import { ModelBuilder } from "./model.ts";

const OUT = process.argv[2] ?? "data/neural";
const VAL = "2024-08", TEST = "2025-08", END = "2026-08";
interface Sec { kind: string; text: string; context?: string; ctx: string[] }
interface Doc { id: string; center: string; source: "nac" | "avcan"; published: string; ctx: string[]; sections: Sec[] }

function contextOf(f: any): { doc: string[]; problems: string[][] } {
  const doc = [`month:${new Date(f.issued).toISOString().slice(5, 7)}`];
  f.danger.slice(0, 3).forEach((d: any, i: number) => {
    for (const band of ["alp", "tln", "btl"]) doc.push(`d${i}${band}:${d[band]}`);
  });
  if (f.confidence.rating !== "noRating") doc.push(`conf:${f.confidence.rating}`);
  const problems = f.problems.map((p: any) => [
    `lk:${p.likelihood}`, `sz:${p.size.min}-${p.size.max}`,
    ...p.elevations.map((e: string) => `el:${e}`), ...p.aspects.map((a: string) => `as:${a}`),
    ...(p.cells ? ["cells:partial"] : []),
  ]);
  return { doc, problems };
}

function docOf(id: string, center: string, source: Doc["source"], published: string, f: any): Doc | null {
  const { doc, problems } = contextOf(f);
  let pi = 0;
  const sections: Sec[] = sectionsOf(f).filter((s: any) => s.text).map((s: any) =>
    ({ ...s, ctx: s.kind === "problem" ? problems[pi++] : [] }));
  return sections.length ? { id, center, source, published, ctx: doc, sections } : null;
}

const docs: Doc[] = [];
const seen = new Set<string>();
const failed: Record<string, number> = {};
const add = (d: Doc | null) => {
  if (!d || d.published >= END) return;
  const key = d.center + "\0" + d.sections.map((s) => s.text).join("\0");
  if (seen.has(key)) return;
  seen.add(key);
  docs.push(d);
};

// CAIC's own likelihood spellings, as the nearest NAC name; only the context strings see these.
const CAIC: Record<string, string> = { veryLikely: "very likely", possible_unlikely: "possible", veryLikely_likely: "likely" };
const db = openDb();
const rows = db.prepare(`SELECT id, center, body, MAX(updated_at) FROM nac_products WHERE product_type = 'forecast' AND updated_at != '' GROUP BY id ORDER BY published_time, id`).all() as any[];
db.close();
for (const r of rows) {
  const p = JSON.parse(r.body);
  if (!isRated(p)) continue;
  for (const q of p.forecast_avalanche_problems ?? []) q.likelihood = CAIC[q.likelihood] ?? q.likelihood;
  let f;
  try { f = toForecast(p, { id: 0, names: [""] }); } catch { failed[r.center] = (failed[r.center] ?? 0) + 1; continue; }
  add(docOf(`nac:${r.id}`, r.center, "nac", p.published_time, f));
}
for (const b of loadBulletins()) add(docOf(`avcan:${b.id}`, b.forecast.center, "avcan", new Date(b.forecast.issued).toISOString(), b.forecast));
docs.sort((a, b) => a.published.localeCompare(b.published) || a.id.localeCompare(b.id));
console.log("conversion failures by center", failed);

const splitOf = (d: Doc) => d.published < VAL ? "train" : d.published < TEST ? "val" : "test";
const ppm = new Map<string, number[]>();
const own = new Map<string, number[]>();
for (const [cut, held] of [[VAL, "val"], [TEST, "test"]] as const) {
  for (const [map, keep] of [[ppm, (_: Doc) => true], [own, (d: Doc) => d.source === "avcan"]] as const) {
    const b = new ModelBuilder();
    for (const d of docs) if (d.published < cut && keep(d)) for (const s of d.sections) b.observe(s);
    const pool = b.build(1);
    for (const d of docs) if (splitOf(d) === held && keep(d)) map.set(d.id, d.sections.map((s) => sectionBits(pool, s)));
    console.log(`pool before ${cut} (${map === ppm ? "shared" : "avcan"}) scored`);
  }
}

const counts: Record<string, Record<string, number>> = {};
const lines = docs.map((d) => {
  const split = splitOf(d);
  (counts[d.center] ??= {})[split] = (counts[d.center][split] ?? 0) + 1;
  return JSON.stringify({ ...d, split, ppmBits: ppm.get(d.id) ?? null, ownBits: own.get(d.id) ?? null });
});
mkdirSync(OUT, { recursive: true });
writeFileSync(`${OUT}/corpus2.jsonl`, lines.join("\n") + "\n");
console.log(`wrote ${lines.length} docs`);
for (const [c, n] of Object.entries(counts).sort()) console.log(c.padEnd(24), JSON.stringify(n));
