import { v2Codec } from "./versions/v2.js";
import { peekVersion } from "./version.js";
import type { ForecastMessage, VersionedCodec } from "./model.js";

// The single source of truth mapping a protocol version number to its codec.
//
// Introducing a new version: add `versions/vN.ts`, then register it here. Nothing else in
// the dispatch path changes — `decodeMessage` reads the version tag and routes to the codec
// registered for it, and any version not present here is rejected with a clear error rather
// than mis-decoded. Keep older codecs registered so new clients can still read old messages.
export const CODECS: Record<number, VersionedCodec> = {
  2: v2Codec,
};

export function supportedVersions(): number[] {
  return Object.keys(CODECS).map(Number).sort((a, b) => a - b);
}

// Decodes a message of any registered version by reading its self-describing version tag
// and dispatching to exactly one codec.
export function decodeMessage(s: string): ForecastMessage {
  const version = peekVersion(s);
  const codec = CODECS[version];
  if (!codec) {
    const supported = supportedVersions().map((v) => `v${v}`).join(", ");
    throw new Error(`Unsupported protocol version: v${version}. Supported: ${supported}`);
  }
  return codec.decode(s);
}

// Encodes a message using the codec for its `version` field.
export function encodeMessage(msg: ForecastMessage): string {
  const codec = CODECS[msg.version];
  if (!codec) {
    const supported = supportedVersions().map((v) => `v${v}`).join(", ");
    throw new Error(`Unsupported protocol version: v${msg.version}. Supported: ${supported}`);
  }
  return codec.encode(msg);
}
