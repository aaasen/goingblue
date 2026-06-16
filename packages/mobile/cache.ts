import AsyncStorage from '@react-native-async-storage/async-storage';
import { decodeMessage, type ForecastMessage } from '@weather/protocol';

const CACHE_KEY = 'past_forecasts';

export interface CacheEntry {
  encoded: string;
  savedAt: number;
}

/**
 * Decode an encoded forecast. The protocol's version tag is read up front and dispatched
 * to the matching codec; an unknown (e.g. newer) version throws a clear error.
 */
export function decodeAny(encoded: string): ForecastMessage {
  const text = encoded.replace(/\s/g, '').replace(/^fw:/i, '');
  return decodeMessage(text);
}

function isDecodable(encoded: string): boolean {
  try { decodeAny(encoded); return true; } catch { return false; }
}

export async function loadCache(): Promise<CacheEntry[]> {
  try {
    const raw = await AsyncStorage.getItem(CACHE_KEY);
    if (!raw) return [];
    const arr: unknown = JSON.parse(raw);
    if (!Array.isArray(arr)) return [];
    const valid: CacheEntry[] = [];
    let dirty = false;
    for (const item of arr) {
      if (
        typeof item !== 'object' || item === null ||
        typeof (item as CacheEntry).encoded !== 'string' ||
        typeof (item as CacheEntry).savedAt !== 'number'
      ) { dirty = true; continue; }
      if (isDecodable((item as CacheEntry).encoded)) valid.push(item as CacheEntry);
      else dirty = true;
    }
    if (dirty) await persistCache(valid);
    return valid;
  } catch {
    return [];
  }
}

async function persistCache(entries: CacheEntry[]): Promise<void> {
  try { await AsyncStorage.setItem(CACHE_KEY, JSON.stringify(entries)); } catch { /* ignore */ }
}

export async function addToCache(encoded: string): Promise<CacheEntry[]> {
  const text = encoded.replace(/\s/g, '').replace(/^fw:/i, '');
  if (!isDecodable(text)) return loadCache();
  const entries = (await loadCache()).filter((e) => e.encoded !== text);
  entries.unshift({ encoded: text, savedAt: Date.now() });
  await persistCache(entries);
  return entries;
}

export async function deleteFromCache(encoded: string): Promise<CacheEntry[]> {
  const entries = (await loadCache()).filter((e) => e.encoded !== encoded);
  await persistCache(entries);
  return entries;
}
