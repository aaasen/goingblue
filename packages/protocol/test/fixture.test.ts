import { describe, it, expect } from "vitest";
import { v1Codec } from "../src/versions/v1.js";
import { v2Codec } from "../src/versions/v2.js";
import type { ForecastMessage, V1ForecastMessage } from "../src/model.js";
import v1Fixture from "./fixtures/v1.fixture.json";
import v2Fixture from "./fixtures/v2.fixture.json";

describe("v1 fixture stability", () => {
  it("encodes to the same string", () => {
    expect(v1Codec.encode(v1Fixture.decoded as V1ForecastMessage)).toBe(v1Fixture.encoded);
  });

  it("decodes to the same object", () => {
    expect(v1Codec.decode(v1Fixture.encoded)).toEqual(v1Fixture.decoded);
  });
});

describe("v2 fixture stability", () => {
  it("encodes to the same string", () => {
    expect(v2Codec.encode(v2Fixture.decoded as ForecastMessage)).toBe(v2Fixture.encoded);
  });

  it("decodes to the same object", () => {
    expect(v2Codec.decode(v2Fixture.encoded)).toEqual(v2Fixture.decoded);
  });
});
