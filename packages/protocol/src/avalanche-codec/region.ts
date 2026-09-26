/**
 * Where a bulletin applies: the set of pieces (avalanche-pieces.gen.ts) its forecast area is the
 * union of, coded against the model in avalanche-region.gen.ts.
 *
 * The lowest piece in the set is the anchor, coded over every piece plus NO_PIECES for an area
 * the pieces don't describe. Every other piece of the anchor's center with a higher id then
 * gets one in/out bit, in the anchor's chain order, each conditioned on the bit of one piece
 * already known (the anchor itself or an earlier link) through that link's two weights.
 * Pieces of other centers and pieces below the anchor cannot be in the set.
 */
import { AVALANCHE_PIECES } from "../avalanche-pieces.gen.js";
import { PIECE_INTERIORS, REGION_ANCHOR_COUNTS, REGION_CHAINS } from "../avalanche-region.gen.js";
import { buildTable, SCALE, type Decision, type Decoder, type Table } from "./rans.js";

export const NO_PIECES = AVALANCHE_PIECES.length;

let anchorTbl: Table | null = null;
const anchorTable = (): Table =>
  (anchorTbl ??= buildTable(REGION_ANCHOR_COUNTS.map((n, sym) => [sym, n + 1])));

const bitTables = new Map<number, Table>();
function bitTable(weightIn: number): Table {
  let t = bitTables.get(weightIn);
  if (!t) bitTables.set(weightIn, (t = buildTable([[0, SCALE - weightIn], [1, weightIn]])));
  return t;
}

// Appends the decisions for a piece set (ascending ids) to `plan`.
export function planRegion(plan: Decision[], pieces: readonly number[]): void {
  if (pieces.length === 0) {
    plan.push([anchorTable(), NO_PIECES]);
    return;
  }
  const anchor = pieces[0];
  const set = new Set(pieces);
  const chain = REGION_CHAINS[anchor];
  const reachable = new Set(chain.map(([q]) => q));
  for (const p of pieces.slice(1)) {
    if (!reachable.has(p)) throw new Error(`region: piece ${p} cannot follow anchor ${anchor}`);
  }
  plan.push([anchorTable(), anchor]);
  for (const [q, r, outW, inW] of chain) plan.push([bitTable(set.has(r) ? inW : outW), set.has(q) ? 1 : 0]);
}

export function readRegion(dec: Decoder): number[] {
  const anchor = dec.get(anchorTable());
  if (anchor === NO_PIECES) return [];
  const set = new Set([anchor]);
  for (const [q, r, outW, inW] of REGION_CHAINS[anchor]) {
    if (dec.get(bitTable(set.has(r) ? inW : outW))) set.add(q);
  }
  return [...set].sort((a, b) => a - b);
}

function inRing(lon: number, lat: number, ring: readonly [number, number][]): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i], [xj, yj] = ring[j];
    if ((yi > lat) !== (yj > lat) && lon < ((xj - xi) * (lat - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

// Whether [lon, lat] lies in MultiPolygon coordinates.
export function inPolygons(lon: number, lat: number, polygons: readonly (readonly [number, number][])[][]): boolean {
  return polygons.some(([outer, ...holes]) => inRing(lon, lat, outer) && !holes.some((h) => inRing(lon, lat, h)));
}

// The pieces of `center` a forecast area (GeoJSON Polygon or MultiPolygon) covers, found by the
// interior point of each piece. Areas are unions of whole pieces, so one point per piece decides.
export function piecesInArea(
  geometry: { type: string; coordinates: unknown }, center: string,
  interiors: readonly (readonly [number, number])[] = PIECE_INTERIORS,
): number[] {
  const polygons = (geometry.type === "Polygon" ? [geometry.coordinates] : geometry.coordinates) as [number, number][][][];
  return AVALANCHE_PIECES
    .filter((p) => p.center === center && inPolygons(interiors[p.id][0], interiors[p.id][1], polygons))
    .map((p) => p.id);
}
