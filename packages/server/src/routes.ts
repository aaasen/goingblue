import { randomUUID } from "node:crypto";
import type { Context } from "hono";
import { ping } from "./db.js";
import { extractUserToken, extractVersion } from "./dispatch.js";
import { createAccount, deleteAccount, recordRequest } from "./accounts.js";
import { receiveMessage } from "./delivery.js";
import { runEncodeTask } from "./encode-task.js";
import {
  REPLY_FUTURE, REPLY_MALFORMED, REPLY_STALE, REPLY_UNAVAILABLE, REPLY_UNSUPPORTED,
  replyChars, resolveForecast,
} from "./forecast.js";
import { isAppUserAgent, isValidToken, normalizeToken } from "@weather/protocol";
import { isMessageSid, twiml, validateTwilioSignature } from "./twilio.js";
import { log, traceIdFrom, withRequestId, withTrace } from "./log.js";

// Record an internet request without ever failing the response: the reply is already built by
// the time we get here, so a DB hiccup must not turn a served forecast into an error.
async function logRequest(record: Parameters<typeof recordRequest>[0]): Promise<void> {
  try {
    await recordRequest(record);
  } catch (e) {
    log.error("request.record_failed", { err: e });
  }
}

// POST /forecast: the internet route, which answers in the response body and bypasses the
// delivery queue. Every outcome is recorded, not just the served ones: a client that asked and
// got "please update the app" is still a person using the service, and the failures are the
// only signal that a version has clients it can no longer answer. The per-version counts are
// also the sunset metric for frozen codec containers (VERSIONING.md).
export async function forecast(c: Context) {
  const requestId = randomUUID();
  const traceId = traceIdFrom(c.req.header("X-Cloud-Trace-Context"));
  const body = (await c.req.text()).trim();
  const result = await withTrace(traceId, () => withRequestId(requestId, async () => {
    const result = await resolveForecast(body, requestId, traceId);
    await logRequest({
      requestId,
      token: extractUserToken(body),
      chars: replyChars(result),
      version: extractVersion(body),
      outcome: result.kind,
      codecMs: "codecMs" in result ? result.codecMs : null,
      shape: result.kind === "ok" ? result.shape : null,
    });
    return result;
  }));
  switch (result.kind) {
    case "ok": return c.text(result.encoded, 200);
    case "missing_version": return c.text(REPLY_MALFORMED, 400);
    // The caller here is the app itself, so the codec's specific reason is more useful than the
    // human reply text.
    case "malformed": return c.text(result.reason, 400);
    case "unknown_token": return c.text(REPLY_MALFORMED, 400);
    case "unsupported_version": return c.text(REPLY_UNSUPPORTED, 400);
    case "unavailable": return c.text(REPLY_UNAVAILABLE, 503);
    case "stale": return c.text(REPLY_STALE, 422);
    case "future": return c.text(REPLY_FUTURE, 422);
  }
}

// POST /sms: Twilio's inbound-SMS webhook, delivered as form-encoded params (MessageSid, Body,
// From, To, ...). When TWILIO_AUTH_TOKEN is set the request signature is verified so the public
// endpoint can't be spoofed; an unsigned or invalid request is rejected with 403.
//
// The message is recorded by SID and answered by the encode task, which sends the reply through
// the Twilio REST API; the webhook response itself carries no message. The task runs inline
// here, with no retry window: a transient failure gets the unavailable reply at once, as the
// sender would otherwise wait on nothing. A send that could not complete returns 503 so Twilio
// retries the webhook, and the recorded row makes that retry resume rather than start over.
export async function sms(c: Context) {
  const requestId = randomUUID();
  const traceId = traceIdFrom(c.req.header("X-Cloud-Trace-Context"));
  return withTrace(traceId, () => withRequestId(requestId, () => handleSms(c, requestId, traceId)));
}

async function handleSms(c: Context, requestId: string, traceId: string | null) {
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

  const sid = params["MessageSid"];
  if (!isMessageSid(sid)) {
    log.error("sms.missing_sid");
    return c.text("Missing MessageSid", 400);
  }
  // Neither the sender's number nor the message text is logged; both sit in Twilio's own logs
  // under the MessageSid, which is what gets logged so a message can still be looked up there
  // while Twilio retains it.
  log.info("sms.inbound", { sid, len: (params["Body"] ?? "").length });

  // HELP, STOP and START never reach this webhook: Twilio's Advanced Opt-Out intercepts the
  // keywords and sends its own replies, configured in the Twilio console.

  // The row is the record that the message exists; without it nothing downstream can be
  // deduplicated or resumed, so a database failure here is a failure of the request.
  try {
    await receiveMessage({ requestId, messageSid: sid, twilioReceivedAt: null });
  } catch (e) {
    log.error("sms.receive_failed", { sid, err: e });
    return c.text("Unavailable", 503);
  }
  const result = await runEncodeTask(sid, { retryWindowMs: 0, traceId });
  if (result === "retry") return c.text("Retry", 503);
  return c.text(twiml(""), 200, { "Content-Type": "text/xml" });
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
  // Log whether the user agent matches the app. This will reject requests once v4 is fully rolled out.
  const client = isAppUserAgent(c.req.header("User-Agent")) ? "app" : "other";
  try {
    const token = await createAccount();
    log.info("account.create", { client });
    return c.json({ token });
  } catch (e) {
    log.error("account.create_failed", { client, err: e });
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
