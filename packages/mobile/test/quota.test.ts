import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { QUOTA_FREE_FORECASTS } from '@weather/protocol';

const store = new Map<string, string>();
vi.mock('@react-native-async-storage/async-storage', () => ({
  default: {
    getItem: async (k: string) => store.get(k) ?? null,
    setItem: async (k: string, v: string) => { store.set(k, v); },
    removeItem: async (k: string) => { store.delete(k); },
    multiRemove: async (ks: string[]) => { for (const k of ks) store.delete(k); },
  },
}));
vi.mock('react-native', () => ({ Platform: { OS: 'ios' } }));
// account.ts reads the dev-server host off expo-constants, and the satellite state for its
// timeouts; neither native module parses under vitest.
vi.mock('expo-constants', () => ({ default: { expoConfig: null } }));
vi.mock('../modules/ultra-constrained', () => ({ isUltraConstrained: () => false }));
vi.hoisted(() => { (globalThis as { __DEV__?: boolean }).__DEV__ = false; });

import { fetchQuota, syncSubscription } from '../account';
import {
  currentQuota, effectiveQuota, isQuotaState, quotaLine, quotaStatus, storedQuota, subscriptionLine, utcMonth, type StoredQuota,
} from '../quota';
import { clearSettings, loadPendingAnnualSwitch, loadQuota, savePendingAnnualSwitch, saveQuota } from '../settings';

const OCT = new Date('2026-10-20T23:30:00Z');
const FRESH = { kind: 'free', remaining: QUOTA_FREE_FORECASTS } as const;
const stored = (state: StoredQuota['state'], month = '2026-10'): StoredQuota => ({ state, month });

describe('utcMonth', () => {
  it('is the UTC month, zero-padded', () => {
    expect(utcMonth(OCT)).toBe('2026-10');
    expect(utcMonth(new Date('2026-01-01T00:00:00Z'))).toBe('2026-01');
    // Late evening in the Americas is already next month in UTC.
    expect(utcMonth(new Date('2026-10-31T23:00:00-05:00'))).toBe('2026-11');
  });
});

describe('storedQuota', () => {
  it('stamps a state with the month it was heard for, not the month it was read', () => {
    // A reply to an October request pasted in November still describes October, so a fresh
    // November shows the full quota rather than October's exhausted one.
    const heard = storedQuota({ kind: 'over' }, new Date('2026-10-30T18:00:00Z'));
    expect(heard).toEqual({ state: { kind: 'over' }, month: '2026-10' });
    expect(currentQuota(heard, new Date('2026-11-02T12:00:00Z'))).toEqual(FRESH);
  });
});

describe('isQuotaState', () => {
  it('accepts the three states with remaining inside the field', () => {
    expect(isQuotaState({ kind: 'none' })).toBe(true);
    expect(isQuotaState({ kind: 'over' })).toBe(true);
    expect(isQuotaState({ kind: 'free', remaining: 0 })).toBe(true);
    expect(isQuotaState({ kind: 'free', remaining: QUOTA_FREE_FORECASTS })).toBe(true);
  });

  it('rejects anything else', () => {
    expect(isQuotaState(null)).toBe(false);
    expect(isQuotaState({ kind: 'free' })).toBe(false);
    expect(isQuotaState({ kind: 'free', remaining: QUOTA_FREE_FORECASTS + 1 })).toBe(false);
    expect(isQuotaState({ kind: 'free', remaining: 1.5 })).toBe(false);
    expect(isQuotaState({ kind: 'paid' })).toBe(false);
  });
});

describe('currentQuota', () => {
  it('starts a fresh month at the full quota', () => {
    expect(currentQuota(null, OCT)).toEqual(FRESH);
    expect(currentQuota(stored({ kind: 'free', remaining: 1 }, '2026-09'), OCT)).toEqual(FRESH);
    expect(currentQuota(stored({ kind: 'over' }, '2026-09'), OCT)).toEqual(FRESH);
  });

  it('keeps this month\'s state', () => {
    expect(currentQuota(stored({ kind: 'free', remaining: 2 }), OCT)).toEqual({ kind: 'free', remaining: 2 });
    expect(currentQuota(stored({ kind: 'over' }), OCT)).toEqual({ kind: 'over' });
  });

  it('keeps no quota across months', () => {
    expect(currentQuota(stored({ kind: 'none' }, '2026-03'), OCT)).toEqual({ kind: 'none' });
  });
});

