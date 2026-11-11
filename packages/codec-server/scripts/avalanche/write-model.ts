/**
 * Trains a structured model and writes it as the shipped file: Avalanche Canada's, or with
 * `--source nac` the one the avalanche.org centers share.
 *
 * The shipped model is trained on every archived bulletin with a danger rating, with no
 * holdout. The file is not in git: this also repins it in packages/protocol/assets/models.json,
 * and `pnpm upload-models` puts it on R2.
 *
 * Usage: pnpm avalanche-model [--source nac]
 */
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { gunzipSync, gzipSync } from "node:zlib";
import { loadStructured, packStructured, WIRE_VERSION } from "@weather/protocol";
import { structuredOf } from "@weather/protocol/avalanche-codec/structured";
import { loadBulletins, loadNacBulletins } from "./corpus.ts";
import { StructuredBuilder } from "./structured.ts";

const ASSETS = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "protocol", "assets");
const MANIFEST_PATH = join(ASSETS, "models.json");

function main(): void {
  const i = process.argv.indexOf("--source");
  const source = i === -1 ? "avcan" : process.argv[i + 1];
  if (source !== "avcan" && source !== "nac") throw new Error(`unknown --source ${source}`);
  const name = `${source}-structured.bin.gz`;
  const modelPath = join(ASSETS, name);
  const docs = source === "nac" ? loadNacBulletins() : loadBulletins();
  const builder = new StructuredBuilder();
  for (const d of docs) builder.observe(structuredOf(d.forecast));
  const trained = builder.build();
  const packed = packStructured(trained);
  const file = gzipSync(packed, { level: 9 });
  console.log(`trained on ${docs.length.toLocaleString("en-US")} bulletins`);

  // The file must code exactly as the model it was written from.
  const loaded = loadStructured(gunzipSync(file));
  for (let i = 0; i < docs.length; i += 10) {
    const s = structuredOf(docs[i].forecast);
    if (loaded.bits(s) !== trained.bits(s)) throw new Error(`packed model codes ${docs[i].id} differently`);
  }

  writeFileSync(modelPath, file);
  const sha256 = createHash("sha256").update(file).digest("hex");
  const manifest = JSON.parse(readFileSync(MANIFEST_PATH, "utf8"));
  manifest[name] = { key: `models/avalanche-${source}-structured-v${WIRE_VERSION}-${sha256.slice(0, 16)}.bin.gz`, sha256 };
  writeFileSync(MANIFEST_PATH, JSON.stringify(manifest, null, 2) + "\n");
  const digest = createHash("sha256").update(packed).digest("hex").slice(0, 16);
  console.log(`wrote ${modelPath}`);
  console.log(`  ${(packed.length / 1e3).toFixed(0)} KB packed, ${(file.length / 1e3).toFixed(0)} KB gzipped, digest ${digest}`);
  console.log(`repinned ${MANIFEST_PATH}; run pnpm upload-models before committing it`);
}

if (process.argv[1] && /write-model\.ts$/.test(process.argv[1])) main();
