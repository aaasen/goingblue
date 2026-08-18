/**
 * Records the golden corpus: for each representative request, the exact Open-Meteo responses
 * and the exact encoded output, written to test/golden/goldens.json. Run this at SHIP time —
 * the moment the current protocol version reaches real clients — and commit the result; from
 * then on golden.test.ts fails any change that moves a bit of this version's output, which is
 * exactly a change that would break deployed clients (see VERSIONING.md).
 *
 * Hits the live Open-Meteo API once per case (the EU center twice: split surface/pressure
 * sources). Re-recording is only legitimate alongside a deliberate protocol version bump.
 *
 *   pnpm --filter @weather/protocol build
 *   pnpm exec tsx scripts/record-goldens.ts               # from packages/codec-server
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { CODECS, supportedVersions } from "@weather/protocol";
import { fetchForecast, parseRequest } from "../src/forecast.ts";

const OUT_PATH = join(dirname(fileURLToPath(import.meta.url)), "..", "test", "golden", "goldens.json");

// Sites spanning the codec's operating envelope: named-location and GPS parsing, hemispheres,
// seasons-at-record-time, maritime vs. continental vs. high-altitude regimes.
const SITES = [
  { name: "denali-14k", loc: "l:14k", z: -9 },
  { name: "chamonix", loc: "45.8326,6.8652", z: 1 },
  { name: "aconcagua", loc: "-32.6532,-70.0109", z: -3 },
  { name: "rainier", loc: "46.8523,-121.7603", z: -8 },
  { name: "ben-nevis", loc: "56.7969,-5.0036", z: 0 },
  { name: "aoraki", loc: "-43.5950,170.1418", z: 12 },
];

// One variant per center so every upstream source shape is pinned, crossed with the three
// priority modes, both budget regimes, and the configurable-variable groups. The `ca` case
// also exercises the GEM horizon clamp (nulls past day 10 → seq search clamps).
const VARIANTS = [
  { name: "auto-best", tokens: "p:a m:best c:160" },
  { name: "detail-us-pcwf", tokens: "p:d m:us c:160 v:pcwf" },
  { name: "range-eu-320", tokens: "p:r m:eu c:320" },
  { name: "auto-ca-80-c", tokens: "p:a m:ca c:80 v:c" },
  // Air quality pins the second upstream API's response shape alongside the weather one, and
  // `aso` is the selection where the US headline codes as a residual against its sub-indices —
  // the one air-quality path with a context switch in it. Range reaches past the 4-day CAMS
  // horizon, so the clamp is pinned here too.
  { name: "range-best-aso", tokens: "p:r m:best c:320 v:aso" },
  { name: "auto-best-e2", tokens: "p:a m:best c:160 v:e2" },
];

interface GoldenCase {
  name: string;
  request: string;
  // Open-Meteo FlatBuffers responses, base64-encoded, keyed by request path+query (origin
  // stripped, so replay is independent of OPEN_METEO_BASE_URL). The SDK transport is binary, so
  // the recorded body is the raw response bytes rather than parsed JSON.
  responses: Record<string, string>;
  encoded: string;
}

// Strip whichever origin the request went to (weather and air quality live on different
// hosts), matching how golden.test.ts and verify-container key their lookups.
function keyOf(url: string): string {
  return url.replace(/^https?:\/\/[^/]+/, "");
}

const version = Math.max(...supportedVersions());
const codec = CODECS[version];
const startEpochHour = Math.floor(Date.now() / 3600000);

const cases: GoldenCase[] = [];
const realFetch = globalThis.fetch;
let recording: Record<string, string> = {};

// Record by interception rather than a separate fetch pass so the pinned responses are, by
// construction, exactly the bytes the pipeline consumed to produce the pinned output. The SDK
// reads the body as an ArrayBuffer, so we capture the raw bytes (base64) and hand a fresh
// Response with the same bytes back to the caller.
globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = String(input);
  const resp = await realFetch(input as never, init as never);
  const bytes = new Uint8Array(await resp.arrayBuffer());
  if (resp.ok) recording[keyOf(url)] = Buffer.from(bytes).toString("base64");
  return new Response(bytes, { status: resp.status });
}) as typeof fetch;

let k = 0;
for (const site of SITES) {
  for (const variant of VARIANTS) {
    const request = `v${version} ${site.loc} z:${site.z} ${variant.tokens} k:${k} t:${startEpochHour}`;
    k = (k + 1) % 128;
    recording = {};
    const params = parseRequest(request);
    const encoded = await fetchForecast(params, codec);
    cases.push({ name: `${site.name}/${variant.name}`, request, responses: recording, encoded });
    console.log(`${site.name}/${variant.name}: ${encoded.length} chars, ${Object.keys(recording).length} upstream responses`);
    await new Promise((r) => setTimeout(r, 500)); // be polite to the live API
  }
}

mkdirSync(dirname(OUT_PATH), { recursive: true });
writeFileSync(
  OUT_PATH,
  JSON.stringify({ recordedAt: new Date().toISOString(), protocolVersion: version, cases }, null, 1),
);
console.log(`\nWrote ${cases.length} golden cases for protocol v${version} to ${OUT_PATH}`);
