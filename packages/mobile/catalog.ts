import bundled from './assets/catalog.json';

// The offline-map catalog: what the basemap build (maps/build/basemap.py) published, as the
// app lists it. The world is bundled to z6; everything below is a pack — one per country, plus
// states / provinces inside the US and Canada — cut to `maxzoom` from the same global archive.
//
// The copy in assets/ is the `catalog` step's output from the tracked Natural Earth polygons:
// the full list with no sizes, because the packs haven't been built. When they have, the
// `packs` step writes the same file with `bytes` filled in and it replaces this one.

export interface Pack {
  id: string;             // ISO 3166: "us", "us-co", "ca-bc"
  name: string;
  continent: string;      // Natural Earth's; see `continentName`
  parent: string | null;  // country id for a state / province
  maxzoom: number;
  bounds: number[];       // W, S, E, N
  bytes: number | null;   // base + hillshade archive; null until the pack is built
  files: { base: string; hs: string };
}

export interface Catalog {
  version: number;
  maxzoom: number;
  bundled_maxzoom: number;
  landcover_maxzoom: number;
  global: { base: string; hs: string };
  bundled: { base: string; hs: string; maxzoom: number; bytes: number | null };
  packs: Pack[];
}

export const CATALOG: Catalog = bundled;

export interface Continent {
  id: string;          // Natural Earth's name, verbatim — the key the packs carry
  name: string;        // as listed
  countries: Pack[];   // sorted by name
}

// Natural Earth files the scattered Atlantic / Indian Ocean islands (Saint Helena, Seychelles,
// Maldives…) under "Seven seas (open ocean)", which reads oddly in a list of continents.
const SEVEN_SEAS = 'Seven seas (open ocean)';

export function continentName(continent: string): string {
  return continent === SEVEN_SEAS ? 'Ocean islands' : continent;
}

const byName = (a: { name: string }, b: { name: string }) => a.name.localeCompare(b.name);

// The top level of the list: continents by name, with their countries by name. The islands group
// goes last rather than alphabetically under O, since it's a catch-all rather than a place.
export function continents(cat: Catalog = CATALOG): Continent[] {
  const groups = new Map<string, Pack[]>();
  for (const pack of cat.packs) {
    if (pack.parent) continue;
    const list = groups.get(pack.continent) ?? [];
    list.push(pack);
    groups.set(pack.continent, list);
  }
  return [...groups.entries()]
    .map(([id, countries]) => ({ id, name: continentName(id), countries: countries.sort(byName) }))
    .sort((a, b) => (a.id === SEVEN_SEAS ? 1 : 0) - (b.id === SEVEN_SEAS ? 1 : 0) || byName(a, b));
}

// A country's states / provinces, by name; empty for the countries that aren't subdivided.
export function subdivisions(countryId: string, cat: Catalog = CATALOG): Pack[] {
  return cat.packs.filter((p) => p.parent === countryId).sort(byName);
}

export function findPack(id: string, cat: Catalog = CATALOG): Pack | undefined {
  return cat.packs.find((p) => p.id === id);
}

// What a set of packs adds up to. Sizes are only known for built packs, so the total covers the
// sized ones and `unsized` counts the rest — a caller shows "3 packs · 95 MB" rather than a total
// that silently leaves some out.
export interface Tally {
  packs: number;
  bytes: number;
  unsized: number;
}

export function tally(packs: Iterable<Pack>): Tally {
  const t: Tally = { packs: 0, bytes: 0, unsized: 0 };
  for (const p of packs) {
    t.packs += 1;
    if (p.bytes == null) t.unsized += 1;
    else t.bytes += p.bytes;
  }
  return t;
}

// The packs from `ids` that are downloaded, as a tally. `ids` scopes it: a continent's countries,
// a country's states, or the whole catalog.
export function downloadedTally(ids: Iterable<string>, downloaded: ReadonlySet<string>, cat: Catalog = CATALOG): Tally {
  const packs: Pack[] = [];
  for (const id of ids) {
    if (!downloaded.has(id)) continue;
    const pack = findPack(id, cat);
    if (pack) packs.push(pack);
  }
  return tally(packs);
}

// Every pack id under a country: the country itself and its subdivisions.
export function countryPackIds(countryId: string, cat: Catalog = CATALOG): string[] {
  return [countryId, ...subdivisions(countryId, cat).map((p) => p.id)];
}

// Every pack id in a continent, countries and their subdivisions alike.
export function continentPackIds(continent: Continent, cat: Catalog = CATALOG): string[] {
  return continent.countries.flatMap((c) => countryPackIds(c.id, cat));
}

// Name search over every pack, for the regions the user isn't standing in. Case- and
// accent-insensitive; a match at the start of the name ranks over one at the start of a later
// word, which ranks over one inside a word, so "wa" lists Washington before Botswana. Ties by
// name. A subdivision also matches its country's name ("united" finds the states too), after
// the packs matching on their own name.
export function searchPacks(query: string, limit = 12, cat: Catalog = CATALOG): Pack[] {
  const q = fold(query);
  if (!q) return [];
  const names = new Map(cat.packs.map((p) => [p.id, p.name]));
  const ranked: { pack: Pack; rank: number }[] = [];
  for (const pack of cat.packs) {
    const own = matchRank(fold(pack.name), q);
    const parent = pack.parent ? matchRank(fold(names.get(pack.parent) ?? ''), q) : Infinity;
    const rank = Math.min(own, parent === Infinity ? Infinity : parent + 3);
    if (rank !== Infinity) ranked.push({ pack, rank });
  }
  return ranked
    .sort((a, b) => a.rank - b.rank || byName(a.pack, b.pack))
    .slice(0, limit)
    .map((r) => r.pack);
}

function fold(s: string): string {
  return s.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().trim();
}

// 0 at the start, 1 at a word start, 2 anywhere, Infinity for no match.
function matchRank(name: string, q: string): number {
  const at = name.indexOf(q);
  if (at < 0) return Infinity;
  if (at === 0) return 0;
  return /[\s(\-]/.test(name[at - 1]) ? 1 : 2;
}

// Decimal megabytes, matching how the build logs and the stores quote download sizes. One decimal
// under 10 MB where a state pack can be 6.7 MB, whole numbers above; gigabytes past 1000 MB.
export function formatBytes(bytes: number): string {
  const mb = bytes / 1e6;
  if (mb >= 1000) return `${(mb / 1000).toFixed(mb >= 10_000 ? 0 : 1)} GB`;
  if (mb >= 10) return `${Math.round(mb)} MB`;
  return `${mb.toFixed(1)} MB`;
}

// "95 MB", "95 MB + 2 unsized", or "" when nothing in the tally has a size (the count stands alone).
export function formatTallyBytes(t: Tally): string {
  if (t.bytes === 0) return '';
  return t.unsized ? `${formatBytes(t.bytes)} + ${t.unsized} unsized` : formatBytes(t.bytes);
}
