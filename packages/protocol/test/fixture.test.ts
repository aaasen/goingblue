import { describe, it, expect } from "vitest";
import { v2Codec } from "../src/versions/v2.js";
import { decodeMessage } from "../src/registry.js";
import type { ForecastMessage } from "../src/model.js";
import v2Fixture from "./fixtures/v2.fixture.json";

describe("v2 fixture stability", () => {
  it("encodes to the same string", () => {
    expect(v2Codec.encode(v2Fixture.decoded as ForecastMessage)).toBe(v2Fixture.encoded);
  });

  it("decodes to the same object", () => {
    expect(v2Codec.decode(v2Fixture.encoded)).toEqual(v2Fixture.decoded);
  });

  it("dispatches the fixture by its version tag", () => {
    expect(decodeMessage(v2Fixture.encoded)).toEqual(v2Fixture.decoded);
  });
});
