import { describe, it, expect } from "vitest";
import { wireCodec } from "../src/wire.js";
import { decodeMessage } from "../src/registry.js";
import type { ForecastMessage } from "../src/model.js";
import wireFixture from "./fixtures/wire.fixture.json";

// The decoder derives the period layout from the request context (see layout.ts), so this
// fixture freezes the path tables and layout arithmetic — a drifted anchor or layoutFor fails
// here, not just a drifted byte format. The request datetime/mode/offset live in
// fixture.request (the year floats: it's not on the wire, and the layout only depends on the
// hour-of-day).
const d = wireFixture.decoded as ForecastMessage;
const req = wireFixture.request;
const ctx = () => ({
  model: 31 - Math.clz32(d.models_mask & -d.models_mask),
  vars_mask: d.vars_mask,
  lat: d.lat,
  lon: d.lon,
  start: Date.UTC(new Date().getUTCFullYear(), req.month - 1, req.day, req.hour),
  mode: req.mode,
  utcOffsetHours: req.utcOffsetHours,
});

describe("wire fixture stability", () => {
  it("encodes to the same string", () => {
    expect(wireCodec.encode(d)).toBe(wireFixture.encoded);
  });

  it("decodes to the same object", () => {
    expect(wireCodec.decode(wireFixture.encoded, ctx)).toEqual(wireFixture.decoded);
  });

  it("dispatches the fixture by its version tag", () => {
    expect(decodeMessage(wireFixture.encoded, ctx)).toEqual(wireFixture.decoded);
  });
});
