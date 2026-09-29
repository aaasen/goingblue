// Fetches the model files pinned in assets/models.json from R2 into assets/ (gitignored). Each R2
// key is content-addressed and never overwritten, so a checkout of any commit, including a frozen
// codec-vN tag, gets exactly the models it was built with. Skips a file whose local sha256 already
// matches, so it works offline once cached; any mismatch after download is an error.
import { createHash } from 'node:crypto';
import { readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const BASE_URL = 'https://r2.going.blue';
const assets = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'assets');
const manifest = JSON.parse(await readFile(path.join(assets, 'models.json'), 'utf8'));

const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');

for (const [name, { key, sha256: expected }] of Object.entries(manifest)) {
  const dest = path.join(assets, name);
  const local = await readFile(dest).catch(() => null);
  if (local && sha256(local) === expected) continue;
  console.log(`fetch-models: ${name} <- ${key}`);
  let bytes;
  try {
    // identity: the file is already gzip and must arrive byte for byte.
    const res = await fetch(`${BASE_URL}/${key}`, { headers: { 'accept-encoding': 'identity' } });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    bytes = Buffer.from(await res.arrayBuffer());
  } catch (e) {
    throw new Error(`fetch-models: cannot fetch ${BASE_URL}/${key}: ${e.message ?? e}`);
  }
  const actual = sha256(bytes);
  if (actual !== expected) throw new Error(`fetch-models: ${key} has sha256 ${actual}, expected ${expected}`);
  await writeFile(dest + '.tmp', bytes);
  await rename(dest + '.tmp', dest);
}
