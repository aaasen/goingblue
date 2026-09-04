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
  // What the reply actually carries: hours-per-period → how many periods of that resolution,
  // so the sum is the reply's total period count. Null from containers frozen before the codec
  // reported it.
  periods: Record<string, number> | null;
  // The codec's own account of where its time went: the Open-Meteo fetch and the encode
  // search. Their gap to codec_ms (measured here, around the whole call) is container
  // overhead.
  fetchMs: number | null;
  encodeMs: number | null;
}

export type DispatchResult =
  | { kind: "ok"; encoded: string; shape: RequestShape | null; codecMs: number }
  | { kind: "missing_version" }
  | { kind: "unsupported_version"; version: number }
  // The codec rejected the request (400): not a well-formed request of its version. The reason
  // is the codec's response body, kept for logs and the HTTP route, never sent over SMS.
  | { kind: "malformed"; reason: string; codecMs: number }
  // The codec's 422s: a well-formed request whose start time is off the servable axis, either
  // stale (delivery delay) or from the future (a wrong clock). Not retryable as sent.
  | { kind: "stale"; codecMs: number }
  | { kind: "future"; codecMs: number }
  | { kind: "unavailable"; codecMs: number };

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
const SHAPE_INT_MAX = 2 ** 31 - 1; // Postgres `integer`, where every shape int lands

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

// The periods dictionary (hours-per-period → count), validated shallowly: a small object whose
// keys are short digit strings and whose values are small positive integers. Anything else —
// wrong type, absurd keys, an entry count no real layout produces — reads as "not reported"
// rather than being stored.
function shapePeriods(v: unknown): Record<string, number> | null {
  if (typeof v !== "object" || v === null || Array.isArray(v)) return null;
  const entries = Object.entries(v as Record<string, unknown>);
  if (entries.length === 0 || entries.length > SHAPE_LIST_MAX) return null;
  const out: Record<string, number> = {};
  for (const [key, val] of entries) {
    if (!/^\d{1,3}$/.test(key)) return null;
    if (typeof val !== "number" || !Number.isInteger(val) || val < 1 || val > 1000) return null;
    out[key] = val;
  }
  return out;
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
  // Bounded like coord(): none of these is legitimately negative or near the column's range, and
  // an out-of-range value must read as "not reported" rather than fail the insert — containers
  // frozen before v4 report an uncapped budget as MAX_SAFE_INTEGER forever.
  const shapeInt = (v: unknown): number | null =>
    typeof v === "number" && Number.isInteger(v) && v >= 0 && v <= SHAPE_INT_MAX ? v : null;
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
    periods: shapePeriods(o["periods"]),
    fetchMs: shapeInt(o["fetchMs"]),
    encodeMs: shapeInt(o["encodeMs"]),
  };
}

// `requestId` and `traceId` are passed rather than read from the logger's ambient store because
// they travel on the wire: the codec tags its own lines with both, so one request reads as one
// sequence across both services and nests under one request log in the Logs Explorer.
export async function dispatchForecast(
  body: string,
  requestId: string,
  traceId: string | null,
): Promise<DispatchResult> {
  const version = extractVersion(body);
  if (version === null) return { kind: "missing_version" };

  const url = codecUrlFor(version);
  if (!url) return { kind: "unsupported_version", version };

  // Wall time of the whole codec call, body included, on every path that actually reached one:
  // the gateway's own view of response time, next to the codec's reported components.
  const start = Date.now();
  try {
    const resp = await fetch(`${url}/encode`, {
      method: "POST",
      body,
      headers: traceId === null
        ? { "X-Request-Id": requestId }
        : { "X-Request-Id": requestId, "X-Cloud-Trace-Context": traceId },
    });
    if (resp.ok) {
      const encoded = await resp.text();
      return {
        kind: "ok",
        encoded,
        shape: parseShapeHeader(resp.headers.get("X-Request-Shape")),
        codecMs: Date.now() - start,
      };
    }
    const text = await resp.text();
    log.error("codec.error_response", { version, status: resp.status, body: text });
    const codecMs = Date.now() - start;
    // A 400 is the codec's verdict on the request itself, and a 422 names which side of the
    // servable axis its start time fell on (its body is exactly the word); anything else (503,
    // unexpected statuses, an unrecognized 422 body) is a service problem the sender should retry.
    if (resp.status === 400) return { kind: "malformed", reason: text.slice(0, 500), codecMs };
    if (resp.status === 422 && (text === "stale" || text === "future")) return { kind: text, codecMs };
    return { kind: "unavailable", codecMs };
  } catch (e) {
    log.error("codec.unreachable", { version, err: e });
    return { kind: "unavailable", codecMs: Date.now() - start };
  }
}
