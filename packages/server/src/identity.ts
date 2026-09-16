import { log } from "./log.js";

// Identity tokens for calling the codec services, which accept only IAM-authorized invokers.
// Minted by the Cloud Run metadata server for the runtime service account, with the codec
// service URL as the audience, which is what Cloud Run checks at its edge. No client library
// and no extra IAM grant: a service can always sign for its own identity.
//
// Enabled by CODEC_AUTH=iam. With it unset the codec is called bare, which is local dev (a
// codec on localhost) or a codec service that still allows unauthenticated calls.

const METADATA_IDENTITY_URL =
  "http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/identity";
const TIMEOUT_MS = 5_000;
// Tokens last an hour; the metadata server caches them itself, so this margin only has to
// cover this process's clock.
const REFRESH_MARGIN_MS = 60_000;
// When a token carries no readable expiry, refresh it after this long.
const DEFAULT_TTL_MS = 5 * 60_000;

export function codecAuthConfigured(): boolean {
  return process.env["CODEC_AUTH"] === "iam";
}

// One cached token per audience, since each codec service is its own audience.
const cached = new Map<string, { token: string; expiresAt: number }>();

export function resetIdentityTokens(): void {
  cached.clear();
}

function expiryOf(token: string): number {
  try {
    const payload = JSON.parse(Buffer.from(token.split(".")[1] ?? "", "base64url").toString("utf8")) as { exp?: unknown };
    if (typeof payload.exp === "number") return payload.exp * 1000;
  } catch {
    // Fall through to the default.
  }
  return Date.now() + DEFAULT_TTL_MS;
}

export async function identityToken(audience: string): Promise<string> {
  const hit = cached.get(audience);
  if (hit && Date.now() < hit.expiresAt - REFRESH_MARGIN_MS) return hit.token;
  const url = `${METADATA_IDENTITY_URL}?audience=${encodeURIComponent(audience)}`;
  const resp = await fetch(url, {
    headers: { "Metadata-Flavor": "Google" },
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!resp.ok) throw new Error(`metadata identity: HTTP ${resp.status}`);
  const token = (await resp.text()).trim();
  if (!token) throw new Error("metadata identity: empty token");
  cached.set(audience, { token, expiresAt: expiryOf(token) });
  log.info("identity.minted", { audience });
  return token;
}
