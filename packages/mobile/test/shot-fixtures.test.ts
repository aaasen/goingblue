import { describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { isValidToken } from '@weather/protocol';

// The seed's files, read the way the native store reads them: inline manifest values directly,
// null entries from the overflow file named by the key's MD5.
let files = new Map<string, string>();
function readKey(key: string): string | null {
  const manifest = JSON.parse(files.get('manifest.json') ?? '{}') as Record<string, string | null>;
  if (!(key in manifest)) return null;
  return manifest[key] ?? files.get(createHash('md5').update(key, 'utf8').digest('hex')) ?? null;
}
vi.mock('@react-native-async-storage/async-storage', () => ({
  default: {
    getItem: async (k: string) => readKey(k),
    setItem: async () => {},
    removeItem: async () => {},
    multiRemove: async () => {},
  },
}));
vi.mock('react-native', () => ({ Platform: { OS: 'ios' } }));
// account.ts reads the dev-server host off expo-constants, which drags in expo-modules-core.
vi.mock('expo-constants', () => ({ default: { expoConfig: null } }));
vi.hoisted(() => { (globalThis as { __DEV__?: boolean }).__DEV__ = false; });

import { loadToken } from '../account';
import { decodeAny, loadStore } from '../cache';
import { loadAqiScale, loadDevice, loadTimeFormat, loadTwoMessages, loadUnits } from '../settings';
import { SEED_SETTINGS, SEED_TOKEN, SHOTS } from '../screenshots/shots.mjs';
import { buildSeed, loadFixtures, rebaseStart, requestCode, seedEntries, storageFiles } from '../scripts/shot-fixtures.mjs';

describe('screenshot seed', () => {
  it('the seed token is well formed', () => {
    expect(isValidToken(SEED_TOKEN)).toBe(true);
  });

  it('message codes are unique across the table', () => {
    const codes = SHOTS.flatMap((s) => s.requests.map((_, i) => requestCode(s, i)));
    expect(new Set(codes).size).toBe(codes.length);
    expect(Math.max(...codes)).toBeLessThan(128);
  });

  it('rebasing keeps the hour and lands within the day before now', () => {
    const recorded = Date.UTC(2026, 8, 4, 17);
    const now = Date.UTC(2026, 10, 20, 3, 25);
    const start = rebaseStart(recorded, now);
    expect(new Date(start).getUTCHours()).toBe(17);
    expect(now - start).toBeGreaterThanOrEqual(0);
    expect(now - start).toBeLessThan(86400000);
    expect(rebaseStart(recorded, recorded - 1000)).toBe(recorded);
  });

  it('large values leave the manifest for an overflow file', () => {
    const big = 'x'.repeat(2000);
    const out = storageFiles({ small: 'a', big });
    const manifest = JSON.parse(out.get('manifest.json')!);
    expect(manifest).toEqual({ small: 'a', big: null });
    expect(out.get(createHash('md5').update('big').digest('hex'))).toBe(big);
  });

  it('two slots on one code are refused', () => {
    const slot = { code: 3, context: { mode: 1, utcOffsetHours: 0, model: 0, vars: [], lat: 0, lon: 0, start: 0 }, label: '', requestedAt: 0, encoded: '', savedAt: 0 };
    expect(() => seedEntries([slot, { ...slot }])).toThrow(/code 3/);
  });

  // The end-to-end check, on whatever shots have been recorded: replay under the current codec,
  // then read the files back through the app's own loaders and decode every forecast.
  const fixtures = loadFixtures();
  it.skipIf(fixtures.length === 0)('the app reads back every seeded forecast and setting', async () => {
    const now = Date.now();
    files = await buildSeed(fixtures, now);

    expect(await loadToken()).toBe(SEED_TOKEN);
    expect(await loadUnits()).toEqual(JSON.parse(SEED_SETTINGS.display_unit_prefs));
    expect(await loadTimeFormat()).toBe(SEED_SETTINGS.time_format);
    expect(await loadAqiScale()).toBe(SEED_SETTINGS.aqi_scale);
    expect(await loadDevice()).toBe(SEED_SETTINGS.builder_device);
    expect(await loadTwoMessages()).toBe(true);

    const store = await loadStore(SEED_TOKEN);
    const expected = fixtures.reduce((n, f) => n + f.requests.length, 0);
    expect(store.slots).toHaveLength(expected);
    for (const slot of store.slots) {
      const msg = decodeAny(slot.encoded!, SEED_TOKEN);
      expect(msg.periods.length).toBeGreaterThan(0);
      expect(now - slot.context.start).toBeLessThan(86400000);
    }
  }, 60000);
});
