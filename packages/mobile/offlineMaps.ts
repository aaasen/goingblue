import AsyncStorage from '@react-native-async-storage/async-storage';
import { findPack } from './catalog';

// Which map packs this device holds, by catalog id — the persisted half of packStore.ts, which
// only writes an id here after both archives are on disk and reconciles the set against the
// files at startup. The map's pack stacks and Settings read it through the store.

const PACKS_KEY = 'offline_map_packs';

export async function loadDownloadedPacks(): Promise<Set<string>> {
  try {
    const raw = await AsyncStorage.getItem(PACKS_KEY);
    const ids: unknown = raw ? JSON.parse(raw) : [];
    // Ids the catalog no longer lists (a pack renamed between builds) drop out rather than
    // sit in the set forever with nothing to show for them.
    return new Set(Array.isArray(ids) ? ids.filter((id): id is string => typeof id === 'string' && !!findPack(id)) : []);
  } catch {
    return new Set();
  }
}

export async function saveDownloadedPacks(ids: ReadonlySet<string>): Promise<void> {
  try { await AsyncStorage.setItem(PACKS_KEY, JSON.stringify([...ids])); } catch { /* ignore */ }
}
