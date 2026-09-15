import { randomUUID } from "node:crypto";
import type { Context } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import { ping } from "./db.js";
import { extractUserToken, extractVersion } from "./dispatch.js";
import { createAccount, deleteAccount, recordRequest } from "./accounts.js";
import { markQueued, receiveMessage, recordReplyDelivery, type DeliveryOutcome } from "./delivery.js";
import { runEncodeTask } from "./encode-task.js";
import { enqueueEncode, tasksConfigured } from "./tasks.js";
import {
  REPLY_FUTURE, REPLY_MALFORMED, REPLY_STALE, REPLY_UNAVAILABLE, REPLY_UNSUPPORTED,
  replyChars, resolveForecast,
} from "./forecast.js";
import { isAppUserAgent, isValidToken, normalizeToken } from "@weather/protocol";
import { fetchMessage, isMessageSid, twiml, validateTwilioJsonSignature, validateTwilioSignature } from "./twilio.js";
import { FORECAST_NUMBER } from "./constants.js";
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
// The message is recorded by SID and its encode task queued (queueMessage); the task sends the
// reply through the Twilio REST API, so the webhook response itself carries no message. A
// failure to record or enqueue is a 503, and the message is picked up again by the event sink.
// The sink delivers the same message too, so a missed webhook is not a lost message.
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

  const result = await queueMessage(sid, requestId, traceId, null);
  if (result !== "queued") return c.text("Unavailable", 503);
  return c.text(twiml(""), 200, { "Content-Type": "text/xml" });
}

// Record a message by SID and put its encode task on the queue. Shared by the webhook and the
// event sink, so both deliveries of the same message do the same thing and the second finds
// the first's row. "unavailable" means the row could not be written or the task could not be
// enqueued: the caller answers 503 and Twilio delivers the message again.
//
// The row is the record that the message exists; without it nothing downstream can be
// deduplicated or resumed, so a database failure here is a failure of the request. Without a
// queue configured (local dev) the task runs inline instead, with no retry window.
export async function queueMessage(
  sid: string,
  requestId: string,
  traceId: string | null,
  twilioReceivedAt: Date | null,
): Promise<"queued" | "unavailable"> {
  let row: Awaited<ReturnType<typeof receiveMessage>>;
  try {
    row = await receiveMessage({ requestId, messageSid: sid, twilioReceivedAt });
  } catch (e) {
    log.error("message.receive_failed", { sid, err: e });
    return "unavailable";
  }
  if (!tasksConfigured()) {
    const result = await runEncodeTask(sid, { retryWindowMs: 0, traceId });
    return result === "done" ? "queued" : "unavailable";
  }
  // Already on the queue from an earlier delivery of this message: nothing more to do.
  if (row.queuedAt !== null) return "queued";
  try {
    const enqueued = await enqueueEncode(sid);
    await markQueued(row.id);
    log.info("message.queued", { sid, enqueued });
  } catch (e) {
    log.error("message.enqueue_failed", { sid, err: e });
    return "unavailable";
  }
  return "queued";
}

// POST /twilio-sink: the Event Streams webhook sink, subscribed to inbound messages and to the
// delivery outcomes of outbound ones. Twilio delivers each event at least once, retrying for
// hours until it gets a 2xx, which is what makes message receipt survive a missed /sms webhook
// and delivery receipts survive a missed delivery. A delivery is a JSON array of
// CloudEvents whatever the sink's batching setting; with batching off it holds one. Every
// element is handled and the delivery is answered by its worst outcome, so a retry redelivers
// the whole array and the row-level dedup absorbs the repeats.
//
// When TWILIO_AUTH_TOKEN is set the request signature is verified, as on /sms; Twilio signs
// these JSON deliveries over the URL with the body's hash appended. The message is also read
// back from Twilio before anything is written: a SID Twilio does not know, or that is not an
// inbound message to the service number, is a 404 and leaves no row. If Twilio's API cannot be
// reached the event is a 503 and comes back later; when Twilio is down there are no events to
// receive anyway.
export async function twilioSink(c: Context) {
  const requestId = randomUUID();
  const traceId = traceIdFrom(c.req.header("X-Cloud-Trace-Context"));
  return withTrace(traceId, () => withRequestId(requestId, () => handleSink(c, requestId, traceId)));
}

const INBOUND_EVENT = "com.twilio.messaging.inbound-message.received";
// The outbound events subscribed to, by what each says about the reply. `queued` and `sent` are
// not subscribed: the 201 on the send already records acceptance.
const DELIVERY_EVENTS: Record<string, DeliveryOutcome> = {
  "com.twilio.messaging.message.delivered": "delivered",
  "com.twilio.messaging.message.undelivered": "undelivered",
  "com.twilio.messaging.message.failed": "failed",
};

