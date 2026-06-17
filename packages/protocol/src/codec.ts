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
