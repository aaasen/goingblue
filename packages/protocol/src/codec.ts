import { encode as wideEncode, decode as wideDecode } from "base32768";
import { ALPHABET, WMO_BITS } from "./constants.js";

// The encoding radix is simply the alphabet size (see constants.ts).
const BASE = ALPHABET.length;
const BASE_BIG = BigInt(BASE);

// Which character set a message body is written in. base-85 is the GSM-7-safe default every
// transport understands; base32768 is spent only where a wide alphabet survives the pipe and
// pays for itself, which today means iPhone messaging over Apple's satellite relay (see
// devices.ts for the measurement that decides this). The version tag and packed header are
// ALWAYS base-85 — four ASCII header chars cost 4 bytes where the same bits cost 6 in
// base32768, and keeping them ASCII lets version dispatch read a wide message unchanged.
export type Alphabet = "base85" | "base32768";

export function nCharsForBits(nBits: number): number {
  if (nBits === 0) return 0;
  return Math.ceil((nBits * Math.log(2)) / Math.log(BASE));
}

export function periodBitsForMask(varsMask: number, varBits: number[]): number {
  let bits = WMO_BITS;
  for (let i = 0; i < varBits.length; i++) {
    if (varsMask & (1 << i)) bits += varBits[i];
  }
  return bits;
}

const A2I: Record<string, number> = Object.fromEntries(
  [...ALPHABET].map((c, i) => [c, i]),
);

// A character the alphabet doesn't contain is a corrupt message, not something to read past.
// Every base-85 decode below goes through this, because both of the ways of carrying on are
// silent: skipping the character shifts every later digit down a place, and reading it as zero
// rewrites one digit and leaves the length intact. Either way a damaged message yields a
// plausible forecast instead of an error, and nothing downstream can tell.
//
// Which is not hypothetical. Probe 13 (2026-08-16, docs/private/PROBES.md round 3) found a hop
// on the inbound SMS leg that deterministically turns the ten Greek characters of GSM-7 into C1
// controls; the same transcode on somebody's outbound leg is exactly this failure. Naming the
// character and where it sits is what makes the next such report diagnosable from one message.
//
// base32768 needs no equivalent — its decoder already rejects characters outside its repertoire.
//
// `where` names the field the index counts from, because these two codecs are handed slices
// rather than the whole message: an index alone would be ambiguous between the two, and the
// header's is small enough to be mistaken for the body's.
function digitAt(c: string, i: number, where: "header" | "body"): number {
  const idx = A2I[c];
  if (idx === undefined) {
    const cp = c.codePointAt(0)!.toString(16).toUpperCase().padStart(4, "0");
    throw new Error(
      `Malformed message: ${JSON.stringify(c)} (U+${cp}) at ${i} of the ${where} ` +
      `is not a base-85 character`,
    );
  }
  return idx;
}

export function encode(bits: number[]): string {
  if (bits.length === 0) return "";
  const nChars = nCharsForBits(bits.length);
  let value = 0n;
  for (const b of bits) value = (value << 1n) | BigInt(b);
  const chars: string[] = [];
  for (let i = 0; i < nChars; i++) {
    chars.push(ALPHABET[Number(value % BASE_BIG)]);
    value /= BASE_BIG;
  }
  return chars.reverse().join("");
}

export function decode(s: string, nBits: number): number[] {
  if (nBits === 0) return [];
  let value = 0n;
  let i = 0;
  for (const c of s) {
    value = value * BASE_BIG + BigInt(digitAt(c, i++, "header"));
  }
  const bits: number[] = new Array(nBits).fill(0);
  for (let i = nBits - 1; i >= 0; i--) {
    bits[i] = Number(value & 1n);
    value >>= 1n;
  }
  return bits;
}

// Body (little-endian, self-delimiting) codec — distinct from encode/decode above, which are
// fixed-width and MSB-first for the header. The body's bit length is NOT stored: the decoder
// knows the body's structure and reads exactly the bits it needs, so the trailing high-order
// zero padding can be dropped. `bits[0]` is the least-significant bit of the value, emitted
// least-significant base-85 digit first. On decode, the returned array holds only the meaningful
// low bits; structural reads past its end resolve to 0 (the implicit padding) via takeInt.
export function encodeBodyLE(bits: number[]): string {
  let value = 0n;
  for (let i = bits.length - 1; i >= 0; i--) value = (value << 1n) | BigInt(bits[i]);
  let s = "";
  while (value > 0n) {
    s += ALPHABET[Number(value % BASE_BIG)];
    value /= BASE_BIG;
  }
  return s;
}

export function decodeBodyLE(s: string): number[] {
  let value = 0n;
  let place = 1n;
  let i = 0;
  for (const c of s) {
    value += BigInt(digitAt(c, i++, "body")) * place;
    place *= BASE_BIG;
  }
  const bits: number[] = [];
  while (value > 0n) {
    bits.push(Number(value & 1n));
    value >>= 1n;
  }
  return bits;
}

// The base32768 body codec — same contract as encodeBodyLE/decodeBodyLE above (little-endian,
// self-delimiting, trailing zeros droppable), but packing bits into bytes rather than base-85
// digits, because base32768 is a byte codec: it spends 15 bits on each character, which is one
// UTF-16 code unit and three UTF-8 bytes.
//
// The padding works out for free. encodeBodyLE can drop trailing zero bits because the decoder
// knows the body's structure and reads exactly the bits it needs; here the same applies at byte
// granularity, so rounding the bit count up to a byte just re-adds some of the implicit padding
// that structural reads past the end already resolve to 0.
export function encodeBodyWide(bits: number[]): string {
  let n = bits.length;
  while (n > 0 && bits[n - 1] === 0) n--;
  const bytes = new Uint8Array(Math.ceil(n / 8));
  for (let i = 0; i < n; i++) if (bits[i]) bytes[i >> 3] |= 1 << (i & 7);
  return wideEncode(bytes);
}

export function decodeBodyWide(s: string): number[] {
  const bytes = wideDecode(s);
  const bits: number[] = new Array(bytes.length * 8);
  for (let i = 0; i < bits.length; i++) bits[i] = (bytes[i >> 3] >> (i & 7)) & 1;
  return bits;
}

// Which alphabet a body string is written in, read off the body itself so a reply needs no
// out-of-band flag and no new protocol version: every base-85 character is ASCII and every
// base32768 character is not. An empty body (a message whose bits are all zero) reads as
// base-85, which is harmless — both codecs decode "" to no bits.
export function bodyAlphabet(body: string): Alphabet {
  return body.length > 0 && body.codePointAt(0)! > 0x7f ? "base32768" : "base85";
}

// Decodes a body in whichever alphabet it arrived in.
export function decodeBodyAuto(body: string): number[] {
  return bodyAlphabet(body) === "base32768" ? decodeBodyWide(body) : decodeBodyLE(body);
}
