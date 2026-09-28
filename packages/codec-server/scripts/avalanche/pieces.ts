/**
 * The fixed pieces every avalanche forecast area is built from.
 *
 * Centers group named subregions into a different set of forecast areas each day, but the
 * subregions themselves hold still: overlaying every area used since FIRST_WALK splits the map
 * into about 120 pieces, and each day's areas are unions of them. A piece is a set of places
 * that has always been forecast together; it carries the subregion names common to every area
 * that covered it ("Sky Pilot", or "Kitimat, Rupert, Shames" where those were never split).
 *
 * The script fetches the geometry of every archived area it has not seen yet from the areas
 * endpoint (cached in the `areas` table of data/avalanche.db), overlays them, and writes the
 * pieces to packages/protocol/src/avalanche-pieces.gen.ts, sorted by center and names so
 * reruns over the same archive number them the same way.
 *
 * Usage: pnpm avalanche-pieces
 */
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { difference, intersection, union, type Geom } from "polyclip-ts";
import { subregionNames } from "@weather/protocol";
import { openDb, REPO_ROOT } from "./db.ts";

const API = "https://avcan-services-api.prod.avalanche.ca/forecasts";
const LANG = "en";
const WALK_HOUR = 19;
// The 2022-23 season used an older area layout that the later seasons do not share.
const FIRST_WALK = "2023-08-01";
// Shared boundaries don't always coincide exactly, and a few moved slightly between seasons.
// What that leaves between them is at most 5 km²; the smallest real piece is over 50.
const MIN_PIECE_KM2 = 10;
const OUT = join(REPO_ROOT, "packages", "protocol", "src", "avalanche-pieces.gen.ts");
const REQUEST_TIMEOUT_MS = 90_000;
const RETRIES = 4;

type Ring = [number, number][];
type MultiPoly = Ring[][];
type BBox = [number, number, number, number];

interface Area {
  id: string;
  center: string;
  names: Set<string>;
  geom: MultiPoly;
  bbox: BBox;
}

interface Piece {
  geom: MultiPoly;
  bbox: BBox;
  areas: Set<string>;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function fetchJson(url: string): Promise<unknown> {
  let lastErr: unknown;
  for (let attempt = 1; attempt <= RETRIES; attempt++) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return await res.json();
    } catch (err) {
      lastErr = err;
      const wait = 2000 * 2 ** (attempt - 1);
      console.warn(`  attempt ${attempt} failed (${(err as Error).message}); retrying in ${wait} ms`);
      await sleep(wait);
    }
  }
  throw lastErr;
}

// Fetches the areas of the walk dates that cover every archived area missing from the cache,
// most-uncovered date first, and stores every area each response holds.
async function fillCache(db: ReturnType<typeof openDb>): Promise<void> {
  const rows = db.prepare(`
    SELECT wp.walk_date, p.area_id FROM walk_products wp JOIN products p ON p.id = wp.product_id
    WHERE wp.walk_date >= ?`).all(FIRST_WALK) as { walk_date: string; area_id: string }[];
  const cached = new Set((db.prepare("SELECT id FROM areas").all() as { id: string }[]).map((r) => r.id));
  const byDate = new Map<string, Set<string>>();
  for (const r of rows) {
    if (cached.has(r.area_id)) continue;
    if (!byDate.has(r.walk_date)) byDate.set(r.walk_date, new Set());
    byDate.get(r.walk_date)!.add(r.area_id);
  }
  const missing = new Set([...byDate.values()].flatMap((s) => [...s]));
  console.log(`${cached.size} areas cached, ${missing.size} to fetch`);
  const insert = db.prepare("INSERT OR IGNORE INTO areas (id, walk_date, geometry) VALUES (?, ?, ?)");
  while (missing.size > 0) {
    let best = "", bestCount = 0;
    for (const [date, ids] of byDate) {
      const n = [...ids].filter((id) => missing.has(id)).length;
      if (n > bestCount) { best = date; bestCount = n; }
    }
    if (bestCount === 0) break;
    const hour = String(WALK_HOUR).padStart(2, "0");
    const body = await fetchJson(`${API}/${LANG}/areas?date=${best}T${hour}:00:00.000Z`) as {
      features: { id: string; geometry: unknown }[];
    };
    for (const f of body.features) {
      insert.run(f.id, best, JSON.stringify(f.geometry));
      missing.delete(f.id);
    }
    byDate.delete(best);
    console.log(`  ${best}: ${body.features.length} areas, ${missing.size} still missing`);
  }
  if (missing.size > 0) console.warn(`no geometry found for ${missing.size} areas: ${[...missing].join(", ")}`);
}

function toMultiPoly(geometry: { type: string; coordinates: unknown }): MultiPoly {
  if (geometry.type === "Polygon") return [geometry.coordinates as Ring[]];
  if (geometry.type === "MultiPolygon") return geometry.coordinates as MultiPoly;
  throw new Error(`unexpected geometry ${geometry.type}`);
}

function bboxOf(geom: MultiPoly): BBox {
  let [w, s, e, n] = [Infinity, Infinity, -Infinity, -Infinity];
  for (const poly of geom) for (const [x, y] of poly[0]) {
    w = Math.min(w, x); s = Math.min(s, y); e = Math.max(e, x); n = Math.max(n, y);
  }
  return [w, s, e, n];
}

const overlaps = (a: BBox, b: BBox) => a[0] <= b[2] && b[0] <= a[2] && a[1] <= b[3] && b[1] <= a[3];

