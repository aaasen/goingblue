import { createHash } from "node:crypto";
import { describe, it, expect } from "vitest";
import { WIRE_CODEBOOKS, WIRE_VERSION } from "../src/index.js";

// The entropy codebooks are wire format: a message encoded under one set of tables decodes to
// plausible garbage, not an error, under another. Main carries only the current protocol
// version, so this digest freezes the current tables (and the temp escape geometry) and the
// test fails the moment they change.
//
// Before the version ships, re-record freely. Once it has deployed clients, a failure means the
// change breaks phones in the field and belongs to the next version. Old versions keep their
// own digest on their codec-vN tag, so a version bump leaves this constant alone until the
// tables actually change.
const FROZEN_DIGEST = "d332b23a18d2b5d0";

const digest = createHash("sha256").update(JSON.stringify(WIRE_CODEBOOKS)).digest("hex").slice(0, 16);

describe("codebook wire-format freeze", () => {
  it(`v${WIRE_VERSION} codebooks match the frozen digest`, () => {
    expect(digest,
      `codebooks changed without a protocol version bump; if intended, set FROZEN_DIGEST to "${digest}"`,
    ).toBe(FROZEN_DIGEST);
  });
});
