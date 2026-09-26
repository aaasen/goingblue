import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { gunzipSync } from "node:zlib";
import { describe, it, expect } from "vitest";
import { decodeBulletin, encodeBulletin, loadModels, withPlaceholders, type AvalancheForecast } from "../src/index.js";
import SEA_TO_SKY from "../../mobile/fixtures/avalanche/sea-to-sky-2026-03-01.json";

// The avalanche model is wire format like the entropy codebooks: a bulletin encoded under one
// model decodes to garbage under another. The digest is over the unpacked bytes, so a zlib
// upgrade that changes the gzip stream does not trip it. Rewritten by `pnpm avalanche-model`,
// which prints the new digest.
const FROZEN_MODEL_DIGEST = "44bc8b544db3d2f3";

const packed = gunzipSync(readFileSync(new URL("../assets/avcan-model.bin.gz", import.meta.url)));

describe("avalanche model", () => {
  it("matches the frozen digest", () => {
    const digest = createHash("sha256").update(packed).digest("hex").slice(0, 16);
    expect(digest,
      `avalanche model changed without a protocol version bump; if intended, set FROZEN_MODEL_DIGEST to "${digest}"`,
    ).toBe(FROZEN_MODEL_DIGEST);
  });

  it("loads and round-trips a bulletin", () => {
    const models = loadModels(packed);
    const f = SEA_TO_SKY as AvalancheForecast;
    const bytes = encodeBulletin(models, f);
    expect(decodeBulletin(models, bytes)).toEqual(withPlaceholders(f));
    // A bulletin from the training archive codes in one or two messages.
    expect(bytes.length).toBeLessThan(280);
  });
});