async function handleSink(c: Context, requestId: string, traceId: string | null) {
  const raw = await c.req.text();
  const authToken = process.env["TWILIO_AUTH_TOKEN"];
  if (authToken) {
    const signature = c.req.header("X-Twilio-Signature") ?? "";
    // The public URL Twilio signed, with the query it appended. Behind Cloud Run the in-process
    // URL has the wrong scheme, so the origin and path come from TWILIO_SINK_URL.
    const query = new URL(c.req.url).search;
    const url = (process.env["TWILIO_SINK_URL"] ?? c.req.url.split("?")[0]!) + query;
    if (!validateTwilioJsonSignature(authToken, signature, url, raw)) {
      log.error("sink.invalid_signature", { url });
      return c.text("Invalid signature", 403);
    }
  }
  let body: unknown = null;
  try {
    body = JSON.parse(raw);
  } catch {
    body = null;
  }
  const events = Array.isArray(body) ? body : [body];
  let worst = 200;
  for (const event of events) {
    worst = Math.max(worst, await handleEvent(event, requestId, traceId));
  }
  return c.text(SINK_TEXT[worst] ?? "Unavailable", worst as ContentfulStatusCode);
}

const SINK_TEXT: Record<number, string> = { 200: "ok", 400: "Bad event", 404: "Unknown message", 503: "Unavailable" };

// One event to its HTTP status. Only the message-received type does anything; every other
// type, including the sink's own test event, is acknowledged and ignored.
async function handleEvent(event: unknown, requestId: string, traceId: string | null): Promise<number> {
  if (typeof event !== "object" || event === null) {
    log.error("sink.bad_event", { reason: "not_an_object" });
    return 400;
  }
  const e = event as Record<string, unknown>;
  const type = typeof e["type"] === "string" ? e["type"] : "";
  const outcome = DELIVERY_EVENTS[type];
  if (type !== INBOUND_EVENT && outcome === undefined) {
    log.info("sink.ignored", { type });
    return 200;
  }
  const data = (typeof e["data"] === "object" && e["data"] !== null ? e["data"] : {}) as Record<string, unknown>;
  const sid = data["messageSid"];
  if (!isMessageSid(sid)) {
    // The key names say what shape arrived; the values would be the sender and the text.
    log.error("sink.bad_event", { reason: "no_sid", keys: Object.keys(data) });
    return 400;
  }
  if (outcome !== undefined) return handleDelivery(sid, outcome, data);
  // STOP, START and HELP: Twilio's Advanced Opt-Out answered these itself and kept them from the
  // /sms webhook, and the event stream still carries them, so they are skipped here the same way.
  if (typeof data["optOutType"] === "string" && data["optOutType"] !== "") {
    log.info("sink.ignored", { type, sid, opt_out: data["optOutType"] });
    return 200;
  }
  log.info("sink.inbound", { sid });
  const fetched = await fetchMessage(sid);
  if (fetched.kind === "retry") return 503;
  if (fetched.kind === "not_found") {
    log.error("sink.rejected", { sid, reason: "not_found" });
    return 404;
  }
  const m = fetched.message;
  if (m.direction !== "inbound" || m.to !== FORECAST_NUMBER) {
    log.error("sink.rejected", { sid, reason: "not_inbound", direction: m.direction });
    return 404;
  }
  const result = await queueMessage(sid, requestId, traceId, m.dateCreated);
  return result === "queued" ? 200 : 503;
}

// A delivery outcome for a reply the gateway sent, matched to its row by the Twilio SID. The
// row is only updated, never created, and the SID is Twilio's own, so no lookup at Twilio is
// needed first. A SID with no reply row is a 404: Twilio retries the event, which covers an
// event outrunning the row's SID write, and gives up on its own for a message that was never
// the gateway's.
async function handleDelivery(sid: string, outcome: DeliveryOutcome, data: Record<string, unknown>): Promise<number> {
  const at = Date.parse(typeof data["timestamp"] === "string" ? data["timestamp"] : "");
  const code = Number(data["errorCode"]);
  const errorCode = Number.isInteger(code) && code > 0 ? code : null;
  let found: boolean;
  try {
    found = await recordReplyDelivery(sid, outcome, Number.isNaN(at) ? new Date() : new Date(at), errorCode);
  } catch (e) {
    log.error("sink.delivery_failed", { sid, outcome, err: e });
    return 503;
  }
  if (!found) {
    log.info("sink.unknown_reply", { sid, outcome });
    return 404;
  }
  log.info("sink.delivery", { sid, outcome, code: errorCode });
  return 200;
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
