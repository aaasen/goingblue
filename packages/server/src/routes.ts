import type { Context } from "hono";
import { fetchForecast, parseRequest } from "./forecast.js";
import { sendGarminReply } from "./garmin.js";
import { ping } from "./db.js";
import { createAccount, accountExists, recordRequest } from "./accounts.js";
import { CODECS, isValidToken, normalizeToken } from "@weather/protocol";

const REPLY_ADDRESS = "wx@email.laneaasen.com";

// Record a served request without ever failing the response: the forecast is already built
// by the time we get here, so a DB hiccup must not turn a successful reply into an error.
async function logRequest(token: string | null, chars: number): Promise<void> {
  try {
    await recordRequest(token, chars);
  } catch (e) {
    console.error("recordRequest failed:", e);
  }
}

export async function forecast(c: Context) {
  const body = await c.req.text();
  const params = parseRequest(body.trim());
  console.log("forecast request:", params);
  const codec = CODECS[params.decoderVersion];
  if (!codec) {
    const supported = Object.keys(CODECS).map((v) => `v${v}`).join(", ");
    return c.text(`Unsupported protocol version: v${params.decoderVersion}. Supported: ${supported}`, 400);
  }
  try {
    const encoded = await fetchForecast(params, codec);
    await logRequest(params.userToken, encoded.length);
    return c.text(encoded, 200);
  } catch (e) {
    console.error("fetchForecast failed:", e);
    return c.text("Forecast unavailable", 503);
  }
}

export async function inbound(c: Context) {
  const form = await c.req.parseBody();
  const text = String(form["text"] ?? "");
  const sender = String(form["from"] ?? "");
  const match = text.match(/https:\/\/inreachlink\.com\/\S+/);
  const replyUrl = match?.[0] ?? null;

  console.log("=== Inbound Email ===");
  console.log("from:", sender);
  console.log("subject:", form["subject"]);
  console.log("text:", text);
  console.log("reply_url:", replyUrl);

  if (replyUrl) {
    const body = text.replace(replyUrl, "").trim();
    const params = parseRequest(body);
    console.log("forecast request params:", params);

    const codec = CODECS[params.decoderVersion];
    if (!codec) {
      console.error(`Unsupported protocol version: v${params.decoderVersion}`);
      return c.text("OK", 200);
    }

    let encoded: string;
    try {
      encoded = await fetchForecast(params, codec);
      console.log(`forecast fetched (len=${encoded.length}): ${encoded}`);
    } catch (e) {
      console.error("fetchForecast failed:", e);
      return c.text("OK", 200);
    }

    await logRequest(params.userToken, encoded.length);

    try {
      const success = await sendGarminReply(replyUrl, REPLY_ADDRESS, encoded);
      console.log("garmin reply sent:", success);
    } catch (e) {
      console.error("sendGarminReply failed:", e);
    }
  }

  return c.text("OK", 200);
}

export async function health(c: Context) {
  const dbUp = await ping();
  // Always 200 so this stays a valid liveness probe; the body reports DB reachability.
  return c.text(`OK db:${dbUp ? "up" : "down"}`, 200);
}

// POST /account { smsConsent } — mint a new account token. Called once over normal internet
// during app setup (not over satellite). The user must opt in to receiving text messages, so
// the request is rejected unless smsConsent is true. Returns { token }.
export async function createAccountRoute(c: Context) {
  const body = await c.req.json().catch(() => ({} as Record<string, unknown>));
  if (body?.smsConsent !== true) {
    return c.text("SMS consent is required to create an account", 400);
  }
  try {
    const token = await createAccount(true);
    return c.json({ token });
  } catch (e) {
    console.error("createAccount failed:", e);
    return c.text("Could not create account", 503);
  }
}

// POST /account/verify { token } — used by the import flow to confirm an existing token is
// real. A malformed token (bad check symbol) is reported as { valid: false } without a DB
// lookup; a DB error is surfaced as 503 so the client retries rather than concluding the
// token is invalid.
export async function verifyAccountRoute(c: Context) {
  const body = await c.req.json().catch(() => ({} as Record<string, unknown>));
  const raw = typeof body?.token === "string" ? body.token : "";
  if (!isValidToken(raw)) return c.json({ valid: false });
  try {
    const exists = await accountExists(normalizeToken(raw));
    return c.json({ valid: exists });
  } catch (e) {
    console.error("verifyAccount failed:", e);
    return c.text("Verification unavailable", 503);
  }
}

const TEST_HTML = (opts: {
  replyUrl: string;
  replyAddress: string;
  message: string;
  result: string;
}) => `<!doctype html>
<html>
<head><meta charset=utf-8><title>Garmin Reply Test</title>
<style>
  body { font-family: sans-serif; max-width: 600px; margin: 40px auto; padding: 0 16px; }
  label { display: block; margin-top: 16px; font-weight: bold; }
  input, textarea { width: 100%; box-sizing: border-box; padding: 6px; margin-top: 4px; font-family: monospace; }
  textarea { height: 80px; }
  button { margin-top: 16px; padding: 8px 20px; font-size: 1em; cursor: pointer; }
  pre { background: #f4f4f4; padding: 12px; white-space: pre-wrap; word-break: break-all; }
  .ok { color: green; } .err { color: red; }
</style>
</head>
<body>
<h2>Garmin Reply Test</h2>
<form method=post>
  <label>Reply URL (inreachlink.com/…)</label>
  <input name=reply_url value="${opts.replyUrl}" required>
  <label>Reply address</label>
  <input name=reply_address value="${opts.replyAddress}">
  <label>Message</label>
  <textarea name=message>${opts.message}</textarea>
  <button type=submit>Send</button>
</form>
${opts.result}
</body></html>`;

export async function testPage(c: Context) {
  let replyUrl = "";
  let replyAddress = "wx@email.laneaasen.com";
  let message = "";
  let resultHtml = "";

  if (c.req.method === "POST") {
    const form = await c.req.parseBody();
    replyUrl = String(form["reply_url"] ?? "").trim();
    replyAddress = String(form["reply_address"] ?? replyAddress).trim();
    message = String(form["message"] ?? "").trim();
    try {
      const success = await sendGarminReply(replyUrl, replyAddress, message);
      resultHtml = success
        ? `<p class=ok><b>Success</b></p>`
        : `<p class=err><b>Failed</b></p>`;
    } catch (e) {
      resultHtml = `<pre class=err>${e}</pre>`;
    }
  }

  return c.html(TEST_HTML({ replyUrl, replyAddress, message, result: resultHtml }));
}
