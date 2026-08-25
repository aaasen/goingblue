// Fetches the bundled basemap artifacts from R2: the global z6 archive pair (assets/basemap/,
// not in git — ~33 MB of binary that regenerates with every basemap build) and the catalog +
// outlines JSON (assets/, tracked — imported by catalog.ts/outlines.ts, so a stale checkout
// still typechecks; this refresh keeps them in step with the published build). Metro needs all
// four on disk at bundle time, so `start`/`ios`/`android` and the EAS post-install hook run
// this first. Skips a download when the local copy already matches the remote size; R2 being
// unreachable is always an error — a build must never proceed on an unverified offline tier.
import { createWriteStream } from 'node:fs';
import { mkdir, stat } from 'node:fs/promises';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const BASE_URL = 'https://r2.going.blue';
const assets = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'assets');
const FILES = [
  ['global-z6-base.pmtiles', path.join(assets, 'basemap')],
  ['global-z6-hs.pmtiles', path.join(assets, 'basemap')],
  ['fonts.zip', path.join(assets, 'basemap')],
  ['catalog.json', assets],
  ['outlines.json', assets],
];

for (const [name, dir] of FILES) {
  await mkdir(dir, { recursive: true });
  const dest = path.join(dir, name);
  const local = await stat(dest).then((s) => s.size, () => null);
  let remote;
  try {
    // identity: with gzip negotiated (the JSONs), R2 omits Content-Length and the size
    // comparison would re-download on every run.
    const head = await fetch(`${BASE_URL}/${name}`, { method: 'HEAD', headers: { 'accept-encoding': 'identity' } });
    if (!head.ok) throw new Error(`HTTP ${head.status}`);
    remote = Number(head.headers.get('content-length'));
    if (!Number.isFinite(remote) || remote <= 0) throw new Error('no usable Content-Length');
  } catch (e) {
    throw new Error(`fetch-basemap: cannot reach ${BASE_URL} to verify ${name}: ${e.message ?? e}`);
  }
  if (local === remote) continue;
  console.log(`fetch-basemap: ${name} (${(remote / 1e6).toFixed(1)} MB)`);
  const res = await fetch(`${BASE_URL}/${name}`);
  if (!res.ok) throw new Error(`fetch-basemap: ${name}: HTTP ${res.status}`);
  await pipeline(Readable.fromWeb(res.body), createWriteStream(dest + '.tmp'));
  const { rename } = await import('node:fs/promises');
  await rename(dest + '.tmp', dest);
}
