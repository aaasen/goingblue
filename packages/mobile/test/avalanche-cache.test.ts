import { readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  avalancheAnchor, encodeAvalancheMessage, loadModels, partBodyChars, splitReply, WIRE_HEADER_CHARS,
  withPlaceholders, type AvalancheForecast, type RequestContext,
} from '@weather/protocol';

const storage = new Map<string, string>();
vi.mock('@react-native-async-storage/async-storage', () => ({
  default: {
    getItem: async (k: string) => storage.get(k) ?? null,
    setItem: async (k: string, v: string) => { storage.set(k, v); },
    removeItem: async (k: string) => { storage.delete(k); },
  },
}));

import {
  allocCode, attachResponse, decodeAny, loadStore, mergeReply, prunePastForecasts, replyKind,
  resolveContext, setAvalancheModels, type AvalancheContext,
} from '../cache';
import SEA_TO_SKY from '../fixtures/avalanche/sea-to-sky-2026-03-01.json';

const MODELS = loadModels(gunzipSync(readFileSync(new URL('../../protocol/assets/avcan-model.bin.gz', import.meta.url))));
const FORECAST = SEA_TO_SKY as AvalancheForecast;
const TOKEN = '0000000000000000';

const WEATHER: RequestContext = {
  model: 0, vars: new Set(), lat: 50.1163, lon: -122.9574, start: 490000 * 3600000, mode: 1, utcOffsetHours: -8,
};
const avalancheContext = (device: AvalancheContext['device']): AvalancheContext => ({
  kind: 'avalanche', lat: 50.1163, lon: -122.9574, start: 490000 * 3600000, day: '2026-03-01', device,
});
const anchorOf = (ctx: AvalancheContext) => avalancheAnchor(ctx.day, ctx.start / 3600000);

beforeEach(() => {
  storage.clear();
  setAvalancheModels(MODELS);
});

describe('avalanche requests in the forecast store', () => {
  it('share the code sequence with weather requests', async () => {
    const token = `${TOKEN}-seq`;
    expect(await allocCode(token, WEATHER, 'w')).toBe(0);
    expect(await allocCode(token, avalancheContext('g'), 'Avalanche')).toBe(1);
    expect(await allocCode(token, WEATHER, 'w')).toBe(2);
    // The weather resolver never hands the weather codec an avalanche request.
    expect(resolveContext(token, 1)).toBeUndefined();
    expect(resolveContext(token, 0)).toBeDefined();
  });

  it('survive a reload from storage', async () => {
    const token = `${TOKEN}-reload`;
    const ctx = avalancheContext('s');
    await allocCode(token, ctx, 'Avalanche');
    const stored = JSON.parse(storage.get(`forecast_store_v1:${token}`)!);
    expect(stored.slots[0].context).toEqual(ctx);
    const store = await loadStore(token);
    expect(store.slots[0].context).toEqual(ctx);
  });

  it('decode a reply by the kind of request its code names, undoing the inReach swap', async () => {
    const token = `${TOKEN}-decode`;
    const ctx = avalancheContext('g');
    const code = await allocCode(token, ctx, 'Avalanche');
    const reply = encodeAvalancheMessage(MODELS, code, anchorOf(ctx), FORECAST, 'base85');
    const swapped = reply.replace(/\$/g, '¤').replace(/@/g, '¡').replace(/_/g, '§');
    expect(swapped).not.toBe(reply);
    expect(replyKind(swapped, token)).toBe('avalanche');
    const decoded = decodeAny(swapped, token);
    expect(decoded).toEqual({
      kind: 'avalanche', code, forecast: { ...withPlaceholders(FORECAST), timezone: 'America/Vancouver' }, lat: 50.1163, lon: -122.9574,
    });
    const slots = await attachResponse(token, code, reply);
    expect(slots).toHaveLength(1);
    expect(await prunePastForecasts(token)).toHaveLength(1);
  });

  it('drop a saved reply that no longer decodes', async () => {
    const token = `${TOKEN}-prune`;
    const ctx = avalancheContext('g');
    const good = await allocCode(token, ctx, 'Avalanche');
    const bad = await allocCode(token, ctx, 'Avalanche');
    await attachResponse(token, good, encodeAvalancheMessage(MODELS, good, anchorOf(ctx), FORECAST, 'base85'));
    const reply = encodeAvalancheMessage(MODELS, bad, anchorOf(ctx), FORECAST, 'base85');
    const k = [...reply].findIndex((c, i) => i > WIRE_HEADER_CHARS && c !== reply[i + 1]);
    const corrupted = reply.slice(0, k) + reply[k + 1] + reply[k] + reply.slice(k + 2);
    await attachResponse(token, bad, corrupted);
    expect(() => decodeAny(corrupted, token)).toThrow();
    expect((await prunePastForecasts(token)).map((s) => s.code)).toEqual([good]);
  });

  it('collect a multi-part reply one message at a time', async () => {
    const token = `${TOKEN}-parts`;
    const ctx = avalancheContext('i');
    const code = await allocCode(token, ctx, 'Avalanche');
    const reply = encodeAvalancheMessage(MODELS, code, anchorOf(ctx), FORECAST, 'base32768');
    const parts = splitReply(reply, WIRE_HEADER_CHARS, partBodyChars('i', WIRE_HEADER_CHARS)!);
    expect(parts.length).toBeGreaterThan(1);
    expect(replyKind(parts[1], token)).toBe('avalanche');
    let held = '';
    for (const part of [...parts].reverse()) held = mergeReply(held, part, token);
    const decoded = decodeAny(held, token);
    expect(decoded.kind === 'avalanche' && decoded.forecast).toEqual({ ...withPlaceholders(FORECAST), timezone: 'America/Vancouver' });
  });

  it('know nothing about text that is not a reply', async () => {
    await allocCode(TOKEN, avalancheContext('s'), 'Avalanche');
    expect(replyKind('No avalanche forecast available', TOKEN)).toBeNull();
    expect(() => decodeAny('No avalanche forecast available', TOKEN)).toThrow();
  });
});
