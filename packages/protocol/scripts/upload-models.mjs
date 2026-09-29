// Uploads the model files pinned in assets/models.json to R2 through the `r2` rclone remote. Run
// after `pnpm avalanche-model` and before committing the manifest. --immutable makes rclone refuse
// to replace an existing key with different bytes; an identical upload is a no-op.
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const BUCKET = 'r2:goingblue';
const assets = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'assets');
const manifest = JSON.parse(await readFile(path.join(assets, 'models.json'), 'utf8'));

for (const [name, { key, sha256: expected }] of Object.entries(manifest)) {
  const src = path.join(assets, name);
  const actual = createHash('sha256').update(await readFile(src)).digest('hex');
  if (actual !== expected) throw new Error(`upload-models: ${name} has sha256 ${actual}, manifest says ${expected}`);
  console.log(`upload-models: ${name} -> ${key}`);
  execFileSync('rclone', ['copyto', '--immutable', '--header-upload', 'Content-Type: application/octet-stream', src, `${BUCKET}/${key}`], { stdio: 'inherit' });
}
