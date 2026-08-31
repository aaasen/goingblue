import { describe, it, expect } from "vitest";
import { v4Codec } from "../src/versions/v4.js";
import { decodeMessage } from "../src/registry.js";
import type { ForecastMessage } from "../src/model.js";
import v4Fixture from "./fixtures/v4.fixture.json";

// The decoder derives the period layout from the request context (see layout.ts), so this
// fixture freezes the path tables and layout arithmetic — a drifted anchor or layoutFor fails
// here, not just a drifted byte format. The request datetime/mode/offset live in
// fixture.request (the year floats: it's not on the wire, and the layout only depends on the
// hour-of-day).
const d = v4Fixture.decoded as ForecastMessage;
const req = v4Fixture.request;
const ctx = () => ({
  model: 31 - Math.clz32(d.models_mask & -d.models_mask),
  vars_mask: d.vars_mask,
  lat: d.lat,
  lon: d.lon,
  start: Date.UTC(new Date().getUTCFullYear(), req.month - 1, req.day, req.hour),
  mode: req.mode,
  utcOffsetHours: req.utcOffsetHours,
});

describe("v4 fixture stability", () => {
  it("encodes to the same string", () => {
    expect(v4Codec.encode(d)).toBe(v4Fixture.encoded);
  });

  it("decodes to the same object", () => {
    expect(v4Codec.decode(v4Fixture.encoded, ctx)).toEqual(v4Fixture.decoded);
  });

  it("dispatches the fixture by its version tag", () => {
    expect(decodeMessage(v4Fixture.encoded, ctx)).toEqual(v4Fixture.decoded);
  });
});
