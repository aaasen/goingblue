import type { Alphabet } from "./codec.js";
import { PART_LABEL_CHARS } from "./parts.js";

// The device a request came from, carried as the request's `d:` token. It is the one knob that
// picks how a reply is written: each route is a different pipe, with its own character set and
// its own idea of how much of it fits, and the encoder has no other way to know which pipe it
// is writing into. A request without `d:` keeps the SMS defaults.
export type DeviceCode = "i" | "s" | "z" | "d" | "g";

export interface DeviceTransport {
  alphabet: Alphabet;
  // Cap on the whole encoded reply, in characters — version tag and header included, which is
  // what the encoder's fit search measures.
  maxChars: number;
}

// One 160-character SMS segment: the reply budget every device but iPhone spends, and the
// narrowest of them (inReach's limit), so it is the safe shared default.
export const SMS_MAX_CHARS = 160;

// One iPhone satellite bubble. Apple's relay frames a bubble at min(70 UTF-16 code units,
// ~140 bytes of compressed UTF-8) — both caps measured in the field, see docs/private/PROBES.md.
// The reply spends 5 ASCII characters on the version tag and packed header (5 bytes, 5 units),
// leaving 135 bytes; a k-character base32768 body costs 3k−1 bytes, so k = 45 fits at 139 bytes
// and 46 would split at 142. 50 characters total, 675 body bits.
//
// Why the wide alphabet is worth it here: base-85 hits the 70-unit cap first and carries 417
// body bits per bubble, base32768 hits the byte cap first and carries 675 — 1.62x, and it
// arrives as ONE bubble the reader pastes once, where a 160-character base-85 reply reaches an
// iPhone as three bubbles the relay never reassembles.
//
// Known headroom, deliberately unspent: a body that MIXED the two alphabets would saturate both
// caps at once (about 35 characters of each) and reach ~749 bits, but interleaving two alphabets
// through the body codec is not worth 6%.
export const IPHONE_MAX_CHARS = 50;

export const DEVICE_TRANSPORT: Record<DeviceCode, DeviceTransport> = {
  // iPhone messaging — the only route today whose pipe is wide enough to pay for base32768.
  i: { alphabet: "base32768", maxChars: IPHONE_MAX_CHARS },
  // SMS spends the whole of GSM-7 basic, not just its ASCII half: probe 13 carried all 39 of the
  // non-ASCII characters byte-exact to the phone, and probe 14 put 160 of them through as ONE
  // Twilio segment, so they cost a septet each exactly as the ASCII ones do. 6.954 bits a
  // character against 6.409 — a 155-character body goes 993 bits to 1078. See constants.ts for
  // the alphabet and what would be dropped if a route ever mangles it.
  s: { alphabet: "base124", maxChars: SMS_MAX_CHARS },
  // ZOLEO accepts ~240 characters per message, but is served as SMS until that is measured the
  // way the iPhone path was; the code exists so the wire format doesn't need revisiting first.
  z: { alphabet: "base85", maxChars: SMS_MAX_CHARS },
  d: { alphabet: "base85", maxChars: SMS_MAX_CHARS },
  g: { alphabet: "base85", maxChars: SMS_MAX_CHARS },
};

export function isDeviceCode(value: unknown): value is DeviceCode {
  return typeof value === "string" && value in DEVICE_TRANSPORT;
}

// The byte cap from the field measurements above. The 70-code-unit cap never binds a wide part —
// a part is 52 units — so only this one appears in the arithmetic.
const BUBBLE_BYTES = 140;
// Every base32768 character is three UTF-8 bytes (its last character is two, so this is an upper
// bound), and one UTF-16 code unit.
const WIDE_CHAR_BYTES = 3;

// How many messages a reply may be spread over. A reader has to paste each one, so this is a
// patience limit rather than a technical one.
export const MAX_MESSAGES = 4;

// Body characters that fit in ONE labelled part: the bubble's bytes, less the "i/N " label and the
// repeated header, divided among three-byte characters. With v2's 5-character header that is 43,
// so a part is 52 code units — well inside the 70-unit cap, which never binds here.
export function widePartBodyChars(headerChars: number): number {
  return Math.floor((BUBBLE_BYTES - PART_LABEL_CHARS - headerChars) / WIDE_CHAR_BYTES);
}

// The encoded length to aim for when a reply may span `messages` messages.
//
// The single-message case is deliberately NOT `messages × per-part`: one message carries no label
// and repeats no header, so it fits 45 body characters where each part of a split reply fits 43.
// Splitting therefore costs a little per part and wins overall — two messages carry 86 body
// characters (1290 bits) against one message's 45 (675), and past 1025 bits, which is what a full
// 160-character SMS holds.
export function maxCharsFor(code: DeviceCode, messages: number, headerChars: number): number {
  const transport = DEVICE_TRANSPORT[code];
  const n = Math.min(Math.max(Math.floor(messages) || 1, 1), MAX_MESSAGES);
  if (transport.alphabet !== "base32768") return n * transport.maxChars;
  if (n === 1) return transport.maxChars;
  return headerChars + n * widePartBodyChars(headerChars);
}