describe('quotaLine', () => {
  it('counts the free forecasts left in the month, naming the route', () => {
    expect(quotaLine(null, OCT, 'SMS')).toBe('5 free SMS forecasts remaining in October. Subscribe for unlimited forecasts.');
    expect(quotaLine(stored({ kind: 'free', remaining: 1 }), OCT, 'inReach')).toBe('1 free inReach forecast remaining in October. Subscribe for unlimited forecasts.');
    expect(quotaLine(stored({ kind: 'free', remaining: 0 }), OCT, 'ZOLEO')).toBe('0 free ZOLEO forecasts remaining in October. Subscribe for unlimited forecasts.');
  });

  it('names the first of next month once the quota is used up, across the year end', () => {
    expect(quotaLine(stored({ kind: 'over' }), OCT, 'SMS')).toBe('Free SMS forecast limit exceeded. Limit resets November 1. Subscribe for unlimited forecasts.');
    const dec = new Date('2026-12-05T12:00:00Z');
    expect(quotaLine(stored({ kind: 'over' }, '2026-12'), dec, 'SMS')).toContain('Limit resets January 1.');
  });

  it('shows nothing for an account with no quota', () => {
    expect(quotaLine(stored({ kind: 'none' }), OCT, 'SMS')).toBeNull();
  });
});

describe('effectiveQuota', () => {
  it('shows the store\'s subscription over whatever the server last said', () => {
    expect(effectiveQuota(stored({ kind: 'over' }), true, OCT)).toEqual({ state: { kind: 'none' }, month: '2026-10' });
    expect(effectiveQuota(null, true, OCT)).toEqual({ state: { kind: 'none' }, month: '2026-10' });
  });

  it('otherwise shows the server\'s word', () => {
    expect(effectiveQuota(stored({ kind: 'over' }), false, OCT)).toEqual(stored({ kind: 'over' }));
    expect(effectiveQuota(null, false, OCT)).toBeNull();
  });
});

describe('quotaStatus', () => {
  const BULLETS = [
    'Unlimited weather forecasts via the internet.',
    'Unlimited avalanche forecasts.',
    '5 free SMS and satellite weather forecasts per month.',
  ];
  const FREE = 'You are not subscribed to Going Blue. The following features are available for free:';

  it('describes the free plan, with the month\'s standing out of the bullets', () => {
    expect(quotaStatus(null, OCT)).toEqual({
      name: 'Going Blue Free', bullets: BULLETS, text: FREE,
      standing: 'You have 5 free weather forecasts remaining in October.',
      subscribed: false,
    });
    expect(quotaStatus(stored({ kind: 'free', remaining: 1 }), OCT).standing)
      .toBe('You have 1 free weather forecast remaining in October.');
    expect(quotaStatus(stored({ kind: 'over' }), OCT)).toEqual({
      name: 'Going Blue Free', bullets: BULLETS, text: FREE,
      standing: 'You have used all of your free weather forecasts for October. The limit resets November 1.',
      subscribed: false,
    });
  });

  it('thanks a subscriber, with nothing to buy', () => {
    expect(quotaStatus(stored({ kind: 'none' }), OCT)).toEqual({
      name: 'Going Blue Expedition',
      bullets: [],
      text: 'You are subscribed to the Going Blue Expedition plan. Enjoy unlimited weather and avalanche '
        + 'forecasts via satellite. Thank you for supporting Going Blue!',
      standing: null,
      subscribed: true,
    });
  });
});

