import { dispatchForecast, extractUserToken, extractVersion, type DispatchResult } from "./dispatch.js";
import { accountExists } from "./accounts.js";
import { log } from "./log.js";

// Turning a request body into a result and a result into reply text, shared by the internet
// route (routes.ts) and the encode task (encode-task.ts).

// Human-readable replies for requests that get no forecast, one per error class. These go back
// over SMS, so each must fit a single GSM-7 segment and tell the person what to do next.
//
// Malformed covers everything that isn't a well-formed request from the app: random texts to
// the number, hand-typed attempts, requests with missing or invalid components. The sender may
// have never heard of the service, so the reply says what it is and where the app lives.
export const REPLY_MALFORMED =
  "Going Blue: expedition weather forecasts via satellite. Download the app at going.blue";
// The request named a protocol version this deployment no longer serves.
export const REPLY_UNSUPPORTED = "Invalid app version. Update the app at going.blue and try again";
// Transient service failure (codec unreachable, upstream data down): retrying is the fix.
export const REPLY_UNAVAILABLE = "Going Blue is not available right now. Please try again in a few minutes";
// A request whose start time is off the servable axis gets no message at all over SMS. Stale
// means the message sat in a queue for days: the sender's failure happened back then, and a
// reply now would cost them an inbound message to say what they already know. Future means a
// wrong clock, which has never been seen in practice. Both are recorded as their own outcomes.
// The HTTP route names each for the app or a direct caller.
export const REPLY_STALE = "Request is stale. Build a new request and try again.";
export const REPLY_FUTURE = "Request is from the future. Build a new request and try again.";

// What a request can come to: a dispatch result, or the gateway's own rejection of a token
// that names no account. The codec validates that a token is present and well-formed; whether
// it maps to a real account only the gateway can know, since only the gateway has the database.
export type RequestResult = DispatchResult | { kind: "unknown_token" };

// The outbound messages a result is answered with, in order; empty when nothing is owed. A codec
// returns its reply as one message per line, the gateway's whole knowledge of the format:
// splitting here rather than in the codec keeps the grammar out of the gateway (dispatch.ts).
export function replyParts(result: RequestResult): string[] {
  switch (result.kind) {
    case "ok": return result.encoded.split("\n").map((m) => m.trim()).filter(Boolean);
    // A message with no version word isn't a request at all, so it reads as malformed here even
    // though the gateway detects it before dispatch.
    case "missing_version": return [REPLY_MALFORMED];
    case "malformed": return [REPLY_MALFORMED];
    // A well-formed token from another environment, or from an account since deleted. The same
    // reply as malformed: it is not a request this deployment can attribute, and the sender's
    // fix is the same, get the app and its setup flow.
    case "unknown_token": return [REPLY_MALFORMED];
    case "unsupported_version": return [REPLY_UNSUPPORTED];
    case "unavailable": return [REPLY_UNAVAILABLE];
    case "stale": return [];
    case "future": return [];
  }
}

// Whether the token names an account, erring toward yes: a database outage must not become a
// forecast outage when everything else about the request can still be served.
async function tokenKnown(token: string): Promise<boolean> {
  try {
    return await accountExists(token);
  } catch (e) {
    log.error("token.check_failed", { err: e });
    return true;
  }
}

// Gate a request on its account and dispatch it to its version's codec. Nothing is recorded
// here: the internet route and the encode task each record the result their own way.
export async function resolveForecast(body: string, requestId: string, traceId: string | null): Promise<RequestResult> {
  const version = extractVersion(body);
  const token = extractUserToken(body);
  // The account check runs before dispatch, so a rejected request never costs a codec call or
  // an upstream fetch. Only a present, well-formed token is checked here: a missing or mangled
  // one goes to the codec, whose reply names what is wrong with it.
  if (token !== null && !(await tokenKnown(token))) {
    log.info("forecast.dispatch", { version, kind: "unknown_token" });
    return { kind: "unknown_token" };
  }
  const result = await dispatchForecast(body, requestId, traceId);
  log.info("forecast.dispatch", {
    version,
    kind: result.kind,
    chars: result.kind === "ok" ? result.encoded.length : undefined,
  });
  return result;
}

// The reply's character count: a multi-message reply arrives one message per line, and the
// newlines are gateway framing, not reply characters. Null when no forecast was served.
export function replyChars(result: RequestResult): number | null {
  return result.kind === "ok" ? result.encoded.split("\n").join("").length : null;
}