// Shoelace area in km², scaled for the ring's latitude; plenty for telling slivers from pieces.
function ringKm2(ring: Ring): number {
  let sum = 0, lat = 0;
  for (let i = 0; i < ring.length; i++) {
    const [x0, y0] = ring[i], [x1, y1] = ring[(i + 1) % ring.length];
    sum += x0 * y1 - x1 * y0;
    lat += y0;
  }
  const km = 111.32;
  return Math.abs(sum / 2) * km * km * Math.cos((lat / ring.length) * Math.PI / 180);
}

const polyKm2 = (poly: Ring[]) => ringKm2(poly[0]) - poly.slice(1).reduce((s, r) => s + ringKm2(r), 0);

// Drops the sliver polygons an overlay leaves along boundaries that nearly coincide.
function clean(geom: MultiPoly): MultiPoly {
  return geom.filter((poly) => polyKm2(poly) >= MIN_PIECE_KM2);
}

// Only areas some bulletin titled: an untitled one gives its pieces no names, so a boundary it
// alone draws would split a piece into halves nothing tells apart.
function loadAreas(db: ReturnType<typeof openDb>): Area[] {
  const rows = db.prepare(`
    SELECT a.id, a.geometry, p.owner, p.title FROM areas a
    JOIN products p ON p.area_id = a.id
    JOIN walk_products wp ON wp.product_id = p.id
    WHERE wp.walk_date >= ? AND p.title != ''
    GROUP BY a.id, p.title`).all(FIRST_WALK) as { id: string; geometry: string; owner: string; title: string }[];
  const areas = new Map<string, Area>();
  for (const r of rows) {
    let area = areas.get(r.id);
    if (!area) {
      const geom = toMultiPoly(JSON.parse(r.geometry));
      area = { id: r.id, center: r.owner, names: new Set(), geom, bbox: bboxOf(geom) };
      areas.set(r.id, area);
    }
    // One area can carry its names in more than one order.
    for (const name of subregionNames(r.title)) area.names.add(name);
  }
  return [...areas.values()].sort((a, b) => a.id.localeCompare(b.id));
}

// Splits the running pieces by each area in turn: the part of a piece inside the area and the
// part outside become separate pieces, and whatever of the area no piece covers yet is new.
function overlay(areas: Area[]): Piece[] {
  let pieces: Piece[] = [];
  let covered: MultiPoly = [];
  areas.forEach((area, i) => {
    const next: Piece[] = [];
    for (const p of pieces) {
      if (!overlaps(p.bbox, area.bbox)) { next.push(p); continue; }
      const inside = clean(intersection(p.geom as Geom, area.geom as Geom) as MultiPoly);
      const outside = clean(difference(p.geom as Geom, area.geom as Geom) as MultiPoly);
      if (inside.length) next.push({ geom: inside, bbox: bboxOf(inside), areas: new Set([...p.areas, area.id]) });
      if (outside.length) next.push({ geom: outside, bbox: bboxOf(outside), areas: p.areas });
    }
    const fresh = clean(covered.length ? difference(area.geom as Geom, covered as Geom) as MultiPoly : area.geom);
    if (fresh.length) next.push({ geom: fresh, bbox: bboxOf(fresh), areas: new Set([area.id]) });
    covered = covered.length ? union(covered as Geom, area.geom as Geom) as MultiPoly : area.geom;
    pieces = next;
    if ((i + 1) % 50 === 0) console.log(`  ${i + 1}/${areas.length} areas, ${pieces.length} pieces`);
  });
  return pieces;
}

const round = (geom: MultiPoly): MultiPoly =>
  geom.map((poly) => poly.map((ring) => ring.map(([x, y]) => [Math.round(x * 1e4) / 1e4, Math.round(y * 1e4) / 1e4])));

async function main(): Promise<void> {
  const db = openDb();
  await fillCache(db);
  const areas = loadAreas(db);
  console.log(`overlaying ${areas.length} areas`);
  const byId = new Map(areas.map((a) => [a.id, a]));
  const pieces = overlay(areas);

  // A piece is what every area covering it has in common, so the names are the intersection.
  const out = pieces.map((p) => {
    const covering = [...p.areas].map((id) => byId.get(id)!);
    const names = [...covering[0].names].filter((n) => covering.every((a) => a.names.has(n))).sort();
    const centers = new Set(covering.map((a) => a.center));
    if (centers.size > 1) console.warn(`piece ${names.join(", ")} spans centers ${[...centers].join(", ")}`);
    if (names.length === 0) console.warn(`piece in ${covering.map((a) => a.id.slice(0, 8)).join(", ")} has no common name`);
    const polygons = round(p.geom);
    return { center: covering[0].center, names, bbox: bboxOf(polygons), polygons };
  });
  out.sort((a, b) => a.center.localeCompare(b.center) || a.names.join(",").localeCompare(b.names.join(",")));

  const lines = out.map((p, id) => `  ${JSON.stringify({ id, ...p })},`);
  const vertices = out.reduce((n, p) => n + p.polygons.flat(2).length, 0);
  writeFileSync(OUT, `// GENERATED FILE, do not edit by hand. Written by \`pnpm avalanche-pieces\`
// (packages/codec-server/scripts/avalanche/pieces.ts) from the ${areas.length} forecast areas used
// since ${FIRST_WALK}. The fixed pieces every forecast area is a union of; coordinates are
// [lon, lat] rounded to 1e-4 degrees.

export interface AvalanchePiece {
  id: number;
  // The forecast center that covers the piece: 'avalanche-canada', 'parks-byk', ...
  center: string;
  // The subregions the piece holds; several where they have always been forecast together.
  names: string[];
  // [west, south, east, north].
  bbox: [number, number, number, number];
  // MultiPolygon coordinates.
  polygons: [number, number][][][];
}

export const AVALANCHE_PIECES: AvalanchePiece[] = [
${lines.join("\n")}
];
`);
  console.log(`wrote ${out.length} pieces (${vertices} vertices) to ${OUT}`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
