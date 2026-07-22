import { isValidToken, normalizeToken } from "@weather/protocol";

// Routes a forecast request to the codec server for its protocol version. The gateway's
// knowledge of the message grammar is deliberately tiny — a `vN` version token to route by and
// a `u:` account token for quotas and logging — and that sliver is frozen forever: every
// deployed client, however old, must be parseable by the current gateway (VERSIONING.md).
// Everything else in the body is opaque here; it belongs to the versioned codec server.

export type DispatchResult =
  | { kind: "ok"; encoded: string }
  | { kind: "missing_version" }
  | { kind: "unsupported_version"; version: number }
  | { kind: "unavailable" };

// First `vN` word in the body, or null. A version is required — there is no default, so a
// request from any era either names a version we still run or gets a clear reply saying so.
export function extractVersion(body: string): number | null {
  for (const word of body.toLowerCase().trim().split(/\s+/)) {
    if (/^v\d+$/.test(word)) return parseInt(word.slice(1));
  }
  return null;
}

// Normalized account token from the first valid `u:` word, or null when absent/malformed —
// same acceptance rule as the codec's parseRequest, minus the lowercasing subtlety handled
// by normalizeToken.
export function extractUserToken(body: string): string | null {
  for (const word of body.toLowerCase().trim().split(/\s+/)) {
    if (word.startsWith("u:") && isValidToken(word.slice(2))) {
      return normalizeToken(word.slice(2));
    }
  }
  return null;
}

// Version → codec-server base URL, from CODEC_URL_V<N> env vars (e.g. CODEC_URL_V1). A version
// with no mapping is unsupported: either it never existed, or its container has been sunset.
// Read per-request so tests and config reloads never fight a startup snapshot.
export function codecUrlFor(version: number): string | null {
  return process.env[`CODEC_URL_V${version}`] || null;
}

export async function dispatchForecast(body: string): Promise<DispatchResult> {
  const version = extractVersion(body);
  if (version === null) return { kind: "missing_version" };

  const url = codecUrlFor(version);
  if (!url) return { kind: "unsupported_version", version };

  try {
    const resp = await fetch(`${url}/encode`, { method: "POST", body });
    if (resp.ok) return { kind: "ok", encoded: await resp.text() };
    console.error(`codec v${version} responded ${resp.status}: ${await resp.text()}`);
    return { kind: "unavailable" };
  } catch (e) {
    console.error(`codec v${version} unreachable:`, e);
    return { kind: "unavailable" };
  }
}
