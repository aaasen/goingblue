import type { Context } from "hono";
import { readFile } from "node:fs/promises";
import { log } from "./log.js";

// Static images for the public pages. There are only a couple of them and they are small, so
// they are read once on first request and held in memory rather than pulling in a static-file
// middleware. Paths resolve relative to this module (dist/ at runtime), so `packages/server/public`
// is found whether the server is started from the repo root or from inside the container.
const ASSETS: Record<string, { file: string; type: string }> = {
  // The landing-page photo, resampled from ../assets/sultana.jpg — the master, cropped so the
  // summit is the center of the frame, which is the point the hero band crops around. Regenerate
  // both widths together, and bump the name if the page has shipped: these are served immutable
  // for a year, so a changed photo under an unchanged URL never reaches a repeat visitor. The
  // master is Display P3 and carries the camera's EXIF, so resizing is not the whole job: convert
  // to sRGB (browsers that ignore the embedded profile render P3 oversaturated) and drop EXIF
  // (the master is GPS-tagged). `sips` does neither, so resize with Pillow —
  //   img = ImageCms.profileToProfile(src, <master profile>, ImageCms.createProfile("sRGB"),
  //                                   outputMode="RGB")
  //   img.resize((w, round(w * src.height / src.width)), Image.LANCZOS).save(
  //       out, "JPEG", quality=70, optimize=True, progressive=True, icc_profile=<sRGB bytes>)
  // — which lands both files within a few KB of the weights they replaced.
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
