import { wireCodec, WIRE_VERSION } from "./wire.js";
import { peekVersion } from "./version.js";
import type {
  ForecastMessage, MessageHeader, VersionedCodec, ContextResolver,
} from "./model.js";
import type { Alphabet } from "./codec.js";

// Main carries exactly one protocol version: wire.ts is the current message grammar, and
// WIRE_VERSION names it. `decodeMessage` reads the version tag and rejects any other version
// with a clear error rather than mis-decoding.
//
// Old versions are NOT kept: when the next version ships, the outgoing grammar survives only
// in its frozen `codec-vN` container (built from the codec-vN git tag), which keeps serving
// clients still in the field; main bumps WIRE_VERSION, deletes the golden corpus, and moves
// on. The app treats a saved message it can no longer decode as expired (past forecasts are
// a short-lived buffer, not long-term storage). See VERSIONING.md for the freeze/sunset
// runbooks.
function codecForVersion(version: number): VersionedCodec {
  if (version !== WIRE_VERSION) {
    throw new Error(`Unsupported protocol version: v${version}. Supported: v${WIRE_VERSION}`);
  }
  return wireCodec;
}

// Decodes a message by its self-describing version tag. `resolve` recovers the request-echo
// fields the slim response omits, keyed by the message code (see RequestContext).
export function decodeMessage(s: string, resolve: ContextResolver): ForecastMessage {
  const codec = codecFor(s);
  return codec.decode(s, resolve);
}

// Reads a message's fixed-width prefix — version tag and packed header — without its body, by the
// same version dispatch as decodeMessage. Throws when the string doesn't start with one, which is
// how a caller holding an unlabelled fragment of a reply tells the first message from a later one:
// only the first carries a header (see parts.ts).
export function peekHeader(s: string): MessageHeader {
  const codec = codecFor(s);
  return codec.header(s.slice(0, codec.headerChars));
}

function codecFor(s: string): VersionedCodec {
  return codecForVersion(peekVersion(s));
}

// Encodes a message using the codec for its `version` field, writing the body in `alphabet`
// (default base-85, see the Alphabet type in codec.ts).
export function encodeMessage(msg: ForecastMessage, alphabet?: Alphabet): string {
  return codecForVersion(msg.version).encode(msg, alphabet);
}
