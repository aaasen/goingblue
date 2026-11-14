import { createHash } from "node:crypto";
import { gunzipSync } from "node:zlib";
import { describe, it, expect } from "vitest";
import {
  decodeBulletin, encodeBulletin, PROSE_MODEL_FILE, quantizeIssued, readBulletin, withPlaceholders, type AvalancheForecast,
} from "../src/index.js";
import { PIECE_INTERIORS, REGION_ANCHOR_COUNTS, REGION_CHAINS } from "../src/avalanche-region.gen.js";
import { asset, modelsFor } from "./avalanche-models.js";
import SEA_TO_SKY from "../../mobile/fixtures/avalanche/sea-to-sky-2026-03-01.json";

// The avalanche models are wire format like the entropy codebooks: a bulletin encoded under one
// model decodes to garbage under another. The structured digests are over the unpacked bytes, so
// a zlib upgrade that changes the gzip stream does not trip them. Rewritten by
// `pnpm avalanche-model [--source nac]`, which prints the new digest.
const FROZEN_MODEL_DIGEST = "9e96b36f5b5810b9";
const FROZEN_NAC_MODEL_DIGEST = "f3ec54062432899c";
// The shared prose model (native/avalanche), pinned in models.json.
const FROZEN_PROSE_DIGEST = "84fcf3b2ff384e14";
// The same for the piece-set model, rewritten by `pnpm avalanche-region`.
const FROZEN_REGION_DIGEST = "5086b8ab3e00ee3f";

const digestOf = (bytes: Uint8Array | string) => createHash("sha256").update(bytes).digest("hex").slice(0, 16);

describe("avalanche model", () => {
  it.each([
    ["avcan-structured.bin.gz", FROZEN_MODEL_DIGEST],
    ["nac-structured.bin.gz", FROZEN_NAC_MODEL_DIGEST],
  ])("matches the frozen digest of %s", (file, frozen) => {
    const digest = digestOf(gunzipSync(asset(file)));
    expect(digest, `${file} changed without a protocol version bump; if intended, set its digest to "${digest}"`).toBe(frozen);
  });

  it("matches the frozen prose digest", () => {
    const digest = digestOf(asset(PROSE_MODEL_FILE));
    expect(digest,
      `prose model changed without a protocol version bump; if intended, set FROZEN_PROSE_DIGEST to "${digest}"`,
    ).toBe(FROZEN_PROSE_DIGEST);
  });

  it("matches the frozen region digest", () => {
    const digest = digestOf(JSON.stringify([PIECE_INTERIORS, REGION_ANCHOR_COUNTS, REGION_CHAINS]));
    expect(digest,
      `region model changed without a protocol version bump; if intended, set FROZEN_REGION_DIGEST to "${digest}"`,
    ).toBe(FROZEN_REGION_DIGEST);
  });

  it("loads and round-trips a bulletin", async () => {
    const models = modelsFor("avcan");
    const f = SEA_TO_SKY as AvalancheForecast;
    const bytes = await encodeBulletin(models, f);
    expect(await decodeBulletin(models, bytes, quantizeIssued(f.issued))).toEqual(withPlaceholders(f));
    // A bulletin from the training archive codes in one or two messages.
    expect(bytes.length).toBeLessThan(280);
  });

  it("tells a whole bulletin from one missing its end without the prose model", async () => {
    const models = modelsFor("avcan");
    const f = SEA_TO_SKY as AvalancheForecast;
    const bytes = await encodeBulletin(models, f);
    const issued = quantizeIssued(f.issued);
    const head = readBulletin(models.structured, bytes, issued);
    expect(head.structured.problems.length).toBe(f.problems.length);
    for (const cut of [1, 10, Math.floor(bytes.length / 2)]) {
      expect(() => readBulletin(models.structured, bytes.subarray(0, bytes.length - cut), issued)).toThrow();
    }
    const extra = new Uint8Array(bytes.length + 1);
    extra.set(bytes);
    extra[bytes.length] = 7;
    expect(() => readBulletin(models.structured, extra, issued)).toThrow(/left over/);
  });
});