describe('stored quota', () => {
  beforeEach(() => store.clear());

  it('round-trips and is forgotten with the other settings', async () => {
    expect(await loadQuota()).toBeNull();
    await saveQuota(stored({ kind: 'free', remaining: 3 }));
    expect(await loadQuota()).toEqual(stored({ kind: 'free', remaining: 3 }));
    await clearSettings();
    expect(await loadQuota()).toBeNull();
  });

  it('keeps a pending switch to annual until it is cleared or the settings are', async () => {
    const at = new Date('2026-10-22T15:00:00Z');
    expect(await loadPendingAnnualSwitch()).toBeNull();
    await savePendingAnnualSwitch(at);
    expect(await loadPendingAnnualSwitch()).toEqual(at);
    await savePendingAnnualSwitch(null);
    expect(await loadPendingAnnualSwitch()).toBeNull();
    await savePendingAnnualSwitch(at);
    await clearSettings();
    expect(await loadPendingAnnualSwitch()).toBeNull();
  });

  it('drops a stored value it cannot read', async () => {
    store.set('quota', JSON.stringify({ state: { kind: 'free', remaining: 9 }, month: '2026-10' }));
    expect(await loadQuota()).toBeNull();
    store.set('quota', 'not json');
    expect(await loadQuota()).toBeNull();
  });
});

describe('fetchQuota', () => {
  afterEach(() => { vi.unstubAllGlobals(); });
  const TOKEN = 'ABCDEFGHJKMNPQRS';

  it('posts the token in the body and returns the state', async () => {
    const fetch = vi.fn(async () => new Response(JSON.stringify({ kind: 'free', remaining: 2 }), { status: 200 }));
    vi.stubGlobal('fetch', fetch);
    expect(await fetchQuota(TOKEN.toLowerCase())).toEqual({ kind: 'free', remaining: 2 });
    const [url, init] = fetch.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toMatch(/\/account\/quota$/);
    expect(init.method).toBe('POST');
    expect(JSON.parse(init.body as string)).toEqual({ token: TOKEN });
  });

  it('throws on an error status or a body that is not a quota', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('Unknown account', { status: 404 })));
    await expect(fetchQuota(TOKEN)).rejects.toThrow('Unknown account');
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ kind: 'free' }), { status: 200 })));
    await expect(fetchQuota(TOKEN)).rejects.toThrow('invalid quota');
  });
});

describe('subscriptionLine', () => {
  const ends = new Date('2026-11-21T15:00:00Z');

  it('names the plan and when it renews', () => {
    expect(subscriptionLine('annual', { ends, renews: true }))
      .toBe('You are on the annual plan. Your subscription will renew on November 21, 2026.');
    expect(subscriptionLine('monthly', { ends, renews: true }))
      .toBe('You are on the monthly plan. Your subscription will renew on November 21, 2026.');
  });

  it('says when a cancelled subscription ends', () => {
    expect(subscriptionLine('annual', { ends, renews: false }))
      .toBe('You are on the annual plan. Your subscription will end on November 21, 2026.');
  });

  it('says when a scheduled switch to annual takes effect, in place of the renewal', () => {
    expect(subscriptionLine('monthly', { ends, renews: true }, new Date('2026-10-22T15:00:00Z')))
      .toBe('You are on the monthly plan. Your subscription will switch to the annual plan on October 22, 2026.');
  });

  it('leaves out what it does not know', () => {
    expect(subscriptionLine(null, { ends, renews: true })).toBe('Your subscription will renew on November 21, 2026.');
    expect(subscriptionLine('monthly', null)).toBe('You are on the monthly plan.');
    expect(subscriptionLine(null, null)).toBeNull();
  });
});

describe('syncSubscription', () => {
  afterEach(() => { vi.unstubAllGlobals(); });
  const TOKEN = 'ABCDEFGHJKMNPQRS';

  it('posts the token to the sync route and returns the quota it answers with', async () => {
    const fetch = vi.fn(async () => new Response(JSON.stringify({ kind: 'none' }), { status: 200 }));
    vi.stubGlobal('fetch', fetch);
    expect(await syncSubscription(TOKEN.toLowerCase())).toEqual({ kind: 'none' });
    const [url, init] = fetch.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toMatch(/\/account\/subscription\/sync$/);
    expect(JSON.parse(init.body as string)).toEqual({ token: TOKEN });
  });

  it('throws on an error status, so the caller can fall back', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('Sync unavailable', { status: 503 })));
    await expect(syncSubscription(TOKEN)).rejects.toThrow('Sync unavailable');
  });
});
