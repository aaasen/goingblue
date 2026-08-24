import { Platform } from 'react-native';
import { Directory, File, Paths } from 'expo-file-system';
import { OfflineManager } from '@maplibre/maplibre-react-native';

// MapLibre's ambient tile cache: whatever the map fetched while online, kept in one SQLite file
// so the same area draws again without a connection. Capped at TILE_CACHE_MAX_BYTES (set at
// launch — the library's own default is 50 MB), least-recently-used evicted past that; this
// reports the file and empties it on request.
//
// There's no size call in the bindings, so the file is found where the native SDKs put it —
// iOS: Library/Application Support/<bundle id>/.mapbox/cache.db (the path MapLibre kept from
// its Mapbox days); Android: files/mbgl-offline.db. The bundle id varies by build variant, so
// the iOS lookup lists Application Support rather than naming it.

export const TILE_CACHE_MAX_BYTES = 500_000_000;

// Applied at launch: the cap persists in the cache database itself, but re-applying on every
// start is what keeps it in step with the constant.
export async function configureTileCache(): Promise<void> {
  try {
    await OfflineManager.setMaximumAmbientCacheSize(TILE_CACHE_MAX_BYTES);
  } catch {
    // The cache keeps whatever cap it had; nothing to tell the user.
  }
}

function cacheFile(): File | null {
  try {
    if (Platform.OS === 'android') {
      return new File(Paths.document, 'mbgl-offline.db');
    }
    const support = new Directory(Paths.document.uri.replace(/\/Documents\/?$/, '/Library/Application Support'));
    if (!support.exists) return null;
    for (const entry of support.list()) {
      if (!(entry instanceof Directory)) continue;
      const db = new File(entry, '.mapbox', 'cache.db');
      if (db.exists) return db;
    }
    return null;
  } catch {
    return null;
  }
}

// Bytes on disk, 0 when there is no cache file yet, null when it can't be read.
export async function tileCacheSize(): Promise<number | null> {
  try {
    const file = cacheFile();
    if (!file || !file.exists) return 0;
    return file.size ?? null;
  } catch {
    return null;
  }
}

export async function clearTileCache(): Promise<void> {
  await OfflineManager.clearAmbientCache();
}
