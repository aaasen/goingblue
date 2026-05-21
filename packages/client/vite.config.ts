import { defineConfig, type Plugin } from "vite";
import path from "path";
import fs from "fs";

function swPrecachePlugin(): Plugin {
  const bundleAssets: string[] = [];

  return {
    name: "sw-precache",
    generateBundle(_, bundle) {
      for (const fileName of Object.keys(bundle)) {
        bundleAssets.push("/" + fileName);
      }
    },
    writeBundle({ dir }) {
      const outDir = dir ?? "dist";
      const publicDir = path.resolve(__dirname, "public");

      const staticAssets = scanDir(publicDir, publicDir).filter(
        (f) => f !== "/sw.js",
      );

      const precache = ["/", "/sw.js", ...staticAssets, ...bundleAssets];

      const sw = buildSW(precache);
      fs.writeFileSync(path.join(outDir, "sw.js"), sw);
    },
  };
}

function scanDir(dir: string, base: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    return entry.isDirectory()
      ? scanDir(full, base)
      : ["/" + path.relative(base, full).replace(/\\/g, "/")];
  });
}

function buildSW(precache: string[]): string {
  return `const CACHE = "denali-wx-v3";
const PRECACHE = ${JSON.stringify(precache, null, 2)};

self.addEventListener("install", (e) => {
  e.waitUntil(
    caches.open(CACHE)
      .then((c) => Promise.allSettled(PRECACHE.map((url) => c.add(url))))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))),
    ).then(() => self.clients.claim()),
  );
});

self.addEventListener("fetch", (e) => {
  if (e.request.method !== "GET") return;

  if (e.request.mode === "navigate") {
    e.respondWith(
      caches.match("/", { ignoreSearch: true })
        .then((cached) => cached ?? fetch(e.request))
    );
    return;
  }

  e.respondWith(
    caches.match(e.request).then((cached) => {
      if (cached) return cached;
      return fetch(e.request).then((response) => {
        if (response.ok) {
          const clone = response.clone();
          caches.open(CACHE).then((c) => c.put(e.request, clone));
        }
        return response;
      });
    }),
  );
});
`;
}

export default defineConfig({
  plugins: [swPrecachePlugin()],
  resolve: {
    alias: {
      "@weather/protocol": path.resolve(__dirname, "../protocol/src/index.ts"),
    },
  },
  server: {
    proxy: {
      "/forecast": "http://localhost:8080",
    },
  },
});
