import type { Context } from "hono";
import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { gunzipSync } from "node:zlib";
import { log } from "./log.js";

// GET /benchmark — the encoding benchmark dashboard, a single self-contained HTML file produced
// by `pnpm benchmark` (packages/codec-server/scripts/benchmark.ts writes timestamped reports to
// data/benchmarks; publishing one is a manual copy, see the note in that script).
//
// Stored gzipped, and gzipped is also how it is served: the report is ~4 MB of markup that
// compresses 15:1, so the committed artifact is 265 KB instead of 4 MB — the same reasoning that
// keeps the photo originals out of packages/server/public. Every browser sends
// `Accept-Encoding: gzip`, so the identity copy is only ever materialized for a client that
// doesn't, and then it is cached too. Paths resolve relative to this module (dist/ at runtime),
// matching assets.ts.
const FILE = "../public/benchmark.html.gz";

// Unlike the images in assets.ts, this file is replaced in place under an unchanged URL whenever
// the benchmark is re-run, so it can't be served immutable. A short max-age plus a strong ETag
// keeps repeat views cheap while a fresh report still reaches visitors the same day.
const MAX_AGE = 3600;

let cached: { gz: Buffer<ArrayBuffer>; etag: string; raw?: Buffer<ArrayBuffer> } | null = null;

async function load(): Promise<typeof cached> {
  if (cached) return cached;
  try {
    const gz = await readFile(new URL(FILE, import.meta.url));
    // The ETag is over the compressed bytes, which is fine because it only ever labels this
    // one representation pair: gzip -9 is deterministic, so identical HTML yields identical gz.
    const etag = `"${createHash("sha256").update(gz).digest("hex").slice(0, 16)}"`;
    cached = { gz, etag };
    return cached;
  } catch (e) {
    log.error("benchmark.read_failed", { err: e });
    return null;
  }
}

export async function benchmark(c: Context) {
  const asset = await load();
  if (!asset) return c.text("Not found", 404);

  const headers: Record<string, string> = {
    "Content-Type": "text/html; charset=utf-8",
    "Cache-Control": `public, max-age=${MAX_AGE}`,
    "ETag": asset.etag,
    // The response body differs by encoding, so caches must key on the request header.
    "Vary": "Accept-Encoding",
  };

  if (c.req.header("If-None-Match") === asset.etag) return c.body(null, 304, headers);

  if ((c.req.header("Accept-Encoding") ?? "").includes("gzip")) {
    return c.body(asset.gz, 200, { ...headers, "Content-Encoding": "gzip" });
  }
  asset.raw ??= gunzipSync(asset.gz);
  return c.body(asset.raw, 200, headers);
}
