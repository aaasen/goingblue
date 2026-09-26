import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { gunzipSync } from "node:zlib";
import { describe, it, expect } from "vitest";
import { decodeBulletin, encodeBulletin, loadModels, quantizeIssued, withPlaceholders, type AvalancheForecast } from "../src/index.js";
import { PIECE_INTERIORS, REGION_ANCHOR_COUNTS, REGION_CHAINS } from "../src/avalanche-region.gen.js";
import SEA_TO_SKY from "../../mobile/fixtures/avalanche/sea-to-sky-2026-03-01.json";

// The avalanche model is wire format like the entropy codebooks: a bulletin encoded under one
// model decodes to garbage under another. The digest is over the unpacked bytes, so a zlib
// upgrade that changes the gzip stream does not trip it. Rewritten by `pnpm avalanche-model`,
// which prints the new digest.
const FROZEN_MODEL_DIGEST = "e7f1f48ad19bcc53";
// The same for the piece-set model, rewritten by `pnpm avalanche-region`.
const FROZEN_REGION_DIGEST = "c230bb3259f0a4ae";

const packed = gunzipSync(readFileSync(new URL("../assets/avcan-model.bin.gz", import.meta.url)));

describe("avalanche model", () => {
  it("matches the frozen digest", () => {
    const digest = createHash("sha256").update(packed).digest("hex").slice(0, 16);
    expect(digest,
      `avalanche model changed without a protocol version bump; if intended, set FROZEN_MODEL_DIGEST to "${digest}"`,
    ).toBe(FROZEN_MODEL_DIGEST);
  });

  it("matches the frozen region digest", () => {
    const digest = createHash("sha256")
      .update(JSON.stringify([PIECE_INTERIORS, REGION_ANCHOR_COUNTS, REGION_CHAINS])).digest("hex").slice(0, 16);
    expect(digest,
      `region model changed without a protocol version bump; if intended, set FROZEN_REGION_DIGEST to "${digest}"`,
    ).toBe(FROZEN_REGION_DIGEST);
  });

  it("loads and round-trips a bulletin", () => {
    const models = loadModels(packed);
    const f = SEA_TO_SKY as AvalancheForecast;
    const bytes = encodeBulletin(models, f);
    expect(decodeBulletin(models, bytes, quantizeIssued(f.issued))).toEqual(withPlaceholders(f));
    // A bulletin from the training archive codes in one or two messages.
    expect(bytes.length).toBeLessThan(280);
  });
});
