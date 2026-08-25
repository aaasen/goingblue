// Fetches the bundled basemap archives (the global z6 pair) from R2 into assets/basemap/.
// They are deliberately not in git — ~33 MB of binary that regenerates with every basemap
// build — but Metro needs them on disk at bundle time, so `start`/`ios`/`android` and the EAS
// post-install hook run this first. Skips the download when the local copy already matches the
// remote size; R2 being unreachable is always an error — a build must never proceed on an
// unverified (possibly stale) offline tier.
import { createWriteStream } from 'node:fs';
import { mkdir, stat } from 'node:fs/promises';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const BASE_URL = 'https://r2.going.blue';
const FILES = ['global-z6-base.pmtiles', 'global-z6-hs.pmtiles'];
const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'assets', 'basemap');

await mkdir(dir, { recursive: true });
for (const name of FILES) {
  const dest = path.join(dir, name);
  const local = await stat(dest).then((s) => s.size, () => null);
  let remote;
  try {
    const head = await fetch(`${BASE_URL}/${name}`, { method: 'HEAD' });
    if (!head.ok) throw new Error(`HTTP ${head.status}`);
    remote = Number(head.headers.get('content-length'));
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
