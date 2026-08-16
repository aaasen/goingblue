import AsyncStorage from '@react-native-async-storage/async-storage';
import {
  CODECS, decodeMessage, mergeParts, peekVersion, readParts, reassembleReply, supportedVersions,
  type ForecastMessage, type RequestContext,
} from '@weather/protocol';

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

// Pasted text → the encoded message, whatever shape it arrived in: one message, or the numbered
// parts of a reply the iPhone route split (see parts.ts). Both live here so the decoder tab, the
// cache, and anything else that takes a paste agree on what counts as the same message.
//
// `fw:` comes off first: a forwarded message carries it ahead of everything, including a part
// label. Reassembly then handles whitespace, so nothing is stripped before the part labels — the
// space after "1/2" is what makes a label a label rather than a run of payload characters.
export function normalizeReply(encoded: string): string {
  return reassembleReply(encoded.trim().replace(/^fw:\s*/i, ''), headerCharsOf);
}

// The repeated header's width, read off a part's version tag. An unrecognized version falls back
// to the lowest codec this build carries; decoding then raises the version error properly, rather
// than reassembly failing first with something less useful.
function headerCharsOf(part: string): number {
  return (CODECS[peekVersion(part)] ?? CODECS[supportedVersions()[0]]).headerChars;
}

// Folds a newly pasted message into what is already in the decoder, so a reply that arrived as
// two messages can be pasted one at a time. Only another part of the SAME reply is appended;
// anything else replaces, so pasting an unrelated forecast still starts clean (see mergeParts).
export function mergeReply(existing: string, incoming: string): string {
  return mergeParts(existing.trim(), incoming.trim().replace(/^fw:\s*/i, ''), headerCharsOf);
}

// Which numbered messages a paste is carrying, for showing a reader collecting a multi-message
// reply what has arrived and what is still out there. `total` is 0 when the text carries no part
// labels at all, which is every single-message reply.
export function replyParts(encoded: string): { total: number; have: number[] } {
  const { total, parts } = readParts(encoded.trim().replace(/^fw:\s*/i, ''));
  return { total, have: [...parts.keys()].sort((a, b) => a - b) };
}

export function decodeAny(encoded: string, token: string): ForecastMessage {
  return decodeMessage(normalizeReply(encoded), (code) => resolveContext(token, code));
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
    slot.encoded = normalizeReply(encoded);
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

// Drop an account's whole store. Called on reset: the token is discarded there, so without this
// the store would sit in AsyncStorage forever under a key nothing can reach again.
export async function clearStore(token: string): Promise<void> {
  memos.delete(token);
  contextMaps.delete(token);
  try { await AsyncStorage.removeItem(storeKey(token)); } catch { /* ignore */ }
}

export async function deleteSlot(token: string, code: number): Promise<Slot[]> {
  const store = await loadStore(token);
  store.slots = store.slots.filter((s) => s.code !== code);
  await persist(token, store);
  return pastForecasts(store);
}
