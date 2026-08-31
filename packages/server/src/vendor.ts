import type { Context } from "hono";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";

// Browser bundles for the stats map, served out of our own node_modules rather than a CDN: the
// stats page sits behind STATS_PASS, and a third-party script tag would hand whoever controls
// that CDN code execution on it. pnpm owns the versions; nothing is copied into the repo.
//
// MapLibre 6 is ESM in three files: the entry imports ./maplibre-gl-shared.mjs, and spawns its
// worker from ./maplibre-gl-worker.mjs resolved against the entry's own URL. All three must
// therefore be served under their real names in one directory, which rules out the per-file
// content hashing /img uses. Cache busting is a version segment on the directory instead: one
// hash over every vendored byte, so any upgrade moves the whole set to new URLs at once.
const require = createRequire(import.meta.url);

// pmtiles exports no dist subpaths, so resolve its main entry (dist/cjs/index.cjs) and step
// over to the browser IIFE bundle beside it. It has to be the IIFE (global `pmtiles`), not
// dist/esm: the ESM build imports its fflate dependency by bare specifier, which a browser
// cannot resolve without a bundler or an import map.
const pmtilesIife = fileURLToPath(
  new URL("../pmtiles.js", pathToFileURL(require.resolve("pmtiles"))),
);

const VENDOR: Record<string, { path: string; type: string }> = {
  "maplibre-gl.mjs": { path: require.resolve("maplibre-gl/dist/maplibre-gl.mjs"), type: "text/javascript" },
  "maplibre-gl-shared.mjs": { path: require.resolve("maplibre-gl/dist/maplibre-gl-shared.mjs"), type: "text/javascript" },
  "maplibre-gl-worker.mjs": { path: require.resolve("maplibre-gl/dist/maplibre-gl-worker.mjs"), type: "text/javascript" },
  "maplibre-gl.css": { path: require.resolve("maplibre-gl/dist/maplibre-gl.css"), type: "text/css" },
  "pmtiles.js": { path: pmtilesIife, type: "text/javascript" },
};

// Read everything at startup, like /img: a missing file is a crash at deploy, not a 404 for
// whoever loads the dashboard first after a bad upgrade.
const served = new Map<string, { bytes: Buffer<ArrayBuffer>; type: string }>();
const digest = createHash("sha256");
for (const [name, { path, type }] of Object.entries(VENDOR)) {
  const bytes: Buffer<ArrayBuffer> = readFileSync(path);
  digest.update(name).update(bytes);
  served.set(name, { bytes, type });
}
const VERSION = digest.digest("hex").slice(0, 8);

// The URL a page should link for a vendored file, version segment and all. Throwing on an
// unknown name makes a typo a startup crash rather than a production 404.
export function vendorUrl(name: string): string {
  if (!served.has(name)) throw new Error(`unknown vendor asset: ${name}`);
  return `/vendor/${VERSION}/${name}`;
}

// GET /vendor/:v/:name. Only the current version segment exists, so a hit really is the bytes
// the linking page was built against and can be cached hard; a stale link is a 404.
export function vendorAsset(c: Context): Response {
  const asset = c.req.param("v") === VERSION ? served.get(c.req.param("name") ?? "") : undefined;
  if (!asset) return c.text("Not found", 404);
  return c.body(asset.bytes, 200, {
    "Content-Type": asset.type,
    "Cache-Control": "public, max-age=31536000, immutable",
  });
}
