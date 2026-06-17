// User account tokens. A token is a 64-bit random value rendered in Crockford base32 with
// a trailing check symbol — 14 characters total, e.g. "3KX7Q9V2HM4N8C". The server mints
// them (see generateToken); the mobile app validates and normalizes user-entered tokens
// during account import (see isValidToken / normalizeToken).
//
// Why this shape:
//   - 64 bits is unguessable given server-side rate limiting, and is short on the wire:
//     carried as `u:<token>` it costs 16 of a message's 160 characters.
//   - Crockford base32 is case-insensitive, omits the ambiguous letters I/L/O/U from the
//     data alphabet, and tolerates hyphen grouping — all friendly to a human retyping a
//     token when moving their account to a new device.
//   - The check symbol catches single-character typos and transpositions locally, before a
//     server round-trip, so a mistyped token can't silently resolve to someone else's.

const TOKEN_BYTES = 8; // 64 bits of entropy
const TOKEN_DATA_CHARS = 13; // ceil(64 / 5): base32 chars needed for 64 bits
export const TOKEN_CHARS = TOKEN_DATA_CHARS + 1; // data chars + check symbol = 14

// Crockford base32: the digits 0-9 and A-Z minus I, L, O, U.
const ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
// Check symbols extend the alphabet by 5 so a check value 0..36 (value mod 37) is one char.
const CHECK_ALPHABET = ALPHABET + "*~$=U";

function encodeValue(value: bigint): string {
  let v = value;
  const chars: string[] = [];
  for (let i = 0; i < TOKEN_DATA_CHARS; i++) {
    chars.push(ALPHABET[Number(v % 32n)]);
    v /= 32n;
  }
  chars.reverse();
  const check = CHECK_ALPHABET[Number(value % 37n)];
  return chars.join("") + check;
}

// Mint a new token. `randomBytes` must be a CSPRNG returning at least TOKEN_BYTES bytes —
// the server supplies Node's `crypto.randomBytes`. It's an explicit parameter (rather than
// a default) so this shared module makes no assumption about the host's crypto globals;
// tokens are only ever generated server-side. The 64-bit value is fixed-width (13 data
// chars, zero-padded on the left) so every token is exactly TOKEN_CHARS long.
export function generateToken(randomBytes: (n: number) => Uint8Array): string {
  const bytes = randomBytes(TOKEN_BYTES);
  if (bytes.length < TOKEN_BYTES) throw new Error(`randomBytes returned ${bytes.length} bytes, need ${TOKEN_BYTES}`);
  let value = 0n;
  for (let i = 0; i < TOKEN_BYTES; i++) value = (value << 8n) | BigInt(bytes[i]);
  return encodeValue(value);
}

// Fold user input to canonical form: drop grouping (hyphens/whitespace), uppercase, and map
// the ambiguous letters Crockford allows on input — O→0, I/L→1. The check symbols (* ~ $ =
// U) are untouched. This does not validate; pass the result to isValidToken.
export function normalizeToken(input: string): string {
  return input
    .replace(/[\s-]/g, "")
    .toUpperCase()
    .replace(/O/g, "0")
    .replace(/[IL]/g, "1");
}

// True if `input` is a well-formed token with a matching check symbol. Accepts any casing,
// grouping, or Crockford-ambiguous letters (normalized internally).
export function isValidToken(input: string): boolean {
  const s = normalizeToken(input);
  if (s.length !== TOKEN_CHARS) return false;

  let value = 0n;
  for (let i = 0; i < TOKEN_DATA_CHARS; i++) {
    const idx = ALPHABET.indexOf(s[i]);
    if (idx === -1) return false;
    value = value * 32n + BigInt(idx);
  }
  // 13 base32 chars can express up to 2^65; reject anything above the 64-bit range so a
  // canonical token has exactly one valid encoding.
  if (value >= 1n << 64n) return false;

  return s[TOKEN_DATA_CHARS] === CHECK_ALPHABET[Number(value % 37n)];
}

// Render a (valid) token grouped in fours for display, e.g. "3KX7-Q9V2-HM4N-8C". The
// grouping is cosmetic; normalizeToken strips it back out.
export function formatToken(token: string): string {
  return normalizeToken(token).replace(/(.{4})(?=.)/g, "$1-");
}
