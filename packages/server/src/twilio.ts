import { createHmac, timingSafeEqual } from "node:crypto";

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
