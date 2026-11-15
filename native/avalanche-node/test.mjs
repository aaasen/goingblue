import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { test } from "node:test";
import { AvalancheModel } from "./index.js";

const MODEL = new URL("../../data/neural/s384c.int.bin", import.meta.url);
const skip = !existsSync(MODEL) && "no exported model in data/neural";

test("rejects a file that is not a model", () => {
  assert.throws(() => new AvalancheModel(Buffer.from("not a model")), /not a GBNM model file/);
});

test("round-trips a forecast", { skip }, async () => {
  const model = new AvalancheModel(readFileSync(MODEL));
  assert.equal(model.info().markers, 189);
  const doc = {
    markers: ["center:NWAC", "month:01", "d0alp:3", "d0tln:3", "d0btl:2"],
    sections: [
      { markers: ["kind:highlights"], text: "Snow flurries and strong winds will be building storm slabs." },
      { markers: ["kind:problem", "ptype:windSlab", "lk:likely", "sz:1-2"], text: "Avoid steep, wind-loaded slopes near ridgelines. Ünïcode 🏔️ too." },
    ],
  };
  const { bytes } = await model.encode(doc);
  assert.ok(bytes.length > 0 && bytes.length < 60, `${bytes.length} bytes`);
  assert.deepEqual(await model.decode(bytes, doc), doc.sections.map((s) => s.text));
  await assert.rejects(model.decode(Buffer.from("garbage bytes here"), doc), /bad stream/);
});
