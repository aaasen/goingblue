import outlines from './assets/outlines.json';
import { CATALOGUE, type Pack } from './catalogue';

// Which packs a position falls in — the state or province and the country — from the simplified
// pack polygons the build writes next to the catalogue (maps/build/basemap.py, `outlines.json`:
// {id: [[exterior, hole, ...], ...]}, lon/lat, ~5 km tolerance).
//
// That tolerance means a coastal city can sit just outside its own coastline (Vancouver falls in
// Burrard Inlet), so a position inside no polygon snaps to the nearest one within SNAP degrees.
// Anything further is open sea, and there's no pack for that.

type Ring = number[][];
type Polygon = Ring[];
const OUTLINES: Record<string, Polygon[]> = outlines;

const SNAP = 0.1; // degrees, ~10 km

export interface RegionsAt {
  state?: Pack;    // only inside the subdivided countries
  country?: Pack;
}

export function regionsAt(lat: number, lon: number, cat = CATALOGUE, shapes = OUTLINES): RegionsAt {
  let country: { pack: Pack; d: number } | undefined;
  let state: { pack: Pack; d: number } | undefined;
  for (const pack of cat.packs) {
    const [w, s, e, n] = pack.bounds;
    if (lon < w - SNAP || lon > e + SNAP || lat < s - SNAP || lat > n + SNAP) continue;
    const polys = shapes[pack.id];
    if (!polys) continue;
    const d = distanceTo(polys, lon, lat);
    if (d > SNAP) continue;
    const best = pack.parent ? state : country;
    if (!best || d < best.d) {
      if (pack.parent) state = { pack, d };
      else country = { pack, d };
    }
  }
  // A state settles its country: at a land border the nearest country polygon can be the
  // neighbour's while the state polygon, being smaller, is the one the position is actually in.
  if (state) {
    const parent = cat.packs.find((p) => p.id === state!.pack.parent);
    return { state: state.pack, country: parent };
  }
  return { country: country?.pack };
}

// 0 inside; otherwise the distance to the nearest edge in degrees, longitude scaled to the
// latitude so the snap radius is round on the ground.
function distanceTo(polys: Polygon[], lon: number, lat: number): number {
  const kx = Math.cos((lat * Math.PI) / 180);
  let best = Infinity;
  for (const rings of polys) {
    if (inRing(rings[0], lon, lat) && !rings.slice(1).some((hole) => inRing(hole, lon, lat))) return 0;
    for (const ring of rings) {
      for (let i = 1; i < ring.length; i++) {
        const d = segmentDistance(ring[i - 1], ring[i], lon, lat, kx);
        if (d < best) best = d;
      }
    }
  }
  return best;
}

// Ray casting: odd crossings of a horizontal ray eastward from the point.
function inRing(ring: Ring, x: number, y: number): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i];
    const [xj, yj] = ring[j];
    if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

function segmentDistance(a: number[], b: number[], x: number, y: number, kx: number): number {
  const ax = a[0] * kx, ay = a[1], bx = b[0] * kx, by = b[1], px = x * kx;
  const dx = bx - ax, dy = by - ay;
  const len2 = dx * dx + dy * dy;
  const t = len2 === 0 ? 0 : Math.max(0, Math.min(1, ((px - ax) * dx + (y - ay) * dy) / len2));
  const ex = ax + t * dx - px, ey = ay + t * dy - y;
  return Math.sqrt(ex * ex + ey * ey);
}
