import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { test } from "node:test";
import { modelInfo } from "./index.js";

const MODEL = new URL("../../data/neural/s384c.int.bin", import.meta.url);

test("rejects a file that is not a model", () => {
  assert.throws(() => modelInfo(Buffer.from("not a model")), /not a GBNM model file/);
});

test("reads the exported model", { skip: !existsSync(MODEL) && "no exported model in data/neural" }, () => {
  const info = modelInfo(readFileSync(MODEL));
  assert.equal(info.dim, 384);
  assert.equal(info.codable, 8001);
  assert.equal(info.markers, 189);
});
