import { wireCodec, WIRE_VERSION } from "./wire.js";
import { peekVersion } from "./version.js";
import type {
  ForecastMessage, MessageHeader, VersionedCodec, ContextResolver,
} from "./model.js";
import type { Alphabet } from "./codec.js";
import { foldSeptetSwap } from "./constants.js";
import { DEVICE_TRANSPORT } from "./devices.js";

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
  return codec.decode(unswapReply(s, codec, resolve), resolve);
}

// Undoes the inReach display swap (SEPTET_SWAP) on a pasted reply before the codec reads it.
//
// The fixed prefix — version tag and packed header — is base-85 on every route, so it folds
// unconditionally, and it has to fold FIRST: the message code that names the route lives inside
// it. The body folds only once the stored request says the route wasn't SMS. Base-124 is the one
// alphabet that spends ¤ ¡ § as themselves, so an SMS body is left exactly as pasted; every other
// alphabet (base-85, base-94, base32768) contains none of the three, which makes the fold a no-op
// on a clean paste and exact on a swapped one. An unknown code folds the body too — the decode is
// about to fail on the code regardless, and the error should be that one.
function unswapReply(s: string, codec: VersionedCodec, resolve: ContextResolver): string {
  const prefix = foldSeptetSwap(s.slice(0, codec.headerChars));
  const body = s.slice(codec.headerChars);
  const device = resolve(codec.header(prefix).code)?.device;
  const sms = device != null && DEVICE_TRANSPORT[device].alphabet === "base124";
  return prefix + (sms ? body : foldSeptetSwap(body));
}

// Reads a message's fixed-width prefix — version tag and packed header — without its body, by the
// same version dispatch as decodeMessage. Throws when the string doesn't start with one, which is
// how a caller holding an unlabelled fragment of a reply tells the first message from a later one:
// only the first carries a header (see parts.ts).
export function peekHeader(s: string): MessageHeader {
  const codec = codecFor(s);
  return codec.header(foldSeptetSwap(s.slice(0, codec.headerChars)));
}

function codecFor(s: string): VersionedCodec {
  return codecForVersion(peekVersion(s));
}

// Encodes a message using the codec for its `version` field, writing the body in `alphabet`
// (default base-85, see the Alphabet type in codec.ts).
export function encodeMessage(msg: ForecastMessage, alphabet?: Alphabet): string {
  return codecForVersion(msg.version).encode(msg, alphabet);
}
