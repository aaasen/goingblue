import { dispatchForecast, extractUserToken, extractVersion, type DispatchResult, type RequestShape } from "./dispatch.js";
import { accountExists } from "./accounts.js";
import { log } from "./log.js";
import {
  QUOTA_MIN_VERSION, monthStartUtc, overHard, quotaExceededReply, quotaHeader, quotaStatus, type QuotaStatus,
} from "./quota.js";

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
// No avalanche bulletin covers the request's point on the requested day. Sent on every route:
// unlike a stale request, the reader is waiting for an answer.
export const REPLY_NO_FORECAST = "No avalanche forecast available";

// What a request can come to: a dispatch result, or one of the gateway's own verdicts, which
// only it can reach since only it has the database. A token can name no account. A weather
// forecast the codec served can be past the account's hard quota limit (quota.ts): the encoded
// reply is dropped, its shape kept for the record, and the sender gets the cut-off reply the
// first time this month and nothing after.
export type RequestResult =
  | DispatchResult
  | { kind: "unknown_token" }
  | { kind: "quota_exceeded"; codecMs: number; shape: RequestShape | null; notified: boolean; resetsAt: Date };

// Which way a request came in. Only messaging requests cost money to answer, so only they
// are counted against and limited by the quota.
export type RequestRoute = "internet" | "messaging";

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
    case "no_forecast": return [REPLY_NO_FORECAST];
    case "quota_exceeded": return result.notified ? [] : [quotaExceededReply(result.resetsAt)];
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

// The account's quota, erring toward none: like the account check, a database outage must not
// become a forecast outage.
async function quotaOrNone(token: string, now: Date): Promise<QuotaStatus | null> {
  try {
    return await quotaStatus(token, now);
  } catch (e) {
    log.error("quota.check_failed", { err: e });
    return null;
  }
}

// Gate a request on its account and its quota and dispatch it to its version's codec. Nothing
// is recorded here: the internet route and the encode task each record the result their own
// way. `willRetry` says whether an unavailable codec will be tried again by the caller, which
// sets how loudly dispatch logs it.
export async function resolveForecast(
  body: string,
  requestId: string,
  traceId: string | null,
  willRetry: boolean,
  route: RequestRoute = "internet",
): Promise<RequestResult> {
  const version = extractVersion(body);
  const token = extractUserToken(body);
  // The account check runs before dispatch, so a rejected request never costs a codec call or
  // an upstream fetch. Only a present, well-formed token is checked here: a missing or mangled
  // one goes to the codec, whose reply names what is wrong with it.
  if (token !== null && !(await tokenKnown(token))) {
    log.info("forecast.dispatch", { version, kind: "unknown_token" });
    return { kind: "unknown_token" };
  }
  // The quota is read before the call so the codec can write it into the reply header, and
  // applied after, because only the codec's reported shape says whether the request was a
  // weather forecast. An avalanche forecast is never limited.
  const now = new Date();
  const limited = route === "messaging" && token !== null && version !== null && version >= QUOTA_MIN_VERSION;
  const quota = limited ? await quotaOrNone(token, now) : null;
  const result = await dispatchForecast(body, requestId, traceId, willRetry, quota && quotaHeader(quota));
  if (result.kind === "ok" && quota !== null && result.shape?.kind === "weather" && overHard(quota)) {
    log.info("forecast.dispatch", { version, kind: "quota_exceeded", served: quota.served, hard: quota.hard, notified: quota.notified });
    return { kind: "quota_exceeded", codecMs: result.codecMs, shape: result.shape, notified: quota.notified, resetsAt: monthStartUtc(now, 1) };
  }
  log.info("forecast.dispatch", {
    version,
    kind: result.kind,
    chars: result.kind === "ok" ? result.encoded.length : undefined,
    quota: quota ? { served: quota.served, hard: quota.hard } : undefined,
  });
  return result;
}

// The reply's character count: a multi-message reply arrives one message per line, and the
// newlines are gateway framing, not reply characters. Null when no forecast was served.
export function replyChars(result: RequestResult): number | null {
  return result.kind === "ok" ? result.encoded.split("\n").join("").length : null;
}
