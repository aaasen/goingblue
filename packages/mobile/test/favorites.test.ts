import { beforeEach, describe, expect, it, vi } from 'vitest';

const store = new Map<string, string>();
vi.mock('@react-native-async-storage/async-storage', () => ({
  default: {
    getItem: async (k: string) => store.get(k) ?? null,
    setItem: async (k: string, v: string) => { store.set(k, v); },
    multiRemove: async (ks: string[]) => { for (const k of ks) store.delete(k); },
  },
}));
vi.mock('react-native', () => ({ Platform: { OS: 'ios' } }));

import { formatLatLon, parseLatLon } from '../coords';
import {
  FAVORITES_KEY, editFavorite, findFavorite, kmBetween, loadFavorites, pastForecastPoints, removeFavorite, saveFavorites, sortFavorites,
  touchFavorite, upsertFavorite,
} from '../favorites';
import { clearSettings } from '../settings';

const DENALI = { lat: 63.0692, lon: -151.0070 };
const WHITNEY = { lat: 36.578581, lon: -118.291995 };

describe('favorites', () => {
  beforeEach(() => store.clear());

  it('stores the point at the precision points are written at', () => {
    const [f] = upsertFavorite([], WHITNEY, 'Whitney', 1);
    expect(f).toEqual({ lat: 36.57858, lon: -118.292, name: 'Whitney', usedAt: 1 });
  });

  it('selecting a favorite yields text that matches it', () => {
    const list = upsertFavorite([], WHITNEY, 'Whitney');
    const typed = parseLatLon(formatLatLon(list[0]));
    expect(findFavorite(list, typed)).toBe(list[0]);
    // The raw point it was saved from matches too, and a point a few meters off does not.
    expect(findFavorite(list, WHITNEY)).toBe(list[0]);
    expect(findFavorite(list, { lat: WHITNEY.lat + 0.0001, lon: WHITNEY.lon })).toBeUndefined();
    expect(findFavorite(list, null)).toBeUndefined();
  });

  it('a point that rounds to zero from below has one spelling', () => {
    const list = upsertFavorite([], { lat: -0.000001, lon: -0.000004 }, 'Null Island');
    expect(formatLatLon(list[0])).toBe('0.00000, 0.00000');
    expect(findFavorite(list, { lat: -0.000001, lon: -0.000004 })).toBe(list[0]);
  });

  it('saving a point again renames it and counts as a use', () => {
    let list = upsertFavorite([], DENALI, 'Summit', 1);
    list = upsertFavorite(list, DENALI, '  Denali ', 2);
    expect(list).toEqual([{ ...DENALI, name: 'Denali', usedAt: 2 }]);
  });

  it('editing rewrites the name and point and keeps the place in the recent order', () => {
    let list = upsertFavorite([], WHITNEY, 'Whitney', 1);
    list = upsertFavorite(list, DENALI, 'Denali', 2);
    const moved = { lat: 63.1, lon: -151.1 };
    const edited = editFavorite(list, list[0], moved, ' Denali North ');
    expect(edited).toEqual([{ ...moved, name: 'Denali North', usedAt: 2 }, { lat: 36.57858, lon: -118.292, name: 'Whitney', usedAt: 1 }]);
    expect(findFavorite(edited, DENALI)).toBeUndefined();
    // Moved onto another favorite, the edit takes that one's place.
    const merged = editFavorite(list, list[0], WHITNEY, 'Denali');
    expect(merged).toEqual([{ lat: 36.57858, lon: -118.292, name: 'Denali', usedAt: 2 }]);
  });

  it('selecting a favorite moves it to the top of the recent order', () => {
    let list = upsertFavorite([], WHITNEY, 'Whitney', 1);
    list = upsertFavorite(list, DENALI, 'Denali', 2);
    const touched = touchFavorite(list, WHITNEY, 3);
    expect(sortFavorites(touched, 'recent', null).map((f) => f.name)).toEqual(['Whitney', 'Denali']);
    // The stored order stays alphabetical, and the caller's list is left alone.
    expect(touched.map((f) => f.name)).toEqual(['Denali', 'Whitney']);
    expect(list.find((f) => f.name === 'Whitney')!.usedAt).toBe(1);
  });

  it('lists alphabetically, ignoring case and reading numbers as numbers', () => {
    let list = upsertFavorite([], { lat: 2, lon: 2 }, 'camp 10', 1);
    list = upsertFavorite(list, { lat: 3, lon: 3 }, 'Camp 2', 2);
    list = upsertFavorite(list, { lat: 5, lon: 5 }, 'Basin', 3);
    expect(list.map((f) => f.name)).toEqual(['Basin', 'Camp 2', 'camp 10']);
  });

  it('sorts by name, last used first, or nearest first', () => {
    let list = upsertFavorite([], WHITNEY, 'Whitney', 1);
    list = upsertFavorite(list, DENALI, 'Denali', 2);
    list = upsertFavorite(list, { lat: 37.0944, lon: -118.5145 }, 'North Palisade', 3);
    const names = (l: { name: string }[]) => l.map((f) => f.name);
    expect(names(sortFavorites(list, 'name', null))).toEqual(['Denali', 'North Palisade', 'Whitney']);
    expect(names(sortFavorites(list, 'recent', null))).toEqual(['North Palisade', 'Denali', 'Whitney']);
    // From Bishop, the Palisades are closer than Whitney, and Denali is a continent away.
    const bishop = { lat: 37.3614, lon: -118.3997 };
    expect(names(sortFavorites(list, 'distance', bishop))).toEqual(['North Palisade', 'Whitney', 'Denali']);
    // No fix yet: the stored order, and never the caller's array.
    expect(names(sortFavorites(list, 'distance', null))).toEqual(names(list));
    expect(sortFavorites(list, 'name', null)).not.toBe(list);
    expect(names(sortFavorites(list, 'name', null, true))).toEqual(['Whitney', 'North Palisade', 'Denali']);
    expect(names(sortFavorites(list, 'recent', null, true))).toEqual(['Whitney', 'Denali', 'North Palisade']);
    expect(names(sortFavorites(list, 'distance', bishop, true))).toEqual(['Denali', 'Whitney', 'North Palisade']);
  });

  it('measures great-circle distance', () => {
    expect(kmBetween(WHITNEY, WHITNEY)).toBe(0);
    // Whitney to Denali is about 3,620 km.
    expect(kmBetween(WHITNEY, DENALI)).toBeGreaterThan(3550);
    expect(kmBetween(WHITNEY, DENALI)).toBeLessThan(3700);
  });

  it('removes by point', () => {
    const list = upsertFavorite(upsertFavorite([], DENALI, 'Denali'), WHITNEY, 'Whitney');
    expect(removeFavorite(list, WHITNEY).map((f) => f.name)).toEqual(['Denali']);
  });

  it('marks each saved forecast point once, and leaves favorites to their stars', () => {
    const favorites = upsertFavorite([], DENALI, 'Denali');
    const nearWhitney = { lat: WHITNEY.lat + 0.000001, lon: WHITNEY.lon };
    const other = { lat: 45.8326, lon: 6.8652 };
    expect(pastForecastPoints([WHITNEY, DENALI, nearWhitney, other], favorites)).toEqual([WHITNEY, other]);
    expect(pastForecastPoints([], favorites)).toEqual([]);
  });

  it('round-trips through storage and drops entries it cannot read', async () => {
    const list = upsertFavorite(upsertFavorite([], DENALI, 'Denali', 1), WHITNEY, 'Whitney', 2);
    await saveFavorites(list);
    expect(await loadFavorites()).toEqual(list);

    store.set(FAVORITES_KEY, JSON.stringify([
      ...list, { name: 'Nowhere', lat: 91, lon: 0, usedAt: 3 }, { name: '', lat: 1, lon: 1, usedAt: 4 }, 'junk',
    ]));
    expect(await loadFavorites()).toEqual(list);
    store.set(FAVORITES_KEY, JSON.stringify([{ ...DENALI, name: 'Denali' }]));
    expect(await loadFavorites()).toEqual([{ ...DENALI, name: 'Denali', usedAt: 0 }]);
    store.set(FAVORITES_KEY, '{not json');
    expect(await loadFavorites()).toEqual([]);
  });

  it('account deletion forgets them', async () => {
    await saveFavorites(upsertFavorite([], DENALI, 'Denali'));
    await clearSettings();
    expect(store.size).toBe(0);
  });
});
