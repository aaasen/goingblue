import type { Context } from "hono";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { log } from "./log.js";

// Static images for the public pages. There are only a couple of them and they are small, so
// they are read into memory at startup rather than pulling in a static-file middleware. Paths
// resolve relative to this module (dist/ at runtime), so `packages/server/public` is found
// whether the server is started from the repo root or from inside the container.
//
// Keys are the names the pages ask img() for; the URL each resolves to carries a hash of the
// file's bytes (icon-512.jpg → /img/icon-512.1a2b3c4d.jpg), which is what lets /img serve
// year-long immutable: change a file and its URL changes with it, so a repeat visitor's cache
// holds nothing by the old name. Regenerating an image in place is therefore the whole job —
// there is no name to bump.
const ASSETS: Record<string, { file: string; type: string }> = {
  // The landing-page photo, resampled from ../assets/sultana.jpg — the master, cropped so the
  // summit is the center of the frame, which is the point the hero band crops around. Regenerate
  // both widths together, so the phone and desktop hero never show different photos. The
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
  // whenever the app icon changes, so the two never drift apart. It is
  // drawn on the landing page and is also the apple-touch-icon every page links, which is why it
  // stays a square of the icon alone: it is rendered as a home-screen tile, not just as a picture,
  // and iOS rounds the corners itself — unlike favicon.ico, which has to bring its own.
  "icon-512.jpg": { file: "../public/icon-512.jpg", type: "image/jpeg" },
  // The landing page's screenshot strip, listed here in the order the strip draws them, which is
  // the App Store listing's order. These are the App Store frames themselves — sky, device and
  // baked-in caption — resized from packages/mobile/screenshots/framed (the 1320x2868 output of
  // mobile's scripts/frame-screenshots.py, already sRGB with no EXIF, so a plain Pillow resize +
  // `save(out, "JPEG", quality=78, optimize=True, progressive=True)` is the whole job whenever
  // the frames change).
  //
  // The whole listing, which is five shots deep: the strip fits its set on one row at once, so
  // every shot added costs the others width, and six left them too small to read — the past and
  // detail shots are benched from CAPTIONS_LIST for the same crowding reason. If the listing ever
  // grows past what a row can carry, drop shots here rather than shrinking them all.
  //
  // Resized to 750px wide, which keeps them past 2x at the widest the strip draws them. They are
  // JPEG, not PNG, because the masters are 4x the weight for UI text nobody reads at strip size;
  // keep the App Store listing on the PNG masters.
  "shot-mont-blanc.jpg": { file: "../public/shot-mont-blanc.jpg", type: "image/jpeg" },
  "shot-builder.jpg": { file: "../public/shot-builder.jpg", type: "image/jpeg" },
  "shot-denali.jpg": { file: "../public/shot-denali.jpg", type: "image/jpeg" },
  "shot-cloud.jpg": { file: "../public/shot-cloud.jpg", type: "image/jpeg" },
  "shot-air-quality.jpg": { file: "../public/shot-air-quality.jpg", type: "image/jpeg" },
  // Apple's "Download on the App Store" badge, the white US/UK artwork, byte-for-byte as served by
  // toolbox.marketingtools.apple.com/api/v2/badges/download-on-the-app-store/white/en-us. White
  // because the button sits in the photo band, which Apple's guidelines count as a dark background;
  // take the black variant back if it ever moves down onto the page. Those same guidelines allow no
  // redrawing, recoloring or effects, so this file is not ours to optimize: re-download it rather
  // than editing it.
  "appstore-badge-white.svg": { file: "../public/appstore-badge-white.svg", type: "image/svg+xml" },
};

