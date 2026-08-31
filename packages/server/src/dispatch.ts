import { isValidToken, normalizeToken } from "@weather/protocol";
import { log } from "./log.js";

// Routes a forecast request to the codec server for its protocol version. The gateway's
// knowledge of the message grammar is deliberately tiny — a `vN` version token to route by and
// a `u:` account token for quotas and logging — and that sliver is frozen forever: every
// deployed client, however old, must be parseable by the current gateway (VERSIONING.md).
// Everything else in the body is opaque here; it belongs to the versioned codec server.

// What the request asked for, as reported by the codec server in `X-Request-Shape`. The gateway
// treats this as untrusted input it merely relays to the database: it never parses the message
// grammar itself, because the grammar is version-specific and only the codec for that version
// knows what a mask or a token means (VERSIONING.md).
export interface RequestShape {
  lat: number | null;
  lon: number | null;
  loc: string | null;
  mode: string | null;
  // The header's "models" key is a list (and stays one: frozen containers send it forever), but
  // the codec only ever serves the first model named, so one name is what gets stored.
  model: string | null;
  vars: string[];
  maxChars: number | null;
  messages: number | null;
  // The `d:` route code, codec-reported: its codes belong to the versioned grammar, which the
  // gateway must not learn. Null for hand-typed messages and for containers frozen before the
  // header carried it.
  device: string | null;
}

export type DispatchResult =
  | { kind: "ok"; encoded: string; shape: RequestShape | null }
  | { kind: "missing_version" }
  | { kind: "unsupported_version"; version: number }
  // The codec rejected the request (400): not a well-formed request of its version. The reason
  // is the codec's response body, kept for logs and the HTTP route, never sent over SMS.
  | { kind: "malformed"; reason: string }
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

// Longest header we will parse. A shape is a few dozen bytes; anything approaching this is a
// misbehaving or compromised codec, and the cost of ignoring it is one row with no shape.
const MAX_SHAPE_BYTES = 2048;
const SHAPE_STRING_MAX = 32; // longest plausible mode/location/variable name
const SHAPE_LIST_MAX = 32;   // more entries than there are models or variables

// Coordinates are rounded to 0.01° by the codec (describeRequest). Re-round here rather than
// trusting it: this is the last point before the value is stored, and the promise that we keep
// only an approximate location should not depend on a remote service behaving.
function coord(v: unknown, limit: number): number | null {
  return typeof v === "number" && Number.isFinite(v) && Math.abs(v) <= limit
    ? Math.round(v * 100) / 100
    : null;
}

function shapeString(v: unknown): string | null {
  return typeof v === "string" && v.length > 0 && v.length <= SHAPE_STRING_MAX ? v : null;
}

function shapeList(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  return v.slice(0, SHAPE_LIST_MAX).map(shapeString).filter((s): s is string => s !== null);
}

// Parse the codec's shape header into exactly the fields we store, dropping anything else.
// Every failure mode — absent, oversized, malformed, wrong types — lands on null or an empty
// field rather than an error: the forecast has already been produced by this point, and no
// amount of bad telemetry should turn a served reply into a failure.
export function parseShapeHeader(header: string | null): RequestShape | null {
  if (!header || header.length > MAX_SHAPE_BYTES) return null;
  let raw: unknown;
  try {
    raw = JSON.parse(header);
  } catch {
    return null;
  }
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return null;
  const o = raw as Record<string, unknown>;
  const shapeInt = (v: unknown): number | null =>
    typeof v === "number" && Number.isInteger(v) ? v : null;
  return {
    lat: coord(o["lat"], 90),
    lon: coord(o["lon"], 180),
    loc: shapeString(o["loc"]),
    mode: shapeString(o["mode"]),
    model: shapeList(o["models"])[0] ?? null,
    vars: shapeList(o["vars"]),
    maxChars: shapeInt(o["maxChars"]),
    // Absent from codec images frozen before message counts existed; those replies were all
    // single messages, but null records "not reported" rather than guessing.
    messages: shapeInt(o["messages"]),
    device: shapeString(o["device"]),
  };
}

export async function dispatchForecast(body: string): Promise<DispatchResult> {
  const version = extractVersion(body);
  if (version === null) return { kind: "missing_version" };

  const url = codecUrlFor(version);
  if (!url) return { kind: "unsupported_version", version };

  try {
    const resp = await fetch(`${url}/encode`, { method: "POST", body });
    if (resp.ok) {
      return {
        kind: "ok",
        encoded: await resp.text(),
        shape: parseShapeHeader(resp.headers.get("X-Request-Shape")),
      };
    }
    const text = await resp.text();
    log.error("codec.error_response", { version, status: resp.status, body: text });
    // A 400 is the codec's verdict on the request itself; anything else (503, unexpected
    // statuses) is a service problem the sender should retry.
    if (resp.status === 400) return { kind: "malformed", reason: text.slice(0, 500) };
    return { kind: "unavailable" };
  } catch (e) {
    log.error("codec.unreachable", { version, err: e });
    return { kind: "unavailable" };
  }
}
