import type { Context } from "hono";
import { dispatchForecast, extractUserToken, extractVersion, type DispatchResult } from "./dispatch.js";
import { ping } from "./db.js";
import { createAccount, accountExists, deleteAccount, recordRequest } from "./accounts.js";
import { isValidToken, normalizeToken } from "@weather/protocol";
import { twiml, validateTwilioSignature } from "./twilio.js";
import { log } from "./log.js";

// Human-readable replies for requests that get no forecast, one per error class. These go back
// over SMS, so each must fit a single GSM-7 segment and tell the person what to do next.
//
// Malformed covers everything that isn't a well-formed request from the app — random texts to
// the number, hand-typed attempts, requests with missing or invalid components. The sender may
// have never heard of the service, so the reply says what it is and where the app lives.
const REPLY_MALFORMED =
  "Going Blue: expedition weather forecasts via satellite. Download the app at going.blue";
// The request named a protocol version this deployment no longer serves.
const REPLY_UNSUPPORTED = "Invalid app version. Update the app at going.blue and try again";
// Transient service failure (codec unreachable, upstream data down): retrying is the fix.
const REPLY_UNAVAILABLE = "Going Blue is not available right now. Please try again in a few minutes";

// What a request can come to: a dispatch result, or the gateway's own rejection of a token
// that names no account. The codec validates that a token is present and well-formed; whether
// it maps to a real account only the gateway can know, since only the gateway has the database.
type RequestResult = DispatchResult | { kind: "unknown_token" };

// A codec returns its reply as one message per line — the gateway's whole knowledge of the
// format. Splitting here rather than in the codec keeps the grammar out of the gateway (see
// dispatch.ts): a reply that fits one message is one line and comes back as one message, which
// is what every frozen codec image returns.
function replyFor(result: RequestResult): string | string[] {
  switch (result.kind) {
    case "ok": return result.encoded.split("\n");
    // A message with no version word isn't a request at all, so it reads as malformed here even
    // though the gateway detects it before dispatch.
    case "missing_version": return REPLY_MALFORMED;
    case "malformed": return REPLY_MALFORMED;
    // A well-formed token from another environment, or from an account since deleted. The same
    // reply as malformed: it is not a request this deployment can attribute, and the sender's
    // fix is the same — get the app and its setup flow.
    case "unknown_token": return REPLY_MALFORMED;
    case "unsupported_version": return REPLY_UNSUPPORTED;
    case "unavailable": return REPLY_UNAVAILABLE;
  }
}

// Whether the token names an account, erring toward yes: a database outage must not become a
// forecast outage when everything else about the request can still be served — the same
// posture recordRequest takes on the way out.
async function tokenKnown(token: string): Promise<boolean> {
  try {
    return await accountExists(token);
  } catch (e) {
    log.error("token.check_failed", { err: e });
    return true;
  }
}

// Record an inbound message without ever failing the response: the reply is already built by
// the time we get here, so a DB hiccup must not turn a served forecast into an error.
async function logRequest(record: Parameters<typeof recordRequest>[0]): Promise<void> {
  try {
    await recordRequest(record);
  } catch (e) {
    log.error("request.record_failed", { err: e });
  }
}

// Dispatch a request body to its version's codec server and record the attempt. Every outcome
// is recorded, not just the served ones: a number that asked and got "please update the app" is
// still a person using the service, and the failures are the only signal that a version has
// clients it can no longer answer. The per-version counts are also the sunset metric — a frozen
// codec container is retired only once its version has gone quiet (VERSIONING.md).
async function buildForecast(body: string): Promise<RequestResult> {
  const version = extractVersion(body);
  const token = extractUserToken(body);
  // The account check runs before dispatch, so a rejected request never costs a codec call or
  // an upstream fetch. Only a present, well-formed token is checked here: a missing or mangled
  // one goes to the codec, whose reply names what is wrong with it.
  if (token !== null && !(await tokenKnown(token))) {
    log.info("forecast.dispatch", { version, kind: "unknown_token" });
    await logRequest({ token, chars: null, version, outcome: "unknown_token", codecMs: null, shape: null });
    return { kind: "unknown_token" };
  }
  const result = await dispatchForecast(body);
  log.info("forecast.dispatch", {
    version,
    kind: result.kind,
    chars: result.kind === "ok" ? result.encoded.length : undefined,
  });
  await logRequest({
    token,
    // A multi-message reply arrives one message per line; the newlines are gateway framing, not
    // reply characters, so they don't count.
    chars: result.kind === "ok" ? result.encoded.split("\n").join("").length : null,
    version,
    outcome: result.kind,
    codecMs: "codecMs" in result ? result.codecMs : null,
    shape: result.kind === "ok" ? result.shape : null,
  });
  return result;
}

