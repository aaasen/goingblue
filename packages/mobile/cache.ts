import AsyncStorage from '@react-native-async-storage/async-storage';
import {
  avalancheAnchor, avalancheModelFile, chunkLines, collectingChunks, decodeMessage, fillSlotsFor, headForecast,
  maxFillSeq, mergeParts, peekHeader, readAvalancheReply, readParts, reassembleReply, WIRE_HEADER_CHARS,
  type AvalancheForecast, type BulletinHead, type DeviceCode, type ForecastMessage, type Models, type ReplyOracles,
  type RequestContext, type Variable,
} from '@weather/protocol';
import { bulletinTimezone } from './avalancheDisplay';
import MODEL_PINS from '../protocol/assets/models.json';

// The response is slim (see the protocol's message-code scheme): it omits lat/lon/models/vars/
// resolution and carries only a 7-bit `code`. We store each outgoing request's context under its
// code, so an incoming response can be matched back and decoded. The store is a ring of CODE_SPACE
// slots keyed by code — reusing a code (as the index cycles) evicts the old forecast in that slot.
// Weather and avalanche requests share the ring: every request of either kind takes the next code.

const STORE_KEY_PREFIX = 'forecast_store_v1:';
const CODE_SPACE = 128; // 7-bit message code, 0..127

// The bundled prose model, by the start of its pinned hash. Prose coded with one model reads only
// with that model.
export const PROSE_MODEL = MODEL_PINS['prose-model.bin'].sha256.slice(0, 16);

// What an avalanche request stored so its reply can be decoded: the point, the request time
// (`t:`) and the requested day (`y:`, null for the latest bulletin), which together give the
// anchor the reply's issue time is counted from, and the route, which gives the alphabet.
export interface AvalancheContext {
  kind: 'avalanche';
  lat: number;
  lon: number;
  start: number;
  day: string | null;
  device: DeviceCode;
}

export type SlotContext = RequestContext | AvalancheContext;

export function isAvalancheContext(ctx: SlotContext): ctx is AvalancheContext {
  return 'kind' in ctx && ctx.kind === 'avalanche';
}

export interface Slot {
  code: number;
  context: SlotContext;
  label: string;        // short request label captured at send time (e.g. location)
  requestedAt: number;
  encoded?: string;     // the response, once received
  savedAt?: number;     // when the response was attached
  proseModel?: string;  // avalanche: the prose model the response was read with
}

interface Store {
  nextCode: number;
  slots: Slot[];
}

// The persisted shape of a slot: JSON has no Set, so the context's vars travel as an array. A
// stored slot that doesn't match (one written under a different context shape) fails isStoredSlot
// and is dropped on load, the same expiry rule as a message that no longer decodes.
type StoredContext = (Omit<RequestContext, 'vars'> & { vars: string[] }) | AvalancheContext;
type StoredSlot = Omit<Slot, 'context'> & { context: StoredContext };

function storedSlot(s: Slot): StoredSlot {
  if (isAvalancheContext(s.context)) return { ...s, context: s.context };
  return { ...s, context: { ...s.context, vars: [...s.context.vars] } };
}

function revivedSlot(s: StoredSlot): Slot {
  if ('kind' in s.context) return { ...s, context: s.context };
  return { ...s, context: { ...s.context, vars: new Set(s.context.vars as Variable[]) } };
}

// In-memory mirror of the persisted store. Decoding is synchronous and must resolve a code to its
// context, so we keep the map in memory; callers load the store before decoding.
const memos = new Map<string, Store>();
const contextMaps = new Map<string, Map<number, SlotContext>>();

// The avalanche models by structured model file, each handed in once it has loaded (see
// avalancheModel.ts). Until then a reply coded with it can't be decoded, and the pruning below
// leaves its slots alone.
const avalancheModels = new Map<string, Models>();

export function setAvalancheModels(models: Models, file: string = 'avcan-structured.bin.gz'): void {
  avalancheModels.set(file, models);
}

const modelFileOf = (ctx: AvalancheContext) => avalancheModelFile(ctx.lat, ctx.lon);

function storeKey(token: string): string {
  return `${STORE_KEY_PREFIX}${token}`;
}

