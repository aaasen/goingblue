import { describe, it, expect } from "vitest";
import { v1Codec } from "../src/versions/v1.js";
import { decodeMessage } from "../src/registry.js";
import type { ForecastMessage } from "../src/model.js";
import v1Fixture from "./fixtures/v1.fixture.json";

const d = v1Fixture.decoded as ForecastMessage;
const ctx = () => ({
  resolution: d.resolution, models_mask: d.models_mask, vars_mask: d.vars_mask, lat: d.lat, lon: d.lon,
});

describe("v1 fixture stability", () => {
  it("encodes to the same string", () => {
    expect(v1Codec.encode(d)).toBe(v1Fixture.encoded);
  });

  it("decodes to the same object", () => {
    expect(v1Codec.decode(v1Fixture.encoded, ctx)).toEqual(v1Fixture.decoded);
  });

  it("dispatches the fixture by its version tag", () => {
    expect(decodeMessage(v1Fixture.encoded, ctx)).toEqual(v1Fixture.decoded);
  });
});
