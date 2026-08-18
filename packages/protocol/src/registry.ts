import { v3Codec } from "./versions/v3.js";
import { peekVersion } from "./version.js";
import type {
  ForecastMessage, MessageHeader, VersionedCodec, ContextResolver,
} from "./model.js";
import type { Alphabet } from "./codec.js";

// The single source of truth mapping a protocol version number to its codec.
//
// Introducing a new version: add `versions/vN.ts`, then register it here. Nothing else in
// the dispatch path changes — `decodeMessage` reads the version tag and routes to the codec
// registered for it, and any version not present here is rejected with a clear error rather
// than mis-decoded.
//
// Old versions are NOT kept: when vN+1 ships, `versions/vN.ts`, its codebooks, and its golden
// fixtures are deleted from main — the frozen `codec-vN` container (built from the codec-vN git
// tag) keeps serving clients still in the field, and the app treats a saved message it can no
// longer decode as expired (past forecasts are a short-lived buffer, not long-term storage).
// See VERSIONING.md for the freeze/sunset runbooks.
export const CODECS: Record<number, VersionedCodec> = {
  3: v3Codec,
};

export function supportedVersions(): number[] {
  return Object.keys(CODECS).map(Number).sort((a, b) => a - b);
}

// Decodes a message of any registered version by reading its self-describing version tag
// and dispatching to exactly one codec. `resolve` recovers the request-echo fields the slim
// response omits, keyed by the message code (see RequestContext).
export function decodeMessage(s: string, resolve: ContextResolver): ForecastMessage {
  return codecFor(s).decode(s, resolve);
}

// Reads a message's fixed-width prefix — version tag and packed header — without its body, by the
// same version dispatch as decodeMessage. Throws when the string doesn't start with one, which is
// how a caller holding an unlabelled fragment of a reply tells the first message from a later one:
// only the first carries a header (see parts.ts).
export function peekHeader(s: string): MessageHeader {
  return codecFor(s).header(s);
}

function codecFor(s: string): VersionedCodec {
  const version = peekVersion(s);
  const codec = CODECS[version];
  if (!codec) {
    const supported = supportedVersions().map((v) => `v${v}`).join(", ");
    throw new Error(`Unsupported protocol version: v${version}. Supported: ${supported}`);
  }
  return codec;
}

// Encodes a message using the codec for its `version` field, writing the body in `alphabet`
// (default base-85 — see the Alphabet type in codec.ts).
export function encodeMessage(msg: ForecastMessage, alphabet?: Alphabet): string {
  const codec = CODECS[msg.version];
  if (!codec) {
    const supported = supportedVersions().map((v) => `v${v}`).join(", ");
    throw new Error(`Unsupported protocol version: v${msg.version}. Supported: ${supported}`);
  }
  return codec.encode(msg, alphabet);
}
