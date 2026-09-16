import { createPublicKey, verify as verifySignature, type KeyObject } from "node:crypto";
import type { Context, Next } from "hono";
import { log } from "./log.js";

// Who is calling: the Google identity token that Cloud Tasks and Cloud Scheduler attach to
// their requests, verified here because the service allows unauthenticated calls and Cloud Run
// therefore checks nothing itself. A token is a JWT signed by Google, and a caller is accepted
// when the signature checks out against Google's published keys, the token was minted for this
// route (its audience is the route's public URL) and for the service account the tasks and the
// scheduler job run as (INVOKER_EMAIL), and it has not expired.
//
// With INVOKER_EMAIL unset nothing is checked, which is local dev: no queue, no scheduler, and
// the routes are called by hand.

const CERTS_URL = "https://www.googleapis.com/oauth2/v3/certs";
const ISSUERS = new Set(["https://accounts.google.com", "accounts.google.com"]);
const FETCH_TIMEOUT_MS = 5_000;
// Google rotates keys; a token signed by a key not in the cache triggers one refetch, but not
// more often than this, so a stream of junk tokens cannot turn into a stream of fetches.
const REFETCH_MIN_MS = 5 * 60_000;
const DEFAULT_TTL_MS = 3_600_000;
const CLOCK_SKEW_S = 60;

export type VerifyResult =
  | { kind: "ok"; email: string }
  // The token is not acceptable, for the reason given.
  | { kind: "rejected"; reason: string }
  // Google's keys could not be fetched, so nothing can be said about the token.
  | { kind: "unavailable" };

let keys: { byKid: Map<string, KeyObject>; fetchedAt: number; expiresAt: number } | null = null;

async function fetchKeys(): Promise<boolean> {
  let resp: Response;
  try {
    resp = await fetch(CERTS_URL, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
  } catch (e) {
    log.error("invoker.certs_unreachable", { err: e });
    return false;
  }
  if (!resp.ok) {
    log.error("invoker.certs_failed", { status: resp.status });
    return false;
  }
  const body = await resp.json() as { keys?: unknown };
  const byKid = new Map<string, KeyObject>();
  for (const jwk of Array.isArray(body.keys) ? body.keys as Record<string, unknown>[] : []) {
    if (typeof jwk["kid"] !== "string" || jwk["kty"] !== "RSA") continue;
    try {
      byKid.set(jwk["kid"], createPublicKey({ key: jwk, format: "jwk" }));
    } catch (e) {
      log.error("invoker.bad_jwk", { kid: jwk["kid"], err: e });
    }
  }
  const maxAge = /max-age=(\d+)/.exec(resp.headers.get("cache-control") ?? "")?.[1];
  const ttl = maxAge ? parseInt(maxAge) * 1000 : DEFAULT_TTL_MS;
  keys = { byKid, fetchedAt: Date.now(), expiresAt: Date.now() + ttl };
  return true;
}

// The key for `kid`, from the cache or a fresh fetch; null when unknown even after fetching,
// undefined when the fetch itself failed.
async function keyFor(kid: string): Promise<KeyObject | null | undefined> {
  const now = Date.now();
  if (keys === null || now >= keys.expiresAt) {
    if (!(await fetchKeys())) return undefined;
  }
  const hit = keys!.byKid.get(kid);
  if (hit) return hit;
  if (now - keys!.fetchedAt < REFETCH_MIN_MS) return null;
  if (!(await fetchKeys())) return undefined;
  return keys!.byKid.get(kid) ?? null;
}

function decodeSegment(s: string): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(Buffer.from(s, "base64url").toString("utf8"));
    return parsed !== null && typeof parsed === "object" ? parsed as Record<string, unknown> : null;
  } catch {
    return null;
  }
}

export async function verifyInvoker(token: string, audience: string, email: string): Promise<VerifyResult> {
  const parts = token.split(".");
  if (parts.length !== 3) return { kind: "rejected", reason: "malformed" };
  const [h, p, s] = parts as [string, string, string];
  const header = decodeSegment(h);
  const claims = decodeSegment(p);
  if (header === null || claims === null) return { kind: "rejected", reason: "malformed" };
  if (header["alg"] !== "RS256" || typeof header["kid"] !== "string") return { kind: "rejected", reason: "alg" };

  const key = await keyFor(header["kid"]);
  if (key === undefined) return { kind: "unavailable" };
  if (key === null) return { kind: "rejected", reason: "unknown_key" };
  const valid = verifySignature("sha256", Buffer.from(`${h}.${p}`), key, Buffer.from(s, "base64url"));
  if (!valid) return { kind: "rejected", reason: "signature" };

  const now = Math.floor(Date.now() / 1000);
  if (typeof claims["iss"] !== "string" || !ISSUERS.has(claims["iss"])) return { kind: "rejected", reason: "issuer" };
  if (claims["aud"] !== audience) return { kind: "rejected", reason: "audience" };
  if (typeof claims["exp"] !== "number" || claims["exp"] + CLOCK_SKEW_S < now) return { kind: "rejected", reason: "expired" };
  if (typeof claims["iat"] === "number" && claims["iat"] - CLOCK_SKEW_S > now) return { kind: "rejected", reason: "future" };
  if (claims["email"] !== email || claims["email_verified"] !== true) return { kind: "rejected", reason: "email" };
  return { kind: "ok", email };
}

// The service account the tasks and the scheduler job run as. Unset means no check.
export function invokerEmail(): string | null {
  return process.env["INVOKER_EMAIL"] || null;
}

// Middleware for a route only Google's task and scheduler services should call. `audienceEnv`
// names the env var holding the route's public URL, which is the audience the token must carry.
//
// A request with no token is a 401 at WARNING: the URL is public, and that is a scanner. A
// token that fails is a 403 at ERROR: someone minted a Google token for this URL and it did not
// match, which after a deploy means the audience or the account is misconfigured. Keys that
// cannot be fetched are a 503, so a task is retried rather than refused.
export function requireInvoker(audienceEnv: string) {
  return async (c: Context, next: Next) => {
    const email = invokerEmail();
    if (email === null) return next();
    const audience = process.env[audienceEnv];
    if (!audience) {
      log.error("invoker.no_audience", { env: audienceEnv });
      return c.text("Misconfigured", 500);
    }
    const auth = c.req.header("Authorization") ?? "";
    if (!auth.startsWith("Bearer ")) {
      log.warn("invoker.missing", { path: c.req.path });
      return c.text("Unauthorized", 401);
    }
    const result = await verifyInvoker(auth.slice("Bearer ".length).trim(), audience, email);
    switch (result.kind) {
      case "ok": return next();
      case "unavailable": return c.text("Unavailable", 503);
      case "rejected":
        log.error("invoker.rejected", { path: c.req.path, reason: result.reason });
        return c.text("Forbidden", 403);
    }
  };
}
