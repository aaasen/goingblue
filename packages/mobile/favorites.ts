import AsyncStorage from '@react-native-async-storage/async-storage';
import { formatLatLon, type LatLon } from './coords';

// Favorite locations: points the reader saved, from the map or by coordinates, each under a
// name. They live on the phone only and travel in no request.
//
// A favorite has no id. Its identity is its coordinates written as text (formatLatLon, five
// decimals), and the stored point is rounded to that precision, so pinning a favorite gives a
// point that matches it exactly. One point holds one favorite: saving it again renames it.

export interface Favorite extends LatLon {
  name: string;
  // When the favorite was last saved or selected (ms epoch).
  usedAt: number;
}

export const FAVORITES_KEY = 'favorite_locations';

export function favoriteKey(c: LatLon): string {
  return formatLatLon(c);
}

export function findFavorite(favorites: readonly Favorite[], c: LatLon | null): Favorite | undefined {
  if (c == null) return undefined;
  const key = favoriteKey(c);
  return favorites.find((f) => favoriteKey(f) === key);
}

// Alphabetical by name, reading "Camp 2" before "Camp 10".
function sorted(favorites: Favorite[]): Favorite[] {
  return favorites.sort((a, b) =>
    a.name.localeCompare(b.name, undefined, { sensitivity: 'base', numeric: true }) || a.usedAt - b.usedAt);
}

// How the favorites list is ordered. The stored list stays alphabetical; the other orders are
// views of it.
export type FavoriteSort = 'name' | 'recent' | 'distance';

export function isFavoriteSort(v: unknown): v is FavoriteSort {
  return v === 'name' || v === 'recent' || v === 'distance';
}

// Great-circle kilometers. Favorites can sit a continent apart, where a flat approximation
// would misorder them.
export function kmBetween(a: LatLon, b: LatLon): number {
  const rad = Math.PI / 180;
  const dLat = (b.lat - a.lat) * rad;
  const dLon = (b.lon - a.lon) * rad;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * rad) * Math.cos(b.lat * rad) * Math.sin(dLon / 2) ** 2;
  return 2 * 6371 * Math.asin(Math.min(1, Math.sqrt(h)));
}

// The list in the chosen order: by name as stored, last used first, or nearest `origin` first.
// Distance without an origin falls back to the stored order, so the list is never left unsorted.
// `reversed` turns the chosen order around: Z to A, longest unused first, farthest first.
export function sortFavorites(
  favorites: readonly Favorite[], sort: FavoriteSort, origin: LatLon | null, reversed = false,
): Favorite[] {
  const list = [...favorites];
  if (sort === 'recent') list.sort((a, b) => b.usedAt - a.usedAt);
  else if (sort === 'distance' && origin) {
    const km = new Map(favorites.map((f) => [f, kmBetween(origin, f)]));
    list.sort((a, b) => km.get(a)! - km.get(b)!);
  }
  return reversed ? list.reverse() : list;
}

// Save a point, or rename the favorite already at it. Saving counts as a use. Returns a new list.
export function upsertFavorite(favorites: readonly Favorite[], c: LatLon, name: string, now = Date.now()): Favorite[] {
  const key = favoriteKey(c);
  const existing = favorites.find((f) => favoriteKey(f) === key);
  const point = parsePoint(key);
  const next: Favorite = { ...point, name: name.trim(), usedAt: now };
  return sorted([...favorites.filter((f) => f !== existing), next]);
}

// Mark a favorite as used now, which moves it to the top of the recent order. Returns a new list.
export function touchFavorite(favorites: readonly Favorite[], c: LatLon, now = Date.now()): Favorite[] {
  const key = favoriteKey(c);
  return favorites.map((f) => (favoriteKey(f) === key ? { ...f, usedAt: now } : f));
}

export function removeFavorite(favorites: readonly Favorite[], c: LatLon): Favorite[] {
  const key = favoriteKey(c);
  return favorites.filter((f) => favoriteKey(f) !== key);
}

// The points the map marks for saved forecasts: one per key however many forecasts share it, and
// none where a favorite already stands, since its star marks the spot.
export function pastForecastPoints(points: readonly LatLon[], favorites: readonly Favorite[]): LatLon[] {
  const seen = new Set(favorites.map(favoriteKey));
  const out: LatLon[] = [];
  for (const p of points) {
    const key = favoriteKey(p);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ lat: p.lat, lon: p.lon });
  }
  return out;
}

// The point a key names: the coordinates rounded to the key's precision.
function parsePoint(key: string): LatLon {
  const [lat, lon] = key.split(', ').map(Number);
  return { lat, lon };
}

// A stored entry as a favorite, or null if it doesn't read as one. An entry with no time reads
// as never used, so it sorts last in the recent order.
function readFavorite(v: unknown): Favorite | null {
  if (typeof v !== 'object' || v == null) return null;
  const f = v as Record<string, unknown>;
  if (typeof f.name !== 'string' || f.name === '') return null;
  if (typeof f.lat !== 'number' || Math.abs(f.lat) > 90) return null;
  if (typeof f.lon !== 'number' || Math.abs(f.lon) > 180) return null;
  return { name: f.name, lat: f.lat, lon: f.lon, usedAt: typeof f.usedAt === 'number' ? f.usedAt : 0 };
}

// Entries that don't read as favorites are dropped one by one, so a single bad entry can't take
// the rest of the list with it.
export async function loadFavorites(): Promise<Favorite[]> {
  try {
    const raw = await AsyncStorage.getItem(FAVORITES_KEY);
    if (raw == null) return [];
    const list: unknown = JSON.parse(raw);
    return Array.isArray(list) ? sorted(list.map(readFavorite).filter((f) => f != null)) : [];
  } catch {
    return [];
  }
}

export async function saveFavorites(favorites: readonly Favorite[]): Promise<void> {
  try { await AsyncStorage.setItem(FAVORITES_KEY, JSON.stringify(favorites)); } catch { /* ignore */ }
}
