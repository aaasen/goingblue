import AsyncStorage from '@react-native-async-storage/async-storage';
import { findPack } from './catalogue';

// Which map packs this device holds, by catalogue id. Nothing downloads yet — the packs aren't
// published — so for now an id lands here the moment it's chosen and the list is the whole of
// the feature. The downloader, when it exists, is what moves an id in here after the files are
// on disk; the map's pack stacks and Settings both read this set.

const PACKS_KEY = 'offline_map_packs';

export async function loadDownloadedPacks(): Promise<Set<string>> {
  try {
    const raw = await AsyncStorage.getItem(PACKS_KEY);
    const ids: unknown = raw ? JSON.parse(raw) : [];
    // Ids the catalogue no longer lists (a pack renamed between builds) drop out rather than
    // sit in the set forever with nothing to show for them.
    return new Set(Array.isArray(ids) ? ids.filter((id): id is string => typeof id === 'string' && !!findPack(id)) : []);
  } catch {
    return new Set();
  }
}

export async function saveDownloadedPacks(ids: ReadonlySet<string>): Promise<void> {
  try { await AsyncStorage.setItem(PACKS_KEY, JSON.stringify([...ids])); } catch { /* ignore */ }
}
