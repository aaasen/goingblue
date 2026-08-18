import { createHmac } from "node:crypto";

// Sending numbers are stored as a keyed hash, never as numbers. Counting distinct senders and
// noticing one account texting from several handsets both need only to tell numbers apart, and
// a hash does that exactly as well as the number itself — while a database dump stops being a
// contact list, and an account deletion can't leave a reachable number behind.
//
// The key (PHONE_PEPPER) is what makes this one-way in practice. There are only ~10^10 numbers
// in E.164, so a bare SHA-256 of a phone number is reversed by enumerating them: a few minutes
// of GPU time recovers every number in the table. With a secret key mixed in, that enumeration
// is worthless without also stealing the key, which lives in Secret Manager rather than the
// database.
//
// You can still find a specific person's rows when you have to (support, abuse): hash the
// number they gave you and query for it. What you cannot do is go the other way.

// E.164: a leading +, a non-zero country digit, then 6..14 more digits. Twilio's `From` is
// already in this form; anything else is a caller we don't recognise and is not recorded.
const E164 = /^\+[1-9]\d{6,14}$/;

// Read per call rather than captured at import so a test — or a Cloud Run revision picking up a
// rotated secret — never fights a stale snapshot. The env lookup is far cheaper than the HMAC.
function pepper(): string | undefined {
  return process.env["PHONE_PEPPER"] || undefined;
}

export function hasPepper(): boolean {
  return pepper() !== undefined;
}

// HMAC-SHA256 of the number under the pepper, or null when there is no number, the number isn't
// E.164, or no pepper is configured.
//
// Returning null on a missing pepper — rather than falling back to an unkeyed digest — is the
// safe failure: an unkeyed digest looks exactly as opaque in the table while being trivially
// reversible, so the fallback would quietly store the very thing this module exists to avoid.
// Local dev runs without a pepper and simply records no sender.
export function hashPhone(e164: string | null | undefined): Buffer | null {
  const key = pepper();
  if (!key || !e164 || !E164.test(e164)) return null;
  return createHmac("sha256", key).update(e164).digest();
}
