import { AVALANCHE_PIECES, NAC_CENTERS, pieceAt, type AvalanchePiece } from '@weather/protocol';
import { pieceFeatures, zoneNames, type ForecastRegion } from './avalancheDisplay';

// Choosing an avalanche forecast by forecast center and region instead of by point. A region is
// a piece; its request goes out for a point well inside it.

// The centers as the selector lists them. Parks Canada's four offices forecast separately, so
// each is named by its parks.
const CENTER_NAMES: Record<string, string> = {
  'avalanche-canada': 'Avalanche Canada',
  'avalanche-quebec': 'Avalanche Québec',
  kananaskis: 'Kananaskis Mountain Rescue Program',
  'parks-byk': 'Parks Canada: Banff, Yoho and Kootenay',
  'parks-glacier': 'Parks Canada: Glacier',
  'parks-jasper': 'Parks Canada: Jasper',
  'parks-waterton': 'Parks Canada: Waterton Lakes',
};

export function centerName(center: string): string {
  return CENTER_NAMES[center] ?? NAC_CENTERS[center]?.name ?? center;
}

const byName = (a: string, b: string) => a.localeCompare(b, 'en');

// Every center with a piece, by name.
export const ZONE_CENTERS: readonly { key: string; name: string }[] =
  [...new Set(AVALANCHE_PIECES.map((p) => p.center))]
    .map((key) => ({ key, name: centerName(key) }))
    .sort((a, b) => byName(a.name, b.name));

// The centers by country for their list: the avalanche.org centers are the American ones.
export const ZONE_CENTER_SECTIONS: readonly { title: string; centers: readonly { key: string; name: string }[] }[] = [
  { title: 'USA', centers: ZONE_CENTERS.filter((c) => c.key in NAC_CENTERS) },
  { title: 'Canada', centers: ZONE_CENTERS.filter((c) => !(c.key in NAC_CENTERS)) },
];

// Avalanche Canada's regions by mountain range, each piece listed by its first subregion.
const AVALANCHE_CANADA_GROUPS: [title: string, first: string[]][] = [
  ['Vancouver Island', ['East Island', 'North Island', 'South Island', 'West Island']],
  ['Coast Range', [
    'Birkenhead', 'Brandywine', 'Coquihalla', 'Duffey', 'Fraser', 'Garibaldi', 'Homathko', 'North Shore', 'Powell River',
    'Sasquatch', 'Skagit', 'Sky Pilot', 'South Chilcotin', 'Spearhead', 'Tantalus', 'Taseko', 'Tetrahedron',
  ]],
  ['Northwest', [
    'Boundary', 'Howson', 'Kispiox', 'Kitimat', 'Microwave', 'Nass', 'Ningunsaw', 'North Bulkley', 'Seven Sisters',
    'Shames', 'South Bulkley', 'Stewart',
  ]],
  ['Yukon', ['Haines Pass', 'Tutshi']],
  ['Cariboos', ['Clearwater', 'McBride', 'Premier', 'Quesnel']],
  ['Monashees', [
    'Blue River', 'Clemina', 'Gold', 'Jordan', 'North Monashee', 'North Okanagan', 'Rossland', 'Shuswap',
    'South Okanagan', 'Whatshan',
  ]],
  ['Selkirks', [
    'Badshot', 'Bonnington', 'Central Selkirk', 'Esplanade', 'Goat', 'Grohman', 'Kokanee', 'Kootenay Pass', 'Norns',
    'North Selkirk', 'Retallack', 'Valhalla', 'Ymir',
  ]],
  ['Purcells', ['Crawford', 'Dogtooth', 'East Purcell', 'Moyie', 'St. Mary', 'West Purcell']],
  ['North Rockies', ['East Kakwa', 'Kakwa', 'McGregor', 'Pine Pass', 'Renshaw', 'Robson', 'Sugarbowl', 'Tumbler']],
  ['South Rockies', [
    'Akamina', 'Bull', 'Crowsnest North', 'Crowsnest South', 'Elkford East', 'Elkford West', 'Flathead', 'Lizard',
  ]],
  ['Newfoundland', ['Corner Brook']],
];

export interface RegionSection {
  // Null for a center listed without groups.
  title: string | null;
  pieces: AvalanchePiece[];
}

