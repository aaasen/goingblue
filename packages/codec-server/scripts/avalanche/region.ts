/**
 * Trains the model a bulletin's piece set is coded with (protocol avalanche-codec/region.ts).
 *
 * Each archived area is mapped to the pieces it covers through one interior point per piece.
 * Every product on every walk day since FIRST_WALK is one observation of its area's set. The
 * anchor (the set's lowest piece) is counted; for each anchor, the higher pieces of its center
 * are ordered by how often they join it, and each takes as its link whichever piece before it
 * (the anchor included) best predicts it over the anchor's observations, by smoothed in-sample
 * cost. The weights are the smoothed chances of the piece being in, given the link out or in.
 *
 * Writes packages/protocol/src/avalanche-region.gen.ts and prints the held-out cost of the
 * last season under a model trained on the seasons before it. The file is wire format, pinned
 * by the digest in packages/protocol/test/avcan-model.test.ts; rerun it after
 * `pnpm avalanche-pieces`, since the model is keyed by piece id.
 *
 * Also writes packages/codec-server/src/avalanche-areas.gen.ts: the pieces each archived area
 * covers, so the codec server only asks Avalanche Canada for an area's geometry when the area
 * is newer than the archive.
 *
 * Usage: pnpm avalanche-region
 */
import { createHash } from "node:crypto";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { AVALANCHE_PIECES } from "@weather/protocol";
import { inPolygons, piecesInArea } from "@weather/protocol/avalanche-codec/region";
import { SCALE } from "@weather/protocol/avalanche-codec/rans";
import { openDb, REPO_ROOT } from "./db.ts";

// The first walk of the piece layout (pieces.ts).
const FIRST_WALK = "2023-08-01";
// Pseudo-count on each side of a link weight; picked on the held-out season.
const EPS = 0.25;
// Interior points are searched on a GRID × GRID lattice over each polygon's bounding box.
const GRID = 30;
const OUT = join(REPO_ROOT, "packages", "protocol", "src", "avalanche-region.gen.ts");
const AREAS_OUT = join(REPO_ROOT, "packages", "codec-server", "src", "avalanche-areas.gen.ts");

type Ring = [number, number][];
type Link = [number, number, number, number];
interface Obs { season: number; set: number[] }

function segDist(x: number, y: number, [ax, ay]: number[], [bx, by]: number[]): number {
  const dx = bx - ax, dy = by - ay, len = dx * dx + dy * dy;
  const t = len ? Math.max(0, Math.min(1, ((x - ax) * dx + (y - ay) * dy) / len)) : 0;
  return Math.hypot(x - ax - t * dx, y - ay - t * dy);
}

// The lattice point inside the piece farthest from its polygon's edges, rounded like the pieces.
function interior(polygons: Ring[][]): [number, number] {
  let best: [number, number] = [NaN, NaN], bestDist = -1;
  for (const poly of polygons) {
    let [w, s, e, n] = [Infinity, Infinity, -Infinity, -Infinity];
    for (const [x, y] of poly[0]) { w = Math.min(w, x); s = Math.min(s, y); e = Math.max(e, x); n = Math.max(n, y); }
    for (let i = 1; i < GRID; i++) for (let j = 1; j < GRID; j++) {
      const x = Math.round((w + ((e - w) * i) / GRID) * 1e4) / 1e4, y = Math.round((s + ((n - s) * j) / GRID) * 1e4) / 1e4;
      if (!inPolygons(x, y, polygons)) continue;
      let d = Infinity;
      for (const ring of poly) for (let k = 0; k < ring.length; k++) d = Math.min(d, segDist(x, y, ring[k], ring[(k + 1) % ring.length]));
      if (d > bestDist) { bestDist = d; best = [x, y]; }
    }
  }
  if (!Number.isFinite(best[0])) throw new Error("region: no interior point found");
  return best;
}

// Every product-day since FIRST_WALK, and the pieces each area covers.
function observations(interiors: [number, number][]): { obs: Obs[]; areaPieces: Map<string, number[]> } {
  const db = openDb();
  const areas = new Map<string, { geometry: string }>();
  for (const r of db.prepare("SELECT id, geometry FROM areas").all() as { id: string; geometry: string }[]) areas.set(r.id, r);
  const rows = db.prepare(`
    SELECT wp.walk_date AS day, p.area_id AS area, p.owner AS center FROM walk_products wp
    JOIN products p ON p.id = wp.product_id WHERE wp.walk_date >= ?`).all(FIRST_WALK) as { day: string; area: string; center: string }[];
  db.close();
  const sets = new Map<string, number[]>();
  const centers = new Map<string, string>();
  const out: Obs[] = [];
  let missing = 0, empty = 0;
  for (const r of rows) {
    const area = areas.get(r.area);
    if (!area) { missing++; continue; }
    const center = centers.get(r.area) ?? r.center;
    if (center !== r.center) throw new Error(`region: area ${r.area} belongs to ${center} and ${r.center}`);
    centers.set(r.area, center);
    let set = sets.get(r.area);
    if (!set) sets.set(r.area, (set = piecesInArea(JSON.parse(area.geometry), r.center, interiors)));
    if (set.length === 0) { empty++; continue; }
    const [y, m] = r.day.split("-").map(Number);
    out.push({ season: m >= 8 ? y : y - 1, set });
  }
  console.log(`${out.length} product-days over ${sets.size} areas; skipped ${missing} without geometry, ${empty} covering no piece`);
  return { obs: out, areaPieces: sets };
}