function isStoredSlot(x: unknown): x is StoredSlot {
  const s = x as StoredSlot;
  if (!s || typeof s.code !== 'number' || typeof s.label !== 'string' || !s.context) return false;
  if ('kind' in s.context) {
    const c = s.context;
    return c.kind === 'avalanche' && typeof c.lat === 'number' && typeof c.lon === 'number'
      && typeof c.start === 'number' && (c.day === null || typeof c.day === 'string')
      && typeof c.device === 'string';
  }
  return Array.isArray(s.context.vars) && s.context.vars.every((v) => typeof v === 'string');
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

// The stored request under a code, of either kind. Load the store first (loadStore) so the map
// is warm.
export function resolveSlotContext(token: string, code: number): SlotContext | undefined {
  return contextMaps.get(token)?.get(code);
}

// Synchronous resolver passed to the weather codec: weather requests only, so an avalanche reply
// given to it fails on its code rather than decoding as garbage.
export function resolveContext(token: string, code: number): RequestContext | undefined {
  const ctx = resolveSlotContext(token, code);
  return ctx && !isAvalancheContext(ctx) ? ctx : undefined;
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
    const stored = resolveSlotContext(token, code);
    if (!stored) return false;
    // An avalanche header carries no sequence to bound.
    if (isAvalancheContext(stored)) return true;
    const ctx = stored;
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

export type Decoded =
  | { kind: 'weather'; msg: ForecastMessage }
  // A bulletin read up to its prose, which decodeAvalanche reads; the point the request was made
  // for.
  | { kind: 'avalanche'; code: number; head: BulletinHead; lat: number; lon: number };

// Decodes a reply of either kind: the code in its header names the stored request, and the
// request says which kind of reply it is. Both headers keep the code in the same place. Throws
// for text that isn't a whole reply, so a bulletin still missing messages doesn't read as one.
export function decodeAny(encoded: string, token: string): Decoded {
  const reply = normalizeReply(encoded);
  const ctx = resolveSlotContext(token, peekHeader(reply).code);
  if (ctx && isAvalancheContext(ctx)) {
    const anchor = avalancheAnchor(ctx.day, ctx.start / 3600000);
    const { code, head } = readAvalancheReply(modelsOf(ctx).structured, reply, anchor, ctx.device);
    return { kind: 'avalanche', code, head, lat: ctx.lat, lon: ctx.lon };
  }
  return { kind: 'weather', msg: decodeMessage(reply, (code) => resolveContext(token, code)) };
}

function modelsOf(ctx: AvalancheContext): Models {
  const models = avalancheModels.get(modelFileOf(ctx));
  if (!models) throw new Error('The avalanche model has not loaded.');
  return models;
}

// A bulletin's forecast without its prose: what the structured fields alone say, such as the
// danger ratings.
export function bulletinOutline(d: Extract<Decoded, { kind: 'avalanche' }>): AvalancheForecast {
  return { ...headForecast(d.head), timezone: bulletinTimezone(d.lat, d.lon) };
}

// Decodes a whole avalanche reply, prose included. The prose model runs off the JS thread.
export async function decodeAvalanche(
  encoded: string, token: string,
): Promise<{ code: number; forecast: AvalancheForecast; lat: number; lon: number }> {
  const d = decodeAny(encoded, token);
  if (d.kind !== 'avalanche') throw new Error('Invalid forecast');
  const ctx = resolveSlotContext(token, d.code) as AvalancheContext;
  const texts = await modelsOf(ctx).prose.decode(d.head.prose, d.head.layout);
  // The wire leaves the zone out; the point's center says which one the bulletin is stamped in.
  const forecast = { ...headForecast(d.head, texts), timezone: bulletinTimezone(d.lat, d.lon) };
  return { code: d.code, forecast, lat: d.lat, lon: d.lon };
}

// Which kind of request a reply answers, read off the header of its first message, or null when
// the text doesn't start with a header of a request this device holds. Works on a reply still
// being collected: any labelled part repeats the header.
export function replyKind(encoded: string, token: string): 'weather' | 'avalanche' | null {
  const ctx = replyContext(encoded, token);
  return ctx ? (isAvalancheContext(ctx) ? 'avalanche' : 'weather') : null;
}

function replyContext(encoded: string, token: string): SlotContext | undefined {
  try {
    const { total, parts, unlabelled } = readParts(cleaned(encoded));
    const first = total > 0 ? parts.values().next().value : unlabelled.join('');
    return first ? resolveSlotContext(token, peekHeader(first).code) : undefined;
  } catch {
    return undefined;
  }
}

// The model file a reply needs, or null when it isn't an avalanche reply this device asked for.
export function replyModelFile(encoded: string, token: string): string | null {
  const ctx = replyContext(encoded, token);
  return ctx && isAvalancheContext(ctx) ? modelFileOf(ctx) : null;
}

// The model file a saved avalanche forecast needs, or null for a weather one.
export function slotModelFile(slot: Slot): string | null {
  return isAvalancheContext(slot.context) ? modelFileOf(slot.context) : null;
}

// The message code a decoded reply answers.
export function decodedCode(d: Decoded): number {
  return d.kind === 'weather' ? d.msg.code : d.code;
}

// Allocate the next message code, storing the request context under it (evicting whatever slot the
// code currently holds — old forecasts drop as the index cycles). Returns the code to embed as `k:`.
export async function allocCode(token: string, context: SlotContext, label: string): Promise<number> {
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
    if (isAvalancheContext(slot.context)) slot.proseModel = PROSE_MODEL;
    await persist(token, store);
  }
  return pastForecasts(store);
}

function pastForecasts(store: Store): Slot[] {
  return store.slots.filter((s) => s.encoded).sort((a, b) => b.requestedAt - a.requestedAt);
}

// Drop any received forecast that no longer decodes — e.g. one saved by a retired protocol
// version (support is dropped deliberately, see VERSIONING.md) or corrupted in storage, or an
// avalanche forecast saved under a different prose model, whose text can't be read. Past
// forecasts are a short-lived convenience buffer, so an entry we can't display is dead weight.
// Slots still awaiting a response (no `encoded` yet) are kept. Returns the surviving forecasts.
export async function prunePastForecasts(token: string): Promise<Slot[]> {
  const store = await loadStore(token);
  const before = store.slots.length;
  store.slots = store.slots.filter((s) => {
    if (!s.encoded) return true;
    if (isAvalancheContext(s.context) && s.proseModel !== PROSE_MODEL) return false;
    if (isAvalancheContext(s.context) && !avalancheModels.has(modelFileOf(s.context))) return true;
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

// Drop slots' responses and keep the requests they answered. A reply is still in the reader's
// messages, so pasting it again has to decode, which needs the context under its code.
export async function deleteResponses(token: string, codes: readonly number[]): Promise<Slot[]> {
  const store = await loadStore(token);
  for (const slot of store.slots) {
    if (!codes.includes(slot.code)) continue;
    delete slot.encoded;
    delete slot.savedAt;
    delete slot.proseModel;
  }
  await persist(token, store);
  return pastForecasts(store);
}
