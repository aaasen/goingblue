import { describe, it, expect } from 'vitest';
import {
  CATALOG, continentPackIds, continents, countryPackIds, downloadedTally, formatBytes,
  formatTallyBytes, subdivisions, tally, type Catalog, type Pack,
} from '../catalog';

// The bundled catalog is the driver's output for the tracked Natural Earth polygons; these pin
// the shape the screen relies on, so a rebuilt file that drops a field fails here, not on device.
describe('bundled catalog', () => {
  it('lists the world to z6 and packs to z10', () => {
    expect(CATALOG.bundled.maxzoom).toBe(6);
    expect(CATALOG.maxzoom).toBe(10);
    expect(CATALOG.packs.length).toBeGreaterThan(300);
    for (const p of CATALOG.packs) {
      expect(p.maxzoom).toBe(p.id === 'us' || p.id === 'ca' ? 9 : 10);
      expect(p.continent).toBeTruthy();
      expect(p.bounds).toHaveLength(4);
    }
  });

  it('subdivides exactly the US and Canada', () => {
    const parents = new Set(CATALOG.packs.filter((p) => p.parent).map((p) => p.parent));
    expect([...parents].sort()).toEqual(['ca', 'us']);
    expect(subdivisions('us')).toHaveLength(51);
    expect(subdivisions('ca')).toHaveLength(13);
    expect(subdivisions('fr')).toHaveLength(0);
  });

  it('groups countries by continent, islands last, everything by name', () => {
    const list = continents();
    expect(list.map((c) => c.name)).toEqual([
      'Africa', 'Antarctica', 'Asia', 'Europe', 'North America', 'Oceania', 'South America', 'Ocean islands',
    ]);
    const europe = list.find((c) => c.name === 'Europe')!;
    expect(europe.countries.map((c) => c.name)).toEqual([...europe.countries.map((c) => c.name)].sort((a, b) => a.localeCompare(b)));
    expect(europe.countries.every((c) => c.parent === null)).toBe(true);
    const na = list.find((c) => c.name === 'North America')!;
    expect(na.countries.map((c) => c.id)).toContain('us');
    expect(continentPackIds(na)).toContain('us-ak');
    expect(countryPackIds('us')).toHaveLength(52);
  });
});

const pack = (id: string, bytes: number | null, parent: string | null = null): Pack => ({
  id, name: id, continent: 'Test', parent, maxzoom: 10, bounds: [0, 0, 1, 1], bytes,
  files: { base: `packs/${id}-base.pmtiles`, hs: `packs/${id}-hs.pmtiles` },
});
const cat: Catalog = {
  ...CATALOG,
  packs: [pack('aa', 66_000_000), pack('bb', null), pack('aa-x', 8_500_000, 'aa'), pack('aa-y', 6_700_000, 'aa')],
};

describe('tallies', () => {
  it('totals sized packs and counts the unsized', () => {
    expect(tally(cat.packs)).toEqual({ packs: 4, bytes: 81_200_000, unsized: 1 });
  });

  it('scopes downloads to the ids given', () => {
    const downloaded = new Set(['aa-x', 'bb', 'zz']);
    expect(downloadedTally(countryPackIds('aa', cat), downloaded, cat)).toEqual({ packs: 1, bytes: 8_500_000, unsized: 0 });
    expect(downloadedTally(['bb'], downloaded, cat)).toEqual({ packs: 1, bytes: 0, unsized: 1 });
    // An id the catalog doesn't list counts for nothing.
    expect(downloadedTally(downloaded, downloaded, cat).packs).toBe(2);
  });
});

describe('formatting', () => {
  it('quotes decimal megabytes the way the build log does', () => {
    expect(formatBytes(6_700_000)).toBe('6.7 MB');
    expect(formatBytes(66_000_000)).toBe('66 MB');
    expect(formatBytes(2_271_371)).toBe('2.3 MB');
    expect(formatBytes(3_400_000_000)).toBe('3.4 GB');
    expect(formatBytes(12_000_000_000)).toBe('12 GB');
  });

  it('leaves the size off a tally with nothing sized', () => {
    expect(formatTallyBytes({ packs: 2, bytes: 0, unsized: 2 })).toBe('');
    expect(formatTallyBytes({ packs: 2, bytes: 95_000_000, unsized: 0 })).toBe('95 MB');
    expect(formatTallyBytes({ packs: 3, bytes: 95_000_000, unsized: 1 })).toBe('95 MB + 1 unsized');
  });
});
