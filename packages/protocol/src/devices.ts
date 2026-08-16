import type { Alphabet } from "./codec.js";

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
  s: { alphabet: "base85", maxChars: SMS_MAX_CHARS },
  // ZOLEO accepts ~240 characters per message, but is served as SMS until that is measured the
  // way the iPhone path was; the code exists so the wire format doesn't need revisiting first.
  z: { alphabet: "base85", maxChars: SMS_MAX_CHARS },
  d: { alphabet: "base85", maxChars: SMS_MAX_CHARS },
  g: { alphabet: "base85", maxChars: SMS_MAX_CHARS },
};

export function isDeviceCode(value: unknown): value is DeviceCode {
  return typeof value === "string" && value in DEVICE_TRANSPORT;
}
