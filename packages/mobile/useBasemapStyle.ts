import { useEffect, useMemo, useState } from 'react';
import { Asset } from 'expo-asset';
import { LogManager, type StyleSpecification } from '@maplibre/maplibre-react-native';
import { buildBasemapStyle, type ArchivePair } from './basemapStyle';
import { installedPacks, usePackState } from './packStore';

// A tile or archive fetch failing is normal operation for this map — offline (or with R2
// unreachable) the layout is DESIGNED to fall back to the bundled tier — but MapLibre logs every
// failed request at ERROR level, which the dev overlay turns into a red console error per tile.
// Swallow request-failure noise; let real errors (style parse, GL) through.
const NETWORK_NOISE = /failed with error|Connection appears to be offline|NSURLErrorDomain|UnknownHostException|Unable to resolve host|timed out/i;
LogManager.onLog((event) => {
  return event.level === 'error' && NETWORK_NOISE.test(event.message);
});

// The bundled global z6 archives, shipped as binary assets (metro.config.js registers the
// extension). downloadAsync resolves them to file:// paths — on iOS that's the app bundle; on
// Android it copies out of the APK's assets, which MapLibre needs since it can't range-read
// inside them. The copy is a one-time ~33 MB write, cached across launches.
const BUNDLED_BASE = require('./assets/basemap/global-z6-base.pmtiles');
const BUNDLED_HS = require('./assets/basemap/global-z6-hs.pmtiles');

// undefined = not resolved yet; null = resolution failed, map runs online-only.
let cachedBundled: ArchivePair | null | undefined;

async function resolveBundled(): Promise<ArchivePair | null> {
  try {
    // In a release build the assets are in the app binary and this is a local copy at most.
    // In a DEV build Metro serves assets over HTTP, so the very first resolve needs the dev
    // server reachable; after that the downloaded copy is cached on disk.
    const [base, hs] = await Asset.loadAsync([BUNDLED_BASE, BUNDLED_HS]);
    if (base.localUri && hs.localUri) {
      if (__DEV__) console.log(`bundled basemap: ${base.localUri} + ${hs.localUri}`);
      return { base: base.localUri, hs: hs.localUri };
    }
    throw new Error(`no localUri (base ${base.localUri}, hs ${hs.localUri})`);
  } catch (e) {
    // Online-only fallback. Loud in dev: a silently missing bundled tier looks like a subtly
    // broken offline mode rather than a load failure.
    console.warn(`bundled basemap unavailable, map is online-only: ${e}`);
    return null;
  }
}

// The map style: bundled tier + installed packs + online tier. Null only on the very first
// render while the bundled archives resolve; rebuilt whenever a pack is installed or removed.
export function useBasemapStyle(): StyleSpecification | null {
  const [bundled, setBundled] = useState(cachedBundled);
  const { installed } = usePackState();
  useEffect(() => {
    if (cachedBundled !== undefined) return;
    let live = true;
    resolveBundled().then((pair) => {
      cachedBundled = pair;
      if (live) setBundled(pair);
    });
    return () => {
      live = false;
    };
  }, []);
  return useMemo(() => {
    if (bundled === undefined) return null;
    return buildBasemapStyle(bundled ?? undefined, installedPacks());
  }, [bundled, installed]);
}
