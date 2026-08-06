import type { Context } from "hono";
import { readFile } from "node:fs/promises";
import { log } from "./log.js";

// Static images for the public pages. There are only a couple of them and they are small, so
// they are read once on first request and held in memory rather than pulling in a static-file
// middleware. Paths resolve relative to this module (dist/ at runtime), so `packages/server/public`
// is found whether the server is started from the repo root or from inside the container.
const ASSETS: Record<string, { file: string; type: string }> = {
  "sultana-2400.jpg": { file: "../public/sultana-2400.jpg", type: "image/jpeg" },
  "sultana-1200.jpg": { file: "../public/sultana-1200.jpg", type: "image/jpeg" },
  // The app icon, resized from packages/mobile/assets/icon.png. Regenerate it from that source
  // (and bump the filename) whenever the app icon changes, so the two never drift apart.
  "icon-512.jpg": { file: "../public/icon-512.jpg", type: "image/jpeg" },
};

const cache = new Map<string, Buffer>();

async function load(name: string): Promise<Buffer | null> {
  const cached = cache.get(name);
  if (cached) return cached;
  const asset = ASSETS[name];
  if (!asset) return null;
  try {
    const bytes = await readFile(new URL(asset.file, import.meta.url));
    cache.set(name, bytes);
    return bytes;
  } catch (e) {
    log.error("asset.read_failed", { name, err: e });
    return null;
  }
}

// GET /img/:name — the filenames are content-versioned by hand (bump the number when the image
// changes), so they can be cached hard and forever.
export async function image(c: Context) {
  const name = c.req.param("name") ?? "";
  const asset = ASSETS[name];
  const bytes = asset ? await load(name) : null;
  if (!asset || !bytes) return c.text("Not found", 404);
  return c.body(bytes, 200, {
    "Content-Type": asset.type,
    "Cache-Control": "public, max-age=31536000, immutable",
  });
}
