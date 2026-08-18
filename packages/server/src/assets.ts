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
  // The landing page's screenshot strip, listed here in the order the strip draws them, which is
  // the App Store listing's order. These are the App Store frames themselves — sky, device and
  // baked-in caption — resized from packages/mobile/screenshots/framed (the 1320x2868 output of
  // mobile's scripts/frame-screenshots.py, already sRGB with no EXIF, so a plain Pillow resize +
  // `save(out, "JPEG", quality=78, optimize=True, progressive=True)` is the whole job).
  //
  // Five of the listing's six: the detail shot is dropped here and kept there. The strip fits its
  // whole set on one row at once, so every shot added costs the others width, and six left them
  // too small to read; a store listing shows one at a time and pays no such price.
  //
  // 720px keeps them past 2x at the widest the strip draws them. They are JPEG, not PNG, because
  // the masters are 4x the weight for UI text nobody reads at strip size; keep the App Store
  // listing on the PNG masters. Regenerate from the same frames and bump the width in the name if
  // the shots change — which is what took these from 640 to 720, since an unchanged URL would have
  // kept serving the old ones for a year.
  "shot-meteogram-720.jpg": { file: "../public/shot-meteogram-720.jpg", type: "image/jpeg" },
  "shot-builder-720.jpg": { file: "../public/shot-builder-720.jpg", type: "image/jpeg" },
  "shot-wind-720.jpg": { file: "../public/shot-wind-720.jpg", type: "image/jpeg" },
  "shot-air-720.jpg": { file: "../public/shot-air-720.jpg", type: "image/jpeg" },
  "shot-history-720.jpg": { file: "../public/shot-history-720.jpg", type: "image/jpeg" },
  // Apple's "Download on the App Store" badge, the white US/UK artwork, byte-for-byte as served by
  // toolbox.marketingtools.apple.com/api/v2/badges/download-on-the-app-store/white/en-us. White
  // because the button sits in the photo band, which Apple's guidelines count as a dark background;
  // take the black variant back if it ever moves down onto the page. Those same guidelines allow no
  // redrawing, recoloring or effects, so this file is not ours to optimize: re-download it rather
  // than editing it.
  "appstore-badge-white.svg": { file: "../public/appstore-badge-white.svg", type: "image/svg+xml" },
};

const cache = new Map<string, Buffer<ArrayBuffer>>();

async function load(name: string): Promise<Buffer<ArrayBuffer> | null> {
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
