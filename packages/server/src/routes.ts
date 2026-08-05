import type { Context } from "hono";
import { dispatchForecast, extractUserToken, extractVersion, type DispatchResult } from "./dispatch.js";
import { ping } from "./db.js";
import { createAccount, accountExists, recordRequest } from "./accounts.js";
import { isValidToken, normalizeToken } from "@weather/protocol";
import { twiml, validateTwilioSignature } from "./twilio.js";
import { probeReply } from "./probes.js";
import { log } from "./log.js";

// Standard HELP keyword response. STOP/START are handled by Twilio's Advanced Opt-Out and never
// reach this webhook; HELP is forwarded here so we control the reply text. Identifies the brand,
// what the service does, that rates may apply, and how to opt out and get support — the
// disclosures carriers expect in a HELP response. Kept short to fit a single SMS segment.
const HELP_REPLY =
  "Going Blue: weather forecasts by text, sent only in reply to a request you send. " +
  "Msg&data rates may apply. Reply STOP to opt out. Help: laneaasen@gmail.com";

// Inbound bodies that should get the HELP response rather than a forecast. Matched as the whole
// trimmed message, case-insensitively, so a forecast request is never mistaken for a keyword.
const HELP_KEYWORDS = new Set(["help", "info"]);

// Human-readable replies for requests the gateway cannot route. These go back over SMS, so
// they must be short and tell a person in the field what to do next.
const REPLY_MISSING_VERSION =
  'Missing protocol version: include a version word (e.g. "v1") or update the Going Blue app.';
const replyUnsupported = (v: number) =>
  `Protocol v${v} is no longer supported. Please update the Going Blue app and resend.`;
const REPLY_UNAVAILABLE = "Forecast unavailable, please try again.";

function replyFor(result: DispatchResult): string {
  switch (result.kind) {
    case "ok": return result.encoded;
    case "missing_version": return REPLY_MISSING_VERSION;
    case "unsupported_version": return replyUnsupported(result.version);
    case "unavailable": return REPLY_UNAVAILABLE;
  }
}

// Record a served request without ever failing the response: the forecast is already built
// by the time we get here, so a DB hiccup must not turn a successful reply into an error.
async function logRequest(token: string | null, chars: number, version: number | null): Promise<void> {
  try {
    await recordRequest(token, chars, version);
  } catch (e) {
    log.error("request.record_failed", { err: e });
  }
}

// Dispatch a request body to its version's codec server and record a served forecast. The
// per-version request counts are the sunset metric: a frozen codec container is retired only
// once its version has gone quiet (VERSIONING.md).
async function buildForecast(body: string): Promise<DispatchResult> {
  const version = extractVersion(body);
  const result = await dispatchForecast(body);
  log.info("forecast.dispatch", {
    version,
    kind: result.kind,
    chars: result.kind === "ok" ? result.encoded.length : undefined,
  });
  if (result.kind === "ok") {
    await logRequest(extractUserToken(body), result.encoded.length, version);
  }
  return result;
}

export async function forecast(c: Context) {
  const result = await buildForecast((await c.req.text()).trim());
  switch (result.kind) {
    case "ok": return c.text(result.encoded, 200);
    case "missing_version": return c.text(REPLY_MISSING_VERSION, 400);
    case "unsupported_version": return c.text(replyFor(result), 400);
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

  const body = params["Body"] ?? "";
  const sender = params["From"] ?? "";
  log.info("sms.inbound", { from: sender, len: body.length, text: body });

  if (HELP_KEYWORDS.has(body.trim().toLowerCase())) {
    return c.text(twiml(HELP_REPLY), 200, { "Content-Type": "text/xml" });
  }

  // Character-set field probes ("probe N") — see probes.ts. Handled before forecast dispatch
  // and never recorded as a served request.
  const probe = probeReply(body);
  if (probe !== null) {
    log.info("sms.probe_reply", { len: probe.length, reply: probe });
    return c.text(twiml(probe), 200, { "Content-Type": "text/xml" });
  }

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
    log.error("account.verify_failed", { err: e });
    return c.text("Verification unavailable", 503);
  }
}