export async function forecast(c: Context) {
  const result = await buildForecast((await c.req.text()).trim());
  switch (result.kind) {
    case "ok": return c.text(result.encoded, 200);
    case "missing_version": return c.text(REPLY_MALFORMED, 400);
    // The caller here is the app itself, so the codec's specific reason is more useful than the
    // human reply text.
    case "malformed": return c.text(result.reason, 400);
    case "unknown_token": return c.text(REPLY_MALFORMED, 400);
    case "unsupported_version": return c.text(REPLY_UNSUPPORTED, 400);
    case "unavailable": return c.text(REPLY_UNAVAILABLE, 503);
  }
}

// POST /sms — Twilio inbound-SMS webhook. Twilio delivers each text a user sends to the Going
// Blue number here as form-encoded params (Body, From, To, …) and sends whatever <Message> we
// return in TwiML back to that sender, so the reply path needs no Twilio REST credentials. When
// TWILIO_AUTH_TOKEN is set, the request signature is verified so the public endpoint can't be
// spoofed; an unsigned/invalid request is rejected with 403.
export async function sms(c: Context) {
  const form = await c.req.parseBody();
  // Flatten to string params for both signature validation and our own use.
  const params: Record<string, string> = {};
  for (const [k, v] of Object.entries(form)) params[k] = String(v);

  const authToken = process.env["TWILIO_AUTH_TOKEN"];
  if (authToken) {
    const signature = c.req.header("X-Twilio-Signature") ?? "";
    // The URL Twilio signed is the public webhook URL. Behind Cloud Run the in-process URL can
    // differ (internal scheme/host), so allow pinning it via TWILIO_WEBHOOK_URL.
    const url = process.env["TWILIO_WEBHOOK_URL"] ?? c.req.url;
    if (!validateTwilioSignature(authToken, signature, url, params)) {
      log.error("sms.invalid_signature", { url });
      return c.text("Invalid signature", 403);
    }
  }

  // Neither the sender's number nor the message text is logged; both sit in Twilio's own logs
  // under the MessageSid, which is what gets logged so a message can still be looked up there
  // while Twilio retains it.
  const body = params["Body"] ?? "";
  log.info("sms.inbound", { sid: params["MessageSid"], len: body.length });

  // HELP, STOP and START never reach this webhook: Twilio's Advanced Opt-Out intercepts the
  // keywords and sends its own replies, configured in the Twilio console.

  const result = await buildForecast(body.trim());
  return c.text(twiml(replyFor(result)), 200, { "Content-Type": "text/xml" });
}

export async function health(c: Context) {
  const dbUp = await ping();
  // Always 200 so this stays a valid liveness probe; the body reports DB reachability.
  return c.text(`OK db:${dbUp ? "up" : "down"}`, 200);
}

// POST /account — mint a new account token. Called once over normal internet during app setup
// (not over satellite). The token only identifies the user for usage limits; messaging opt-in
// is consumer-initiated (the user opts in by texting a forecast request to the number), so this
// records no consent and takes no body. Returns { token }.
export async function createAccountRoute(c: Context) {
  try {
    const token = await createAccount();
    return c.json({ token });
  } catch (e) {
    log.error("account.create_failed", { err: e });
    return c.text("Could not create account", 503);
  }
}

// POST /account/delete { token } — erase the caller's account. An app that creates accounts has
// to offer deletion from inside it (App Store Review Guideline 5.1.1(v)), and since the token is
// the only identifier we hold, deleting the row leaves us nothing about the user.
//
// A malformed or unknown token reports { deleted: false } rather than an error: the caller's goal
// is "this account no longer exists," which is already true, and 200 lets the app finish clearing
// its local state. A DB error is a 503 so the app keeps the token and can retry — silently
// dropping it locally would strand a live account with no way to reach it.
export async function deleteAccountRoute(c: Context) {
  const body = await c.req.json().catch(() => ({} as Record<string, unknown>));
  const raw = typeof body?.token === "string" ? body.token : "";
  if (!isValidToken(raw)) return c.json({ deleted: false });
  try {
    const deleted = await deleteAccount(normalizeToken(raw));
    log.info("account.delete", { deleted });
    return c.json({ deleted });
  } catch (e) {
    log.error("account.delete_failed", { err: e });
    return c.text("Deletion unavailable", 503);
  }
}
