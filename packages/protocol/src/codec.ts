import { ALPHABET, WMO_BITS } from "./constants.js";

// The encoding radix is simply the alphabet size (see constants.ts).
const BASE = ALPHABET.length;
const BASE_BIG = BigInt(BASE);

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
  for (const c of s) {
    const idx = A2I[c];
    if (idx !== undefined) value = value * BASE_BIG + BigInt(idx);
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
  for (const c of s) {
    const idx = A2I[c];
    if (idx !== undefined) value += BigInt(idx) * place;
    place *= BASE_BIG;
  }
  const bits: number[] = [];
  while (value > 0n) {
    bits.push(Number(value & 1n));
    value >>= 1n;
  }
  return bits;
}
