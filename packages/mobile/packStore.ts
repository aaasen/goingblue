import { useSyncExternalStore } from 'react';
import { createDownloadResumable, deleteAsync, documentDirectory, getInfoAsync, makeDirectoryAsync, moveAsync, type DownloadResumable } from 'expo-file-system/legacy';
import { getNetworkStateAsync } from 'expo-network';
import { BASEMAP_URL } from './basemapStyle';
import { findPack, type Pack } from './catalog';
import { loadDownloadedPacks, saveDownloadedPacks } from './offlineMaps';

// The packs this device actually holds: the files on disk, the downloads in flight, and the one
// subscription the map and the settings sheet share. An id only enters the installed set once
// both archives are on disk (offlineMaps.ts persists the ids; this store is the truth about the
// bytes). Packs live in Documents — they're user-managed data, re-downloadable but deliberate —
// and each archive downloads to a .part name and moves into place, so a killed app never leaves
// a partial file the map would then read.

const DIR = `${documentDirectory}basemap-packs`;

export interface InstalledPack {
  id: string;
  bounds: number[];
  base: string; // file:// URIs
  hs: string;
}

interface PackState {
  installed: ReadonlySet<string>;
  // Download progress by pack id, 0..1. A pack downloading is not yet installed.
  progress: ReadonlyMap<string, number>;
}

let state: PackState = { installed: new Set(), progress: new Map() };
const listeners = new Set<() => void>();
let initStarted = false;

function emit(next: Partial<PackState>) {
  state = { ...state, ...next };
  for (const l of listeners) l();
}

function fileUris(id: string): { base: string; hs: string } {
  return { base: `${DIR}/${id}-base.pmtiles`, hs: `${DIR}/${id}-hs.pmtiles` };
}

// Reconcile the persisted id set against the files actually on disk — an interrupted download
// or a cleared Documents folder must not leave the map pointing at missing archives.
async function init() {
  const ids = await loadDownloadedPacks();
  const present = new Set<string>();
  for (const id of ids) {
    const { base, hs } = fileUris(id);
    const [b, h] = await Promise.all([getInfoAsync(base), getInfoAsync(hs)]);
    if (b.exists && h.exists) present.add(id);
  }
  if (present.size !== ids.size) await saveDownloadedPacks(present);
  emit({ installed: present });
}

export function subscribePacks(listener: () => void): () => void {
  if (!initStarted) {
    initStarted = true;
    init().catch(() => {});
  }
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function getPackState(): PackState {
  return state;
}

// The installed packs as the style builder consumes them.
export function installedPacks(): InstalledPack[] {
  const packs: InstalledPack[] = [];
  for (const id of state.installed) {
    const pack = findPack(id);
    if (pack) packs.push({ id, bounds: pack.bounds, ...fileUris(id) });
  }
  return packs;
}

export function usePackState(): PackState {
  return useSyncExternalStore(subscribePacks, getPackState);
}

// How long without a progress callback before a download is declared stalled. downloadAsync
// never times out on its own: with no connectivity the OS task waits indefinitely, and the
// promise that never settles would leave the progress spinner up forever.
const STALL_MS = 20_000;

// The in-flight downloads by pack id, so a stalled or unwanted one can be called off. `cancelled`
// marks a deliberate cancel (a tap on the progress control), which cleans up quietly; a watchdog
// cancel is a failure and still throws.
const inFlight = new Map<string, { download: DownloadResumable | null; cancelled: boolean }>();

export function cancelDownload(id: string): void {
  const entry = inFlight.get(id);
  if (!entry) return;
  entry.cancelled = true;
  entry.download?.cancelAsync().catch(() => {});
}

// Both archives, sequentially, progress weighted by bytes across the pair (the catalog's
// per-pack total). Throws on failure with nothing half-installed; resolves quietly when the
// download was cancelled on purpose.
export async function downloadPack(pack: Pack): Promise<void> {
  if (state.installed.has(pack.id) || state.progress.has(pack.id)) return;
  emit({ progress: new Map(state.progress).set(pack.id, 0) });
  const entry: { download: DownloadResumable | null; cancelled: boolean } = { download: null, cancelled: false };
  inFlight.set(pack.id, entry);
  const { base, hs } = fileUris(pack.id);
  const total = pack.bytes ?? 0;
  let written = 0;
  // The OS can deliver a final progress callback after the download resolves; once settling
  // starts, late callbacks must not resurrect the progress entry (it would spin forever).
  let settled = false;
  let lastProgressAt = Date.now();
  const watchdog = setInterval(() => {
    if (Date.now() - lastProgressAt > STALL_MS) entry.download?.cancelAsync().catch(() => {});
  }, 5_000);
  try {
    // Airplane mode fails here in one round trip instead of waiting out the watchdog. Only a
    // definite "not connected" blocks: an unreadable network state is no reason not to try.
    const net = await getNetworkStateAsync().catch(() => null);
    if (net?.isConnected === false) throw new Error('offline');
    await makeDirectoryAsync(DIR, { intermediates: true }).catch(() => {});
    for (const [file, remote] of [[base, pack.files.base], [hs, pack.files.hs]] as const) {
      const before = written;
      const download = createDownloadResumable(`${BASEMAP_URL}/${remote}`, `${file}.part`, {}, (p) => {
        lastProgressAt = Date.now();
        if (settled) return;
        written = before + p.totalBytesWritten;
        const frac = Math.min(total > 0 ? written / total : 0, 0.999);
        // Whole-percent steps only: every emit re-renders the subscribers (the map included),
        // and the resumable callback fires many times a second.
        const last = state.progress.get(pack.id) ?? 0;
        if (frac - last < 0.01) return;
        emit({ progress: new Map(state.progress).set(pack.id, frac) });
      });
      entry.download = download;
      const result = await download.downloadAsync();
      if (entry.cancelled) throw new Error('cancelled');
      if (!result || result.status !== 200) throw new Error(`HTTP ${result?.status ?? 'failure'} for ${remote}`);
    }
    if (entry.cancelled) throw new Error('cancelled');
    settled = true;
    // Both parts are complete: land them and only then record the pack.
    await moveAsync({ from: `${base}.part`, to: base });
    await moveAsync({ from: `${hs}.part`, to: hs });
    const installed = new Set(state.installed).add(pack.id);
    await saveDownloadedPacks(installed);
    const progress = new Map(state.progress);
    progress.delete(pack.id);
    emit({ installed, progress });
  } catch (e) {
    settled = true;
    for (const f of [`${base}.part`, `${hs}.part`, base, hs]) {
      await deleteAsync(f, { idempotent: true }).catch(() => {});
    }
    const progress = new Map(state.progress);
    progress.delete(pack.id);
    emit({ progress });
    if (!entry.cancelled) throw e;
  } finally {
    clearInterval(watchdog);
    inFlight.delete(pack.id);
  }
}

export async function removePack(id: string): Promise<void> {
  const { base, hs } = fileUris(id);
  for (const f of [base, hs]) {
    await deleteAsync(f, { idempotent: true }).catch(() => {});
  }
  const installed = new Set(state.installed);
  installed.delete(id);
  await saveDownloadedPacks(installed);
  emit({ installed });
}