// A center's regions for its list, by name. Avalanche Canada's come grouped by range; a piece no
// group names lands in a last untitled section, so a new piece is still listed.
export function centerRegions(center: string): RegionSection[] {
  const pieces = AVALANCHE_PIECES.filter((p) => p.center === center)
    .sort((a, b) => byName(zoneNames(a), zoneNames(b)));
  if (center !== 'avalanche-canada') return [{ title: null, pieces }];
  const grouped = new Set<AvalanchePiece>();
  const sections: RegionSection[] = [];
  for (const [title, first] of AVALANCHE_CANADA_GROUPS) {
    const inGroup = pieces.filter((p) => first.includes(p.names[0]));
    inGroup.forEach((p) => grouped.add(p));
    if (inGroup.length > 0) sections.push({ title, pieces: inGroup });
  }
  const rest = pieces.filter((p) => !grouped.has(p));
  if (rest.length > 0) sections.push({ title: null, pieces: rest });
  return sections;
}

type Ring = [number, number][];

function ringArea(ring: Ring): number {
  let sum = 0;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) sum += ring[j][0] * ring[i][1] - ring[i][0] * ring[j][1];
  return Math.abs(sum) / 2;
}

// The distance from a point to a polygon's nearest edge, negative outside it. `kx` scales
// longitude so that distances are even in both directions.
function signedDistance(x: number, y: number, polygon: Ring[], kx: number): number {
  let inside = false;
  let best = Infinity;
  for (const ring of polygon) {
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      const [ax, ay] = ring[i], [bx, by] = ring[j];
      if ((ay > y) !== (by > y) && x < ((bx - ax) * (y - ay)) / (by - ay) + ax) inside = !inside;
      const dx = (bx - ax) * kx, dy = by - ay;
      const px = (x - ax) * kx, py = y - ay;
      const t = dx === 0 && dy === 0 ? 0 : Math.max(0, Math.min(1, (px * dx + py * dy) / (dx * dx + dy * dy)));
      best = Math.min(best, (px - t * dx) ** 2 + (py - t * dy) ** 2);
    }
  }
  return (inside ? 1 : -1) * Math.sqrt(best);
}

// The point of a polygon farthest from its edges, to within `precision` degrees: a grid over the
// bounding box, refined around whichever cells could still hold a better point.
function interiorPoint(polygon: Ring[], precision: number): [number, number] {
  const xs = polygon[0].map((p) => p[0]), ys = polygon[0].map((p) => p[1]);
  const minX = Math.min(...xs), maxX = Math.max(...xs), minY = Math.min(...ys), maxY = Math.max(...ys);
  const kx = Math.cos(((minY + maxY) / 2) * (Math.PI / 180));
  const cell = (x: number, y: number, h: number) => {
    const d = signedDistance(x, y, polygon, kx);
    // The farthest any point of the cell can be from an edge.
    return { x, y, h, d, max: d + h * Math.SQRT2 };
  };
  const size = Math.max(Math.min((maxX - minX) * kx, maxY - minY), precision);
  let h = size / 2;
  let cells: ReturnType<typeof cell>[] = [];
  for (let x = minX; x < maxX; x += size / kx) for (let y = minY; y < maxY; y += size) cells.push(cell(x + h / kx, y + h, h));
  let best = cell((minX + maxX) / 2, (minY + maxY) / 2, 0);
  while (cells.length > 0) {
    for (const c of cells) if (c.d > best.d) best = c;
    h /= 2;
    const next: typeof cells = [];
    for (const c of cells) {
      if (c.max - best.d <= precision) continue;
      for (const sx of [-1, 1]) for (const sy of [-1, 1]) next.push(cell(c.x + (sx * h) / kx, c.y + sy * h, h));
    }
    cells = next;
  }
  return [best.x, best.y];
}

const points = new Map<number, { lat: number; lon: number }>();

// The point a region's request goes out for: the middle of its largest polygon, as far from the
// boundary as it gets, at the request's four decimals.
export function zonePoint(piece: AvalanchePiece): { lat: number; lon: number } {
  let point = points.get(piece.id);
  if (!point) {
    const largest = piece.polygons.reduce((a, b) => (ringArea(b[0]) > ringArea(a[0]) ? b : a));
    const [lon, lat] = interiorPoint(largest, 0.001);
    point = { lat: Math.round(lat * 1e4) / 1e4, lon: Math.round(lon * 1e4) / 1e4 };
    points.set(piece.id, point);
  }
  return point;
}

// The region a stored point names, or null when the pieces no longer hold it.
export function zoneAt(point: { lat: number; lon: number }): AvalanchePiece | null {
  return pieceAt(point.lat, point.lon, AVALANCHE_PIECES);
}

// The selected region for the map, filled in `fill`.
export function zoneRegion(piece: AvalanchePiece, fill: string): ForecastRegion {
  return { data: pieceFeatures([piece]), fill, bbox: piece.bbox };
}
