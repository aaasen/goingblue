import { createHmac, timingSafeEqual } from "node:crypto";
import { log } from "./log.js";

// XML special characters that must be escaped inside a TwiML text node / attribute.
function escapeXml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

// Build a TwiML response that replies to the inbound SMS with `message`. Returning this from the
// webhook is the whole outbound path: Twilio sends the reply to the original sender, so no Twilio
// REST credentials are needed. An empty/whitespace message yields a bare <Response/>, which tells
// Twilio to do nothing (no reply SMS) — used when we have no useful answer to send back. An array
// yields one <Message> per entry, i.e. separate SMS messages from a single inbound.
export function twiml(message: string | string[]): string {
  const parts = (Array.isArray(message) ? message : [message])
    .map((m) => m.trim())
    .filter(Boolean);
  const body = parts.map((m) => `<Message>${escapeXml(m)}</Message>`).join("");
  return `<?xml version="1.0" encoding="UTF-8"?>\n<Response>${body}</Response>`;
}

// Validate an inbound Twilio request signature (X-Twilio-Signature). Twilio signs the full
// request URL with the POST parameters appended (keys sorted, each key immediately followed by
// its value, no separators), HMAC-SHA1 keyed by the account auth token, base64-encoded. See
// https://www.twilio.com/docs/usage/security#validating-requests
//
// `url` must be the exact URL Twilio was configured to call, including scheme, host, path, and
// any query string. Behind a proxy (Cloud Run) the in-process URL may differ from the public
// one, so the caller can pin it via TWILIO_WEBHOOK_URL.
export function validateTwilioSignature(
  authToken: string,
  signature: string,
  url: string,
  params: Record<string, string>,
): boolean {
  if (!signature) return false;
  let data = url;
  for (const key of Object.keys(params).sort()) {
    data += key + params[key];
  }
  const expected = createHmac("sha1", authToken).update(data, "utf8").digest("base64");
  const a = Buffer.from(expected);
  const b = Buffer.from(signature);
  // Lengths must match before timingSafeEqual, which throws on differing-length buffers.
  return a.length === b.length && timingSafeEqual(a, b);
}

// Twilio REST client for the delivery path: the inbound
// message is read back by SID before it is answered, and replies go out through the Messages
// API rather than in the webhook response. Credentials are the account SID and auth token, the
// same token that verifies webhook signatures.

const TWILIO_API = "https://api.twilio.com/2010-04-01";
const TWILIO_TIMEOUT_MS = 10_000;

// Message SIDs: SM for SMS, MM for a message that carried media.
export function isMessageSid(s: unknown): s is string {
  return typeof s === "string" && /^(SM|MM)[0-9a-f]{32}$/i.test(s);
}

export interface InboundMessage {
  sid: string;
  direction: string;
  from: string;
  to: string;
  body: string;
  dateCreated: Date | null;
}

// A lookup either finds the message, learns it does not exist, or could not be completed
// (network, 5xx, 429, or missing credentials), which the caller retries.
export type FetchMessageResult =
  | { kind: "ok"; message: InboundMessage }
  | { kind: "not_found" }
  | { kind: "retry" };

// A send either gets a 201 with the new message's SID, is refused for this recipient (a 4xx
// other than 429: invalid number, opted out), or could not be completed and is retried. On
// `retry` the message may or may not have been created; see the claim rule in encode-task.ts.
export type SendMessageResult =
  | { kind: "sent"; sid: string; segments: number | null }
  | { kind: "rejected"; status: number; code: number | null }
  | { kind: "retry" };

function credentials(): { accountSid: string; auth: string } | null {
  const accountSid = process.env["TWILIO_ACCOUNT_SID"];
  const authToken = process.env["TWILIO_AUTH_TOKEN"];
  if (!accountSid || !authToken) return null;
  return { accountSid, auth: "Basic " + Buffer.from(`${accountSid}:${authToken}`).toString("base64") };
}

function str(v: unknown): string {
  return typeof v === "string" ? v : "";
}

// Twilio's JSON error body carries the API error code (e.g. 21610, opted out) as `code`.
async function errorCode(resp: Response): Promise<number | null> {
  try {
    const body = await resp.json() as { code?: unknown };
    return typeof body.code === "number" ? body.code : null;
  } catch {
    return null;
  }
}

export async function fetchMessage(sid: string): Promise<FetchMessageResult> {
  const creds = credentials();
  if (!creds) {
    log.error("twilio.no_credentials");
    return { kind: "retry" };
  }
  let resp: Response;
  try {
    resp = await fetch(`${TWILIO_API}/Accounts/${creds.accountSid}/Messages/${sid}.json`, {
      headers: { Authorization: creds.auth },
      signal: AbortSignal.timeout(TWILIO_TIMEOUT_MS),
    });
  } catch (e) {
    log.error("twilio.fetch_unreachable", { sid, err: e });
    return { kind: "retry" };
  }
  if (resp.status === 404) return { kind: "not_found" };
  if (!resp.ok) {
    log.error("twilio.fetch_failed", { sid, status: resp.status, code: await errorCode(resp) });
    return { kind: "retry" };
  }
  const m = await resp.json() as Record<string, unknown>;
  const created = Date.parse(str(m["date_created"]));
  return {
    kind: "ok",
    message: {
      sid: str(m["sid"]) || sid,
      direction: str(m["direction"]),
      from: str(m["from"]),
      to: str(m["to"]),
      body: str(m["body"]),
      dateCreated: Number.isNaN(created) ? null : new Date(created),
    },
  };
}

export async function sendMessage(to: string, from: string, body: string): Promise<SendMessageResult> {
  const creds = credentials();
  if (!creds) {
    log.error("twilio.no_credentials");
    return { kind: "retry" };
  }
  let resp: Response;
  try {
    resp = await fetch(`${TWILIO_API}/Accounts/${creds.accountSid}/Messages.json`, {
      method: "POST",
      headers: { Authorization: creds.auth, "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ To: to, From: from, Body: body }),
      signal: AbortSignal.timeout(TWILIO_TIMEOUT_MS),
    });
  } catch (e) {
    log.error("twilio.send_unreachable", { err: e });
    return { kind: "retry" };
  }
  if (resp.status === 201 || resp.status === 200) {
    const m = await resp.json() as Record<string, unknown>;
    // num_segments is a decimal string in Twilio's JSON.
    const segments = parseInt(str(m["num_segments"]));
    return { kind: "sent", sid: str(m["sid"]), segments: Number.isNaN(segments) ? null : segments };
  }
  const code = await errorCode(resp);
  if (resp.status === 429 || resp.status >= 500) {
    log.error("twilio.send_failed", { status: resp.status, code });
    return { kind: "retry" };
  }
  log.error("twilio.send_rejected", { status: resp.status, code });
  return { kind: "rejected", status: resp.status, code };
}
