import AsyncStorage from '@react-native-async-storage/async-storage';
import {
  chunkLines, collectingChunks, decodeMessage, fillSlotsFor, maxFillSeq, mergeParts,
  peekHeader, readParts, reassembleReply, WIRE_HEADER_CHARS,
  type ForecastMessage, type ReplyOracles, type RequestContext, type Variable,
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

// The persisted shape of a slot: JSON has no Set, so the context's vars travel as an array. A
// stored slot that doesn't match (one written under a different context shape) fails isStoredSlot
// and is dropped on load, the same expiry rule as a message that no longer decodes.
type StoredContext = Omit<RequestContext, 'vars'> & { vars: string[] };
type StoredSlot = Omit<Slot, 'context'> & { context: StoredContext };

function storedSlot(s: Slot): StoredSlot {
  return { ...s, context: { ...s.context, vars: [...s.context.vars] } };
}

function revivedSlot(s: StoredSlot): Slot {
  return { ...s, context: { ...s.context, vars: new Set(s.context.vars as Variable[]) } };
}

// In-memory mirror of the persisted store. Decoding is synchronous and must resolve a code to its
// context, so we keep the map in memory; callers load the store before decoding.
const memos = new Map<string, Store>();
const contextMaps = new Map<string, Map<number, RequestContext>>();

function storeKey(token: string): string {
  return `${STORE_KEY_PREFIX}${token}`;
}

function isStoredSlot(x: unknown): x is StoredSlot {
  const s = x as StoredSlot;
  return !!s && typeof s.code === 'number' && typeof s.label === 'string'
    && !!s.context && Array.isArray(s.context.vars)
    && s.context.vars.every((v) => typeof v === 'string');
}

function rebuild(token: string, store: Store): void {
  contextMaps.set(token, new Map(store.slots.map((s) => [s.code, s.context])));
}

export async function loadStore(token: string): Promise<Store> {
  let store = memos.get(token) ?? { nextCode: 0, slots: [] };
  try {
    const raw = await AsyncStorage.getItem(storeKey(token));
    if (raw) {
      const parsed = JSON.parse(raw) as { nextCode?: unknown; slots?: unknown[] };
      if (parsed && typeof parsed.nextCode === 'number' && Array.isArray(parsed.slots)) {
        store = { nextCode: parsed.nextCode, slots: parsed.slots.filter(isStoredSlot).map(revivedSlot) };
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
  const stored = { nextCode: store.nextCode, slots: store.slots.map(storedSlot) };
  try { await AsyncStorage.setItem(storeKey(token), JSON.stringify(stored)); } catch { /* ignore */ }
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
  return reassembleReply(cleaned(encoded), headerCharsOf);
}

function cleaned(encoded: string): string {
  return encoded.trim().replace(/^fw:\s*/i, '');
}

// The repeated header's width, a constant: this build speaks a single protocol version. A part
// with an unrecognized version tag still reassembles at this width, and decoding then raises the
// version error properly, rather than reassembly failing first with something less useful.
function headerCharsOf(_part: string): number {
  return WIRE_HEADER_CHARS;
}

// What the merge rules need to know about a reply that only this layer can answer: reading one
// takes the codec, and knowing whether the reader asked for it takes the store (see ReplyOracles).
function oraclesFor(token: string): ReplyOracles {
  return {
    headerCharsOf,
    decodes: (reply) => { try { decodeAny(reply, token); return true; } catch { return false; } },
    isHead: (chunk) => headOfStoredRequest(chunk, token),
  };
}

// Whether text begins a reply THIS device asked for: a well-formed header, for a request still in
// the store, claiming a sequence that request's mode can produce.
//
// Every clause earns its place by the same argument, and it isn't only about precision. A message
// failing any of them can never decode — not as a fragment, and not once every last piece of it
// has been pasted. Accepting one as the start of a collection would be a trap: the reader would
// work through their whole inbox to arrive at the error they'd have been shown immediately.
function headOfStoredRequest(chunk: string, token: string): boolean {
  try {
    const { code, seq } = peekHeader(cleaned(chunk));
    const ctx = resolveContext(token, code);
    if (!ctx) return false;
    // A context stored without an offset can't compute the slot cap; accept the uncapped bound
    // (decode is the final arbiter — an over-tight bound here would trap a valid reply).
    const seqBound = ctx.utcOffsetHours == null
      ? maxFillSeq(ctx.mode)
      : maxFillSeq(ctx.mode, fillSlotsFor(ctx.model, Math.floor(ctx.start / 3600000), ctx.utcOffsetHours));
    return seq <= seqBound;
  } catch {
    return false;
  }
}

// Folds a newly pasted message into what is already in the decoder, so a reply that arrived as
// several messages can be pasted one at a time. Only another message of the SAME reply is
// appended; anything else replaces, so pasting an unrelated forecast still starts clean. Labelled
// parts merge in any order; an unlabelled reply the transport split appends in paste order and is
// finished when it decodes (see mergeParts and mergeChunks).
export function mergeReply(existing: string, incoming: string, token: string): string {
  return mergeParts(existing.trim(), cleaned(incoming), oraclesFor(token));
}

// Which numbered messages a paste is carrying, for showing a reader collecting a multi-message
// reply what has arrived and what is still out there. `total` is 0 when the text carries no part
// labels at all, which is every single-message reply.
export function replyParts(encoded: string): { total: number; have: number[] } {
  const { total, parts } = readParts(cleaned(encoded));
  return { total, have: [...parts.keys()].sort((a, b) => a - b) };
}

// How many messages of an UNLABELLED reply are held so far, or 0 when the text isn't one being
// collected — because it decodes already, or because it never could. Nothing here says how many
// are still to come: an unlabelled reply doesn't know its own length, which is why the only test
// for a complete one is that it decodes.
export function chunksCollected(encoded: string, token: string): number {
  const text = cleaned(encoded);
  return collectingChunks(text, oraclesFor(token)) ? chunkLines(text).length : 0;
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
