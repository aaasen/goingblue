import { describe, it, expect } from "vitest";
import { v1Codec } from "../src/versions/v1.js";
import { decodeMessage } from "../src/registry.js";
import type { ForecastMessage } from "../src/model.js";
import v1Fixture from "./fixtures/v1.fixture.json";

// The decoder derives the period layout from the request context (see layout.ts), so this
// fixture freezes the path tables and layout arithmetic — a drifted anchor or layoutFor fails
// here, not just a drifted byte format. The request datetime/mode/offset live in
// fixture.request (the year floats: it's not on the wire, and the layout only depends on the
// hour-of-day).
const d = v1Fixture.decoded as ForecastMessage;
const req = v1Fixture.request;
const ctx = () => ({
  model: 31 - Math.clz32(d.models_mask & -d.models_mask),
  vars_mask: d.vars_mask,
  lat: d.lat,
  lon: d.lon,
  start: Date.UTC(new Date().getUTCFullYear(), req.month - 1, req.day, req.hour),
  mode: req.mode,
  utcOffsetHours: req.utcOffsetHours,
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