// The browser-tab icon, the app icon rendered down to the three sizes a tab, a bookmark bar and a
// Windows shortcut ask for, in one .ico. Corners are rounded here rather than left square: nothing
// masks a favicon the way a home screen masks an app icon, so the rounding has to be baked in for
// the tab to show the icon as the phone shows it. The shape is the n=5 superellipse, which is the
// usual approximation of the continuous-curvature corner iOS draws — a plain rounded rectangle of
// the same radius differs by up to a third of the alpha range along the corner arcs, which is
// visible at 48px. Regenerate alongside icon-512.jpg whenever the app icon changes, from the same
// source, with Pillow and numpy —
//   N, SS, n = 1024, 4, 5
//   g = (np.arange(N * SS) + 0.5) / (N * SS) * 2 - 1
//   mask = Image.fromarray(
//       (((np.abs(g)[:, None] ** n + np.abs(g)[None, :] ** n) <= 1) * 255).astype("uint8")
//   ).resize((N, N), Image.LANCZOS)
//   im = Image.open("packages/mobile/assets/icon.png").convert("RGBA")
//   im.putalpha(mask)
//   im.save(out, format="ICO", sizes=[(16, 16), (32, 32), (48, 48)])
// — supersampling the mask for a clean edge, touching only alpha so the resize has no matte to
// bleed, and downsampling each frame from the 1024px master rather than from one another. It is the
// one image whose URL is fixed by convention instead of by us, so it cannot be content-versioned the
// way the rest are; it is cached by the day instead of by the year so a new one can actually land.
const FAVICON = "../public/favicon.ico";

// Read and hash every asset up front, building both sides of the URL scheme at once: the name a
// page should link (icon-512.1a2b3c4d.jpg) and the bytes to serve when that name comes back. The
// hash goes before the extension rather than after it so the type is still read off the tail.
// Startup is the right time to fail on a missing file — lazily, the pages would render links that
// then 404, and only for whichever visitor came first after the bad deploy.
const served = new Map<string, { bytes: Buffer<ArrayBuffer>; type: string }>();
const urls = new Map<string, string>();
for (const [name, { file, type }] of Object.entries(ASSETS)) {
  const bytes: Buffer<ArrayBuffer> = readFileSync(new URL(file, import.meta.url));
  const hash = createHash("sha256").update(bytes).digest("hex").slice(0, 8);
  const dot = name.lastIndexOf(".");
  const versioned = `${name.slice(0, dot)}.${hash}${name.slice(dot)}`;
  served.set(versioned, { bytes, type });
  urls.set(name, `/img/${versioned}`);
}

// The URL a page should link for an asset in ASSETS, hash and all. Throwing on an unknown name is
// what makes a typo a startup crash (the pages build their HTML at import) instead of a 404 in
// production.
export function img(name: string): string {
  const url = urls.get(name);
  if (!url) throw new Error(`unknown image asset: ${name}`);
  return url;
}

// GET /img/:name — only the hashed names img() hands out exist here, so a hit is bytes that
// really are what the hash says, and the response can be cached hard and forever. A stale name
// from an old page is a 404, not silently the wrong image.
export function image(c: Context): Response {
  const asset = served.get(c.req.param("name") ?? "");
  if (!asset) return c.text("Not found", 404);
  return c.body(asset.bytes, 200, {
    "Content-Type": asset.type,
    "Cache-Control": "public, max-age=31536000, immutable",
  });
}

// GET /favicon.ico — the path browsers ask for on their own, whether or not a page links it.
// Read lazily and held once, like the hashed set — but it cannot join it: its URL is fixed by
// convention, which is also why a missing file here is a logged 404 rather than a startup crash.
let faviconBytes: Buffer<ArrayBuffer> | null = null;
export async function favicon(c: Context): Promise<Response> {
  if (!faviconBytes) {
    try {
      faviconBytes = await readFile(new URL(FAVICON, import.meta.url));
    } catch (e) {
      log.error("asset.read_failed", { file: FAVICON, err: e });
      return c.text("Not found", 404);
    }
  }
  return c.body(faviconBytes, 200, {
    "Content-Type": "image/x-icon",
    "Cache-Control": "public, max-age=86400",
  });
}
