import { ALPHABET } from "./constants.js";

// Every message begins with a self-describing version tag: a single base-85 character
// whose alphabet index is the protocol version (0–84). It is fixed-width and identical
// across all versions, so a decoder can read the version *before* it knows anything else
// about the message's layout, then dispatch to exactly one codec (see registry.ts).
//
// This is the contract that lets new versions ship without breaking old clients: an old
// client that receives a newer version reads the tag, finds no codec for it, and fails
// with a clear "unsupported version" error instead of silently mis-decoding the payload.
export const VERSION_PREFIX_CHARS = 1;
export const MAX_VERSION = ALPHABET.length - 1; // 84

const CHAR_TO_VALUE: Record<string, number> = Object.fromEntries(
  [...ALPHABET].map((c, i) => [c, i]),
);

export function encodeVersion(version: number): string {
  if (!Number.isInteger(version) || version < 0 || version > MAX_VERSION)
    throw new Error(`Version out of range: v${version} (must be 0–${MAX_VERSION})`);
  return ALPHABET[version];
}

// Reads the version tag without decoding the rest of the message.
export function peekVersion(s: string): number {
  if (s.length < VERSION_PREFIX_CHARS)
    throw new Error(`Malformed message: too short to contain a version tag`);
  const version = CHAR_TO_VALUE[s[0]];
  if (version === undefined)
    throw new Error(`Malformed message: invalid version tag ${JSON.stringify(s[0])}`);
  return version;
}

// Strips the version tag, returning the version and the remaining (header + body) string.
export function takeVersion(s: string): [number, string] {
  return [peekVersion(s), s.slice(VERSION_PREFIX_CHARS)];
}
