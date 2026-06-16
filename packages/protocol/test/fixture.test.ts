import { describe, it, expect } from "vitest";
import { v1Codec } from "../src/versions/v1.js";
import type { ForecastMessage } from "../src/message.js";
import v1Fixture from "./fixtures/v1.fixture.json";

describe("v1 fixture stability", () => {
  it("encodes to the same string", () => {
    expect(v1Codec.encode(v1Fixture.decoded as ForecastMessage)).toBe(v1Fixture.encoded);
  });

  it("decodes to the same object", () => {
    expect(v1Codec.decode(v1Fixture.encoded)).toEqual(v1Fixture.decoded);
  });
});
