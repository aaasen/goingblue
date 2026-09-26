/**
 * An avalanche reply on the wire: the shared version prefix, a packed header the same width as a
 * weather reply's, and the bulletin bytes (bulletin.ts) in the route's body alphabet.
 *
 * Packed header layout (22 bits, 4 base-85 characters):
 *   code:7 issue:15
 * The code sits exactly where the weather header keeps it, so a reader resolves the stored
 * request, and with it the reply's kind, before knowing anything else about the layout.
 * `issue` is the bulletin's issue time in 15-minute steps before the anchor, offset by
 * ISSUE_AFTER_STEPS so a bulletin issued up to two days after the anchor still fits: about 339
 * days back, which covers the seasonal placeholders that stay current for months. The anchor is
 * the requested day at ANCHOR_HOUR UTC, or the request time when the reader asked for the latest
 * bulletin; both ends know it from the request.
 */
import type { AvalancheForecast } from "../avalanche.js";
import { putInt, takeInt } from "../bits.js";
import { decode, decodeBodyAuto, encode, encodeBodyLE, encodeBodyWide, type Alphabet } from "../codec.js";
import { foldSeptetSwap } from "../constants.js";
import { DEVICE_TRANSPORT, type DeviceCode } from "../devices.js";
import { VERSION_PREFIX_CHARS, encodeVersion, takeVersion } from "../version.js";
import { WIRE_HEADER_BITS, WIRE_HEADER_CHARS, WIRE_VERSION } from "../wire.js";
import { decodeBulletin, encodeBulletin, type Models } from "./bulletin.js";
import { ISSUE_STEP_MS, quantizeIssued } from "./time.js";

const CODE_BITS = 7;
const ISSUE_BITS = WIRE_HEADER_BITS - CODE_BITS; // 15
export const ISSUE_AFTER_STEPS = (48 * 60 * 60 * 1000) / ISSUE_STEP_MS;
const ISSUE_MAX = (1 << ISSUE_BITS) - 1;

// The UTC hour a requested day is read at. It falls on that day in every Canadian time zone,
// after any morning update and before the next day's bulletin is issued.
export const ANCHOR_HOUR = 19;

// The instant the bulletin is chosen for: the requested day ("YYYY-MM-DD") at ANCHOR_HOUR UTC, or
// the request time (UTC hours since the epoch) for the latest bulletin.
export function avalancheAnchor(day: string | null | undefined, startEpochHour: number): number {
  return day ? Date.parse(`${day}T${String(ANCHOR_HOUR).padStart(2, "0")}:00:00Z`) : startEpochHour * 3600000;
}

export function encodeAvalancheMessage(
  models: Models, code: number, anchor: number, forecast: AvalancheForecast, alphabet: Alphabet = "base85",
): string {
  const field = (anchor - quantizeIssued(forecast.issued)) / ISSUE_STEP_MS + ISSUE_AFTER_STEPS;
  if (!Number.isInteger(field) || field < 0 || field > ISSUE_MAX) {
    throw new Error(`avalanche: issue time ${new Date(forecast.issued).toISOString()} is out of the header's range`);
  }
  const header: number[] = [];
  putInt(header, code, CODE_BITS);
  putInt(header, field, ISSUE_BITS);
  const bytes = encodeBulletin(models, forecast);
  const bits: number[] = [];
  for (const b of bytes) for (let i = 0; i < 8; i++) bits.push((b >> i) & 1);
  const body = alphabet === "base32768" ? encodeBodyWide(bits) : encodeBodyLE(bits, alphabet);
  return encodeVersion(WIRE_VERSION) + encode(header) + body;
}

export function decodeAvalancheMessage(
  models: Models, s: string, anchor: number, alphabet?: Alphabet,
): { code: number; forecast: AvalancheForecast } {
  const [version, rest] = takeVersion(s);
  if (version !== WIRE_VERSION) throw new Error(`Version mismatch: encoded v${version}, expected v${WIRE_VERSION}`);
  const headerChars = WIRE_HEADER_CHARS - VERSION_PREFIX_CHARS;
  if (rest.length < headerChars) throw new Error(`Unexpected message length: ${s.length} chars`);
  const header = decode(rest.slice(0, headerChars), WIRE_HEADER_BITS);
  const [code, pos] = takeInt(header, 0, CODE_BITS);
  const [field] = takeInt(header, pos, ISSUE_BITS);
  const issued = anchor - (field - ISSUE_AFTER_STEPS) * ISSUE_STEP_MS;
  const bits = decodeBodyAuto(rest.slice(headerChars), alphabet);
  const bytes = new Uint8Array(Math.ceil(bits.length / 8));
  bits.forEach((bit, i) => { if (bit) bytes[i >> 3] |= 1 << (i & 7); });
  return { code, forecast: decodeBulletin(models, bytes, issued) };
}

// A reply as a reader pasted it, decoded for the route its request left by. The inReach display
// swap is undone the way decodeMessage undoes it for weather: always on the base-85 prefix, and
// on the body unless the route is SMS, whose base-124 alphabet spends the swapped characters as
// themselves.
export function decodeAvalancheReply(
  models: Models, s: string, anchor: number, device: DeviceCode | undefined,
): { code: number; forecast: AvalancheForecast } {
  const alphabet = device ? DEVICE_TRANSPORT[device].alphabet : undefined;
  const prefix = foldSeptetSwap(s.slice(0, WIRE_HEADER_CHARS));
  const body = s.slice(WIRE_HEADER_CHARS);
  return decodeAvalancheMessage(models, prefix + (alphabet === "base124" ? body : foldSeptetSwap(body)), anchor, alphabet);
}
