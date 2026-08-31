import { createHash } from "node:crypto";
import { describe, it, expect } from "vitest";
import { WIRE_CODEBOOKS, WIRE_VERSION } from "../src/index.js";

// The entropy codebooks are wire format: a message encoded under one set of tables decodes to
// plausible garbage — not an error — under another. So the tables are frozen per protocol
// version, and this test is the tripwire: it fails the moment any weight table (or the temp
// escape geometry) changes without a version bump.
//
// If this test fails, either:
//   - you didn't mean to change the wire format → revert the table change, or
//   - you did → bump the protocol version and add a `<new version>: <printed digest>` entry
//     below. Never overwrite an existing entry: that would re-freeze the old version's tables
//     to new values, which is exactly the silent drift this test exists to catch.
const FROZEN_DIGESTS: Record<number, string> = {
  4: "23470346214fa62c", // pre-ship; re-recorded freely until this version has real deployed clients
};

const digest = createHash("sha256").update(JSON.stringify(WIRE_CODEBOOKS)).digest("hex").slice(0, 16);

describe("codebook wire-format freeze", () => {
  it("has a frozen digest recorded for the current protocol version", () => {
    expect(FROZEN_DIGESTS[WIRE_VERSION],
      `no frozen codebook digest for protocol v${WIRE_VERSION} — record "${digest}" in FROZEN_DIGESTS`,
    ).toBeDefined();
  });

  it(`v${WIRE_VERSION} codebooks match the digest frozen when the version shipped`, () => {
    expect(digest,
      "codebooks changed without a protocol version bump — see the comment on FROZEN_DIGESTS",
    ).toBe(FROZEN_DIGESTS[WIRE_VERSION]);
  });
});
