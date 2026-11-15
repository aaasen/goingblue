// The shipped avalanche models for tests: a center's structured model and the shared prose model,
// run by the native engine through its Node binding.
import { readFileSync } from "node:fs";
import { gunzipSync } from "node:zlib";
import { AvalancheModel } from "@weather/avalanche-node";
import { loadStructured, PROSE_MODEL_FILE, type Models, type ProseCoder } from "../src/index.js";

export const asset = (name: string): Buffer => readFileSync(new URL(`../assets/${name}`, import.meta.url));

const native = new AvalancheModel(asset(PROSE_MODEL_FILE));

export const PROSE: ProseCoder = {
  encode: async (doc) => new Uint8Array((await native.encode(doc)).bytes),
  decode: (bytes, layout) => native.decode(Buffer.from(bytes), layout),
};

export const modelsFor = (center: "avcan" | "nac"): Models =>
  ({ structured: loadStructured(gunzipSync(asset(`${center}-structured.bin.gz`))), prose: PROSE });
