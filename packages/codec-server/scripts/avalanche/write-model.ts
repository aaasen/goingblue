/**
 * Trains the avalanche models and writes them as the shipped model file.
 *
 * The shipped model is trained on every archived bulletin with a danger rating, with no
 * holdout: pnpm avalanche-benchmark measures the same training on a split. The file is wire
 * format, pinned by the digest in packages/protocol/test/avcan-model.test.ts. The file is not in
 * git: this also repins it in packages/protocol/assets/models.json, and `pnpm upload-models`
 * puts it on R2.
 *
 * Usage: pnpm avalanche-model
 */
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { gunzipSync, gzipSync } from "node:zlib";
import { encodeBulletin, loadModels, packModels, WIRE_VERSION } from "@weather/protocol";
import { loadBulletins } from "./corpus.ts";
import { train } from "./train.ts";

const ASSETS = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "protocol", "assets");
export const MODEL_PATH = join(ASSETS, "avcan-model.bin.gz");
const MANIFEST_PATH = join(ASSETS, "models.json");

function main(): void {
  const docs = loadBulletins();
  const t0 = Date.now();
  const trained = train(docs.map((d) => d.forecast));
  const packed = packModels(trained);
  const file = gzipSync(packed, { level: 9 });
  console.log(`trained on ${docs.length.toLocaleString("en-US")} bulletins in ${((Date.now() - t0) / 1000).toFixed(1)} s`);

  // The file must encode exactly as the model it was written from.
  const loaded = loadModels(gunzipSync(file));
  for (let i = 0; i < docs.length; i += 10) {
    const a = encodeBulletin(trained, docs[i].forecast);
    const b = encodeBulletin(loaded, docs[i].forecast);
    if (Buffer.compare(a, b) !== 0) throw new Error(`packed model encodes ${docs[i].id} differently`);
  }

  writeFileSync(MODEL_PATH, file);
  const sha256 = createHash("sha256").update(file).digest("hex");
  const manifest = JSON.parse(readFileSync(MANIFEST_PATH, "utf8"));
  manifest["avcan-model.bin.gz"] = { key: `models/avalanche-avcan-v${WIRE_VERSION}-${sha256.slice(0, 16)}.bin.gz`, sha256 };
  writeFileSync(MANIFEST_PATH, JSON.stringify(manifest, null, 2) + "\n");
  const digest = createHash("sha256").update(packed).digest("hex").slice(0, 16);
  console.log(`wrote ${MODEL_PATH}`);
  console.log(`  ${(packed.length / 1e6).toFixed(1)} MB packed, ${(file.length / 1e6).toFixed(1)} MB gzipped, digest ${digest}`);
  console.log(`repinned ${MANIFEST_PATH}; run pnpm upload-models before committing it`);
}

if (process.argv[1] && /write-model\.ts$/.test(process.argv[1])) main();
