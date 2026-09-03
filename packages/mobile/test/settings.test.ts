import { beforeEach, describe, expect, it, vi } from 'vitest';

// In-memory stand-in for the native store, so load/save can be exercised end to end.
const store = new Map<string, string>();
vi.mock('@react-native-async-storage/async-storage', () => ({
  default: {
    getItem: async (k: string) => store.get(k) ?? null,
    setItem: async (k: string, v: string) => { store.set(k, v); },
    multiRemove: async (ks: string[]) => { for (const k of ks) store.delete(k); },
  },
}));

// devices.ts reads Platform.OS to hide the iPhone route on Android; react-native itself doesn't
// parse under vitest.
vi.mock('react-native', () => ({ Platform: { OS: 'ios' } }));

import {
  applyUnitSystem, clearSettings, defaultUnitPrefs, loadTimeFormat, loadUnits, saveTimeFormat, saveUnits,
} from '../settings';

describe('unit preferences', () => {
  beforeEach(() => store.clear());

  it('the master switch sets every quantity to its system standard', () => {
    expect(defaultUnitPrefs('imperial')).toEqual({
      system: 'imperial', temp: 'f', rain: 'in', snow: 'in', wind: 'mph', altitude: 'ft', level: 'ft',
    });
    expect(defaultUnitPrefs('metric')).toEqual({
      system: 'metric', temp: 'c', rain: 'mm', snow: 'cm', wind: 'kmh', altitude: 'm', level: 'm',
    });
  });

  it('flipping the master moves standard units and leaves the rest alone', () => {
    const chosen = { ...defaultUnitPrefs('imperial'), wind: 'kt' as const, level: 'hpa' as const, temp: 'c' as const };
    expect(applyUnitSystem(chosen, 'metric')).toEqual({
      ...defaultUnitPrefs('metric'), wind: 'kt', level: 'hpa',
    });
    // Back again: °C was a standard unit, so it follows the switch; knots and hPa still don't.
    expect(applyUnitSystem(applyUnitSystem(chosen, 'metric'), 'imperial')).toEqual({
      ...defaultUnitPrefs('imperial'), wind: 'kt', level: 'hpa',
    });
  });

  it('round-trips through storage', async () => {
    const prefs = { ...defaultUnitPrefs('metric'), wind: 'bft' as const };
    await saveUnits(prefs);
    expect(await loadUnits()).toEqual(prefs);
  });

  it('seeds from the pre-per-quantity master switch, and defaults to US without one', async () => {
    store.set('display_units', 'metric');
    expect(await loadUnits()).toEqual(defaultUnitPrefs('metric'));
    store.clear();
    expect(await loadUnits()).toEqual(defaultUnitPrefs('imperial'));
  });

  it('falls back per field on a unit it no longer knows', async () => {
    store.set('display_unit_prefs', JSON.stringify({ system: 'metric', wind: 'furlongs', temp: 'f' }));
    expect(await loadUnits()).toEqual({ ...defaultUnitPrefs('metric'), temp: 'f' });
    store.set('display_unit_prefs', '{not json');
    expect(await loadUnits()).toEqual(defaultUnitPrefs('imperial'));
  });

  it('clearSettings forgets every stored preference', async () => {
    await saveUnits(defaultUnitPrefs('metric'));
    await saveTimeFormat('24h');
    store.set('display_units', 'metric');
    await clearSettings();
    expect(store.size).toBe(0);
    expect(await loadUnits()).toEqual(defaultUnitPrefs('imperial'));
    expect(await loadTimeFormat()).toBe('12h');
  });
});
