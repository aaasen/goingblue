// User account tokens. A token is an 80-bit random value rendered in Crockford base32 — 16
// characters, displayed in four groups of four, e.g. "FT3E-YZEG-JK8X-1A9C". The server mints
// them (see generateToken); clients and the gateway normalize and shape-check tokens before
// use (see isValidToken / normalizeToken).
//
// Why this shape:
//   - 80 bits is unguessable, and the keyspace is far too sparse for a mistyped token to ever
//     land on a real account, so no local check digit is needed.
//   - Crockford base32 is case-insensitive, omits the ambiguous letters I/L/O/U, and tolerates
//     hyphen grouping, so it stays readable when shown to a person.
//   - On the wire it costs little: carried as `u:<token>` it uses 18 of a message's 160 chars.

const TOKEN_BYTES = 10; // 80 bits of entropy
export const TOKEN_CHARS = 16; // 80 / 5: base32 chars for the full value (32^16 === 2^80)

// Crockford base32: the digits 0-9 and A-Z minus I, L, O, U.
const ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

function encodeValue(value: bigint): string {
  let v = value;
  const chars: string[] = [];
  for (let i = 0; i < TOKEN_CHARS; i++) {
    chars.push(ALPHABET[Number(v % 32n)]);
    v /= 32n;
  }
  return chars.reverse().join("");
}

// Mint a new token. `randomBytes` must be a CSPRNG returning at least TOKEN_BYTES bytes — the
// server supplies Node's `crypto.randomBytes`. It's an explicit parameter (rather than a
// default) so this shared module makes no assumption about the host's crypto globals; tokens
// are only ever generated server-side. The value is fixed-width (zero-padded on the left) so
// every token is exactly TOKEN_CHARS long.
export function generateToken(randomBytes: (n: number) => Uint8Array): string {
  const bytes = randomBytes(TOKEN_BYTES);
  if (bytes.length < TOKEN_BYTES) throw new Error(`randomBytes returned ${bytes.length} bytes, need ${TOKEN_BYTES}`);
  let value = 0n;
  for (let i = 0; i < TOKEN_BYTES; i++) value = (value << 8n) | BigInt(bytes[i]);
  return encodeValue(value);
}

// Fold user input to canonical form: drop grouping (hyphens/whitespace), uppercase, and map
// the ambiguous letters Crockford allows on input — O→0, I/L→1. This does not validate; pass
// the result to isValidToken.
export function normalizeToken(input: string): string {
  return input
    .replace(/[\s-]/g, "")
    .toUpperCase()
    .replace(/O/g, "0")
    .replace(/[IL]/g, "1");
}

// True if `input` is a well-formed token: exactly TOKEN_CHARS characters from the Crockford
// alphabet (after normalization). Accepts any casing, grouping, or ambiguous letters. This is
// a shape check only — whether a token corresponds to a real account is the server's call.
export function isValidToken(input: string): boolean {
  const s = normalizeToken(input);
  if (s.length !== TOKEN_CHARS) return false;
  for (const ch of s) if (!ALPHABET.includes(ch)) return false;
  return true;
}

// Render a token grouped in fours for display, e.g. "FT3E-YZEG-JK8X-1A9C". The grouping is
// cosmetic; normalizeToken strips it back out.
export function formatToken(token: string): string {
  return normalizeToken(token).replace(/(.{4})(?=.)/g, "$1-");
}
