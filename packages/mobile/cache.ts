import AsyncStorage from '@react-native-async-storage/async-storage';
import { decodeMessage, type ForecastMessage, type RequestContext } from '@weather/protocol';

// The response is slim (see the protocol's message-code scheme): it omits lat/lon/models/vars/
// resolution and carries only a 7-bit `code`. We store each outgoing request's context under its
// code, so an incoming response can be matched back and decoded. The store is a ring of CODE_SPACE
// slots keyed by code — reusing a code (as the index cycles) evicts the old forecast in that slot.

const STORE_KEY = 'forecast_store_v1';
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
let memo: Store = { nextCode: 0, slots: [] };
let contextMap = new Map<number, RequestContext>();

function isSlot(x: unknown): x is Slot {
  const s = x as Slot;
  return !!s && typeof s.code === 'number' && typeof s.label === 'string'
    && !!s.context && typeof s.context.vars_mask === 'number';
}

function rebuild(): void {
  contextMap = new Map(memo.slots.map((s) => [s.code, s.context]));
}

export async function loadStore(): Promise<Store> {
  try {
    const raw = await AsyncStorage.getItem(STORE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as Partial<Store>;
      if (parsed && typeof parsed.nextCode === 'number' && Array.isArray(parsed.slots)) {
        memo = { nextCode: parsed.nextCode, slots: parsed.slots.filter(isSlot) };
      }
    }
  } catch { /* keep whatever's in memo */ }
  rebuild();
  return memo;
}

async function persist(): Promise<void> {
  rebuild();
  try { await AsyncStorage.setItem(STORE_KEY, JSON.stringify(memo)); } catch { /* ignore */ }
}

// Synchronous resolver passed to the codec. Load the store first (loadStore) so the map is warm.
export function resolveContext(code: number): RequestContext | undefined {
  return contextMap.get(code);
}

export function decodeAny(encoded: string): ForecastMessage {
  const text = encoded.replace(/\s/g, '').replace(/^fw:/i, '');
  return decodeMessage(text, resolveContext);
}

// Allocate the next message code, storing the request context under it (evicting whatever slot the
// code currently holds — old forecasts drop as the index cycles). Returns the code to embed as `k:`.
export async function allocCode(context: RequestContext, label: string): Promise<number> {
  await loadStore();
  const code = memo.nextCode % CODE_SPACE;
  memo.slots = memo.slots.filter((s) => s.code !== code);
  memo.slots.push({ code, context, label, requestedAt: Date.now() });
  memo.nextCode = (code + 1) % CODE_SPACE;
  await persist();
  return code;
}

// Attach a received response to its slot (matched by the code embedded in the message).
export async function attachResponse(code: number, encoded: string): Promise<Slot[]> {
  await loadStore();
  const slot = memo.slots.find((s) => s.code === code);
  if (slot) {
    slot.encoded = encoded.replace(/\s/g, '').replace(/^fw:/i, '');
    slot.savedAt = Date.now();
    await persist();
  }
  return pastForecasts();
}

function pastForecasts(): Slot[] {
  return memo.slots.filter((s) => s.encoded).sort((a, b) => (b.savedAt ?? 0) - (a.savedAt ?? 0));
}

// Received forecasts to display, most recent first.
export async function loadPastForecasts(): Promise<Slot[]> {
  await loadStore();
  return pastForecasts();
}

export async function deleteSlot(code: number): Promise<Slot[]> {
  await loadStore();
  memo.slots = memo.slots.filter((s) => s.code !== code);
  await persist();
  return pastForecasts();
}