const weight = (k: number, n: number) => Math.min(SCALE - 1, Math.max(1, Math.round(((k + EPS) / (n + 2 * EPS)) * SCALE)));
const entropy = (k: number, n: number) => {
  const p = (k + EPS) / (n + 2 * EPS);
  return -(k * Math.log2(p) + (n - k) * Math.log2(1 - p));
};

function train(obs: Obs[]): { anchors: number[]; chains: Link[][] } {
  const anchors = new Array(AVALANCHE_PIECES.length + 1).fill(0);
  const byAnchor = new Map<number, Set<number>[]>();
  for (const o of obs) {
    anchors[o.set[0]]++;
    if (!byAnchor.has(o.set[0])) byAnchor.set(o.set[0], []);
    byAnchor.get(o.set[0])!.push(new Set(o.set));
  }
  const chains = AVALANCHE_PIECES.map((a) => {
    const sets = byAnchor.get(a.id) ?? [];
    const joins = (q: number) => sets.filter((s) => s.has(q)).length;
    const order = AVALANCHE_PIECES.filter((q) => q.center === a.center && q.id > a.id)
      .map((q) => q.id).sort((x, y) => joins(y) - joins(x) || x - y);
    return order.map((q, i): Link => {
      let best: { cost: number; link: Link } | null = null;
      for (const r of [a.id, ...order.slice(0, i)]) {
        let n0 = 0, k0 = 0, n1 = 0, k1 = 0;
        for (const s of sets) {
          if (s.has(r)) { n1++; if (s.has(q)) k1++; } else { n0++; if (s.has(q)) k0++; }
        }
        const cost = entropy(k0, n0) + entropy(k1, n1);
        if (!best || cost < best.cost - 1e-9) best = { cost, link: [q, r, weight(k0, n0), weight(k1, n1)] };
      }
      return best!.link;
    });
  });
  return { anchors, chains };
}

// Mean bits per observation: the anchor under add-one counts, then the chain.
function cost({ anchors, chains }: ReturnType<typeof train>, obs: Obs[]): { anchor: number; chain: number } {
  const total = anchors.reduce((s, n) => s + n + 1, 0);
  let anchor = 0, chain = 0;
  for (const o of obs) {
    const set = new Set(o.set);
    anchor -= Math.log2((anchors[o.set[0]] + 1) / total);
    for (const [q, r, outW, inW] of chains[o.set[0]]) {
      const w = set.has(r) ? inW : outW;
      chain -= Math.log2((set.has(q) ? w : SCALE - w) / SCALE);
    }
  }
  return { anchor: anchor / obs.length, chain: chain / obs.length };
}

function main(): void {
  const interiors = AVALANCHE_PIECES.map((p) => interior(p.polygons));
  const { obs, areaPieces } = observations(interiors);

  const seasons = [...new Set(obs.map((o) => o.season))].sort();
  const last = seasons[seasons.length - 1];
  const held = cost(train(obs.filter((o) => o.season < last)), obs.filter((o) => o.season === last));
  const model = train(obs);
  const fit = cost(model, obs);
  const fmt = (c: { anchor: number; chain: number }) =>
    `${(c.anchor + c.chain).toFixed(2)} bits (anchor ${c.anchor.toFixed(2)} + chain ${c.chain.toFixed(2)})`;
  console.log(`held out ${last}-${last + 1}: ${fmt(held)}`);
  console.log(`in sample, all seasons: ${fmt(fit)}`);

  const links = model.chains.reduce((n, c) => n + c.length, 0);
  writeFileSync(OUT, `// GENERATED FILE, do not edit by hand. Written by \`pnpm avalanche-region\`
// (packages/codec-server/scripts/avalanche/region.ts) from ${obs.length} product-days since ${FIRST_WALK}.
// The model a bulletin's piece set is coded with; see avalanche-codec/region.ts.

// A point inside each piece, [lon, lat], by piece id.
export const PIECE_INTERIORS: [number, number][] = ${JSON.stringify(interiors)};

// How often each piece was the lowest of its set, by piece id, then the count for no pieces.
export const REGION_ANCHOR_COUNTS: number[] = ${JSON.stringify(model.anchors)};

// By anchor: the chain of [piece, link, weight in when the link is out, weight in when the link
// is in], weights out of ${SCALE}.
export const REGION_CHAINS: [number, number, number, number][][] = [
${model.chains.map((c) => `  ${JSON.stringify(c)},`).join("\n")}
];
`);
  const digest = createHash("sha256").update(JSON.stringify([interiors, model.anchors, model.chains])).digest("hex").slice(0, 16);
  console.log(`wrote ${links} links to ${OUT}, digest ${digest}`);

  const ids = [...areaPieces.keys()].sort();
  writeFileSync(AREAS_OUT, `// GENERATED FILE, do not edit by hand. Written by \`pnpm avalanche-region\`
// (scripts/avalanche/region.ts) from the ${ids.length} areas archived since ${FIRST_WALK}.
// The pieces (AVALANCHE_PIECES ids) each area of the Avalanche Canada API covers.

export const AVALANCHE_AREAS: Record<string, number[]> = {
${ids.map((id) => `  "${id}": ${JSON.stringify(areaPieces.get(id))},`).join("\n")}
};
`);
  console.log(`wrote ${ids.length} areas to ${AREAS_OUT}`);
}

main();
