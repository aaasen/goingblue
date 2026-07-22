import AsyncStorage from '@react-native-async-storage/async-storage';
import { decodeMessage, type ForecastMessage, type RequestContext } from '@weather/protocol';

// The response is slim (see the protocol's message-code scheme): it omits lat/lon/models/vars/
// resolution and carries only a 7-bit `code`. We store each outgoing request's context under its
// code, so an incoming response can be matched back and decoded. The store is a ring of CODE_SPACE
// slots keyed by code — reusing a code (as the index cycles) evicts the old forecast in that slot.

const STORE_KEY_PREFIX = 'forecast_store_v1:';
const CODE_SPACE = 128; // 7-bit message code, 0..127

export interface Slot {
  code: number;
  context: RequestContext;
  label: string;        // short request label captured at send time (e.g. location)
  requestedAt: number;
  encoded?: string;     // the response, once received
  savedAt?: number;     // when the response was attached
}

interface Store {
  nextCode: number;
  slots: Slot[];
}

// In-memory mirror of the persisted store. Decoding is synchronous and must resolve a code to its
// context, so we keep the map in memory; callers load the store before decoding.
const memos = new Map<string, Store>();
const contextMaps = new Map<string, Map<number, RequestContext>>();

function storeKey(token: string): string {
  return `${STORE_KEY_PREFIX}${token}`;
}

function isSlot(x: unknown): x is Slot {
  const s = x as Slot;
  return !!s && typeof s.code === 'number' && typeof s.label === 'string'
    && !!s.context && typeof s.context.vars_mask === 'number';
}

function rebuild(token: string, store: Store): void {
  contextMaps.set(token, new Map(store.slots.map((s) => [s.code, s.context])));
}

export async function loadStore(token: string): Promise<Store> {
  let store = memos.get(token) ?? { nextCode: 0, slots: [] };
  try {
    const raw = await AsyncStorage.getItem(storeKey(token));
    if (raw) {
      const parsed = JSON.parse(raw) as Partial<Store>;
      if (parsed && typeof parsed.nextCode === 'number' && Array.isArray(parsed.slots)) {
        store = { nextCode: parsed.nextCode, slots: parsed.slots.filter(isSlot) };
      }
    }
  } catch { /* keep whatever is in memory for this account */ }
  memos.set(token, store);
  rebuild(token, store);
  return store;
}

async function persist(token: string, store: Store): Promise<void> {
  memos.set(token, store);
  rebuild(token, store);
  try { await AsyncStorage.setItem(storeKey(token), JSON.stringify(store)); } catch { /* ignore */ }
}

// Synchronous resolver passed to the codec. Load the store first (loadStore) so the map is warm.
export function resolveContext(token: string, code: number): RequestContext | undefined {
  return contextMaps.get(token)?.get(code);
}

export function decodeAny(encoded: string, token: string): ForecastMessage {
  const text = encoded.replace(/\s/g, '').replace(/^fw:/i, '');
  return decodeMessage(text, (code) => resolveContext(token, code));
}

// Allocate the next message code, storing the request context under it (evicting whatever slot the
// code currently holds — old forecasts drop as the index cycles). Returns the code to embed as `k:`.
export async function allocCode(token: string, context: RequestContext, label: string): Promise<number> {
  const store = await loadStore(token);
  const code = store.nextCode % CODE_SPACE;
  store.slots = store.slots.filter((s) => s.code !== code);
  store.slots.push({ code, context, label, requestedAt: Date.now() });
  store.nextCode = (code + 1) % CODE_SPACE;
  await persist(token, store);
  return code;
}

// Attach a received response to its slot (matched by the code embedded in the message).
export async function attachResponse(token: string, code: number, encoded: string): Promise<Slot[]> {
  const store = await loadStore(token);
  const slot = store.slots.find((s) => s.code === code);
  if (slot) {
    slot.encoded = encoded.replace(/\s/g, '').replace(/^fw:/i, '');
    slot.savedAt = Date.now();
    await persist(token, store);
  }
  return pastForecasts(store);
}

function pastForecasts(store: Store): Slot[] {
  return store.slots.filter((s) => s.encoded).sort((a, b) => b.requestedAt - a.requestedAt);
}

// Drop any received forecast that no longer decodes — e.g. one saved by a retired protocol
// version (support is dropped deliberately, see VERSIONING.md) or corrupted in storage. Past
// forecasts are a short-lived convenience buffer, so an entry we can't display is dead weight.
// Slots still awaiting a response (no `encoded` yet) are kept. Returns the surviving forecasts.
export async function prunePastForecasts(token: string): Promise<Slot[]> {
  const store = await loadStore(token);
  const before = store.slots.length;
  store.slots = store.slots.filter((s) => {
    if (!s.encoded) return true;
    try { decodeAny(s.encoded, token); return true; }
    catch { return false; }
  });
  if (store.slots.length !== before) await persist(token, store);
  return pastForecasts(store);
}

export async function deleteSlot(token: string, code: number): Promise<Slot[]> {
  const store = await loadStore(token);
  store.slots = store.slots.filter((s) => s.code !== code);
  await persist(token, store);
  return pastForecasts(store);
}
