import { v3Codec } from "./versions/v3.js";
import { peekVersion } from "./version.js";
import type {
  ForecastMessage, MessageHeader, VersionedCodec, ContextResolver,
} from "./model.js";
import type { Alphabet } from "./codec.js";
import { foldSeptetSwap } from "./constants.js";
import { DEVICE_TRANSPORT } from "./devices.js";

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
