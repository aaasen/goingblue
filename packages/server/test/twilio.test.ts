import { describe, expect, it } from "vitest";
import { createHash, createHmac } from "node:crypto";
import { twiml, validateTwilioJsonSignature, validateTwilioSignature } from "../src/twilio.js";

// Reproduce Twilio's signing scheme so the test signs the same way the validator verifies.
function sign(authToken: string, url: string, params: Record<string, string>): string {
  let data = url;
  for (const key of Object.keys(params).sort()) data += key + params[key];
  return createHmac("sha1", authToken).update(data, "utf8").digest("base64");
}

describe("twiml", () => {
  it("wraps a message in a TwiML Response", () => {
    expect(twiml("hello")).toBe(
      '<?xml version="1.0" encoding="UTF-8"?>\n<Response><Message>hello</Message></Response>',
    );
  });

  it("escapes XML-special characters in the body", () => {
    expect(twiml(`a&b<c>d"e'f`)).toContain(
      "<Message>a&amp;b&lt;c&gt;d&quot;e&apos;f</Message>",
    );
  });

  it("emits a bare Response (no reply) for an empty or whitespace message", () => {
    expect(twiml("")).toBe('<?xml version="1.0" encoding="UTF-8"?>\n<Response></Response>');
    expect(twiml("   ")).toBe('<?xml version="1.0" encoding="UTF-8"?>\n<Response></Response>');
    expect(twiml([])).toBe('<?xml version="1.0" encoding="UTF-8"?>\n<Response></Response>');
  });

  it("emits one Message per array entry, dropping blank entries", () => {
    expect(twiml(["a", " ", "b"])).toBe(
      '<?xml version="1.0" encoding="UTF-8"?>\n<Response><Message>a</Message><Message>b</Message></Response>',
    );
  });
});

describe("validateTwilioSignature", () => {
  const authToken = "test-auth-token";
  const url = "https://going.blue/sms";
  const params = { Body: "l:14k r:3h", From: "+14254345858", To: "+15005550006" };

  it("accepts a correctly signed request", () => {
    const sig = sign(authToken, url, params);
    expect(validateTwilioSignature(authToken, sig, url, params)).toBe(true);
  });

  it("rejects a tampered body", () => {
    const sig = sign(authToken, url, params);
    const tampered = { ...params, Body: "l:summit" };
    expect(validateTwilioSignature(authToken, sig, url, tampered)).toBe(false);
  });

  it("rejects a request signed with a different auth token", () => {
    const sig = sign("wrong-token", url, params);
    expect(validateTwilioSignature(authToken, sig, url, params)).toBe(false);
  });

  it("rejects a mismatched URL", () => {
    const sig = sign(authToken, url, params);
    expect(validateTwilioSignature(authToken, sig, "https://evil.example/sms", params)).toBe(false);
  });

  it("rejects an empty signature", () => {
    expect(validateTwilioSignature(authToken, "", url, params)).toBe(false);
  });

  it("is independent of parameter insertion order (keys are sorted)", () => {
    const sig = sign(authToken, url, params);
    const reordered = { To: params.To, Body: params.Body, From: params.From };
    expect(validateTwilioSignature(authToken, sig, url, reordered)).toBe(true);
  });
});

// Twilio's scheme for JSON bodies: the body's SHA-256 rides on the URL as bodySHA256 and the
// signature covers that URL with no parameters.
describe("validateTwilioJsonSignature", () => {
  const authToken = "test-auth-token";
  const body = '[{"type":"com.twilio.eventstreams.test-event","data":{}}]';
  const signedUrl = (b: string) =>
    `https://going.blue/twilio-sink?bodySHA256=${createHash("sha256").update(b, "utf8").digest("hex")}`;

  it("accepts a correctly signed request", () => {
    const url = signedUrl(body);
    expect(validateTwilioJsonSignature(authToken, sign(authToken, url, {}), url, body)).toBe(true);
  });

  it("rejects a body that does not match the hash on the URL", () => {
    const url = signedUrl(body);
    expect(validateTwilioJsonSignature(authToken, sign(authToken, url, {}), url, body + " ")).toBe(false);
  });

  it("rejects a URL without the hash, a bad signature, and the wrong token", () => {
    const bare = "https://going.blue/twilio-sink";
    expect(validateTwilioJsonSignature(authToken, sign(authToken, bare, {}), bare, body)).toBe(false);
    const url = signedUrl(body);
    expect(validateTwilioJsonSignature(authToken, "nope", url, body)).toBe(false);
    expect(validateTwilioJsonSignature(authToken, sign("other", url, {}), url, body)).toBe(false);
    expect(validateTwilioJsonSignature(authToken, sign(authToken, url, {}), "not a url", body)).toBe(false);
  });
});
