import { describe, expect, it } from "vitest";
import { randomBytes } from "node:crypto";
import { MODEL_BIT, VARS_BIT, ALWAYS_VARS_MASK, generateToken, MODE_DETAIL, MODE_AUTO, MODE_RANGE } from "@weather/protocol";
import { parseRequest } from "../src/forecast.js";

const newToken = () => generateToken((n) => Uint8Array.from(randomBytes(n)));

const BEST = 1 << MODEL_BIT["BEST"];
const US   = 1 << MODEL_BIT["US"];
const CA   = 1 << MODEL_BIT["CA"];
const EU   = 1 << MODEL_BIT["EU"];

describe("parseRequest", () => {
  it("defaults: Auto priority, UTC grid, Best Match, always-on vars, location 0", () => {
    const p = parseRequest("");
    expect(p).toMatchObject({ mode: MODE_AUTO, utcOffsetHours: 0, modelsMask: BEST, locationIdx: 0 });
    expect(p.varsMask).toBe(ALWAYS_VARS_MASK);
  });

  it("l: named location", () => {
    expect(parseRequest("l:14k").locationIdx).toBe(2);
    expect(parseRequest("l:11k").locationIdx).toBe(1);
    expect(parseRequest("l:17k").locationIdx).toBe(3);
    expect(parseRequest("l:summit").locationIdx).toBe(4);
    expect(parseRequest("l:airstrip").locationIdx).toBe(5);
  });

  it("l:current and l:here set locationIdx 0", () => {
    expect(parseRequest("l:current").locationIdx).toBe(0);
    expect(parseRequest("l:here").locationIdx).toBe(0);
  });

  it("GPS coordinates set lat/lon and locationIdx 0", () => {
    const p = parseRequest("63.06300,-151.08100");
    expect(p.lat).toBeCloseTo(63.063);
    expect(p.lon).toBeCloseTo(-151.081);
    expect(p.locationIdx).toBe(0);
  });

  it("Garmin email footer GPS format", () => {
    const p = parseRequest("Lat 63.063 Lon -151.081");
    expect(p.lat).toBeCloseTo(63.063);
    expect(p.lon).toBeCloseTo(-151.081);
  });

  it("max response length defaults to 160", () => {
    expect(parseRequest("").maxChars).toBe(160);
  });

  it("c: sets the max response length; the fill trims to it at encode time, not parse time", () => {
    expect(parseRequest("c:320").maxChars).toBe(320);
    // The budget doesn't change what's parsed — only how far the fill refines.
    expect(parseRequest("c:320 p:d").mode).toBe(MODE_DETAIL);
    expect(parseRequest("c:80 p:d").mode).toBe(MODE_DETAIL);
  });

  it("c: clamps the max response length to a minimum of 1", () => {
    expect(parseRequest("c:0").maxChars).toBe(1);
  });

  it("k: sets the message code, defaulting to 0", () => {
    expect(parseRequest("k:42").code).toBe(42);
    expect(parseRequest("").code).toBe(0);
    // out-of-range (≥128) is ignored, leaving the default
    expect(parseRequest("k:200").code).toBe(0);
  });

  it("t: sets the request time, defaulting to the current hour", () => {
    expect(parseRequest("t:480000").startEpochHour).toBe(480000);
    expect(parseRequest("").startEpochHour).toBe(Math.floor(Date.now() / 3600000));
  });

  it("m: single center", () => {
    expect(parseRequest("m:best").modelsMask).toBe(BEST);
    expect(parseRequest("m:us").modelsMask).toBe(US);
    expect(parseRequest("m:ca").modelsMask).toBe(CA);
    expect(parseRequest("m:eu").modelsMask).toBe(EU);
  });

  it("m: legacy model-name tokens are no longer recognized (mask unchanged)", () => {
    expect(parseRequest("m:gfs").modelsMask).toBe(BEST);
    expect(parseRequest("m:ecmwf").modelsMask).toBe(BEST);
    expect(parseRequest("m:hres").modelsMask).toBe(BEST);
  });

  it("m: multiple comma-separated centers", () => {
    expect(parseRequest("m:best,eu").modelsMask).toBe(BEST | EU);
    expect(parseRequest("m:us,ca,eu").modelsMask).toBe(US | CA | EU);
  });

  it("m: unknown center name leaves mask unchanged", () => {
    expect(parseRequest("m:bogus").modelsMask).toBe(BEST);
  });

  it("v: expands each single-character configurable variable group", () => {
    expect(parseRequest("v:c").varsMask).toBe(
      ALWAYS_VARS_MASK |
      (1 << VARS_BIT["cch"]) |
      (1 << VARS_BIT["ccm"]) |
      (1 << VARS_BIT["ccl"]),
    );
    expect(parseRequest("v:w").varsMask).toBe(
      ALWAYS_VARS_MASK |
      (1 << VARS_BIT["w500"]) |
      (1 << VARS_BIT["w600"]) |
      (1 << VARS_BIT["w700"]),
    );
    expect(parseRequest("v:f").varsMask).toBe(ALWAYS_VARS_MASK | (1 << VARS_BIT["freeze"]));
  });

  it("v: combines configurable variable group codes without delimiters", () => {
    const p = parseRequest("v:cwf");
    expect(p.varsMask).toBe(
      ALWAYS_VARS_MASK |
      (1 << VARS_BIT["cch"]) |
      (1 << VARS_BIT["ccm"]) |
      (1 << VARS_BIT["ccl"]) |
      (1 << VARS_BIT["w500"]) |
      (1 << VARS_BIT["w600"]) |
      (1 << VARS_BIT["w700"]) |
      (1 << VARS_BIT["freeze"]),
    );
  });

  it("v: continues to accept long-form protocol variable names", () => {
    expect(parseRequest("v:cch,freeze").varsMask).toBe(
      ALWAYS_VARS_MASK | (1 << VARS_BIT["cch"]) | (1 << VARS_BIT["freeze"]),
    );
  });

  it("v: continues to accept comma-separated group codes", () => {
    expect(parseRequest("v:c,w,f").varsMask).toBe(parseRequest("v:cwf").varsMask);
  });

  it("includes only the always-on variables when no configurable vars are specified", () => {
    expect(parseRequest("l:14k m:eu").varsMask).toBe(ALWAYS_VARS_MASK);
  });

  it("full message parses all fields", () => {
    const p = parseRequest("l:14k p:r z:-9 m:eu v:f");
    expect(p).toMatchObject({
      locationIdx: 2,
      mode: MODE_RANGE,
      utcOffsetHours: -9,
      modelsMask: EU,
    });
    expect(p.varsMask).toBe(ALWAYS_VARS_MASK | (1 << VARS_BIT["freeze"]));
  });

  it("vN token sets the decoder version; a missing token is null (no default)", () => {
    expect(parseRequest("").decoderVersion).toBeNull();
    expect(parseRequest("v1 p:a").decoderVersion).toBe(1);
    expect(parseRequest("v3").decoderVersion).toBe(3); // routed to a clear unsupported-version error
  });

  it("p: sets the priority mode, defaulting to Auto; unknown values keep Auto", () => {
    expect(parseRequest("p:d").mode).toBe(MODE_DETAIL);
    expect(parseRequest("p:a").mode).toBe(MODE_AUTO);
    expect(parseRequest("p:r").mode).toBe(MODE_RANGE);
    expect(parseRequest("p:x").mode).toBe(MODE_AUTO);
    expect(parseRequest("").mode).toBe(MODE_AUTO);
  });

  it("d: (the removed duration token) is ignored", () => {
    expect(parseRequest("d:7").mode).toBe(MODE_AUTO);
  });

  it("z: sets the UTC offset in whole hours, ignoring out-of-range values", () => {
    expect(parseRequest("z:-9").utcOffsetHours).toBe(-9);
    expect(parseRequest("z:14").utcOffsetHours).toBe(14);
    expect(parseRequest("z:0").utcOffsetHours).toBe(0);
    expect(parseRequest("z:15").utcOffsetHours).toBe(0);
    expect(parseRequest("z:-13").utcOffsetHours).toBe(0);
    expect(parseRequest("").utcOffsetHours).toBe(0);
  });

  it("ignores removed var tokens (tmin is no longer a variable)", () => {
    const p = parseRequest("p:d v:tmin");
    expect(p.varsMask).toBe(ALWAYS_VARS_MASK);
  });

  it("u: extracts a valid account token", () => {
    const token = newToken();
    expect(parseRequest(`l:14k u:${token}`).userToken).toBe(token);
  });

  it("u: tolerates lowercase and hyphen grouping (the body is lowercased before parsing)", () => {
    const token = newToken();
    const grouped = token.replace(/(.{4})(?=.)/g, "$1-").toLowerCase();
    expect(parseRequest(`u:${grouped}`).userToken).toBe(token);
  });

  it("userToken is null when absent or malformed", () => {
    expect(parseRequest("l:14k").userToken).toBeNull();
    expect(parseRequest("u:not-a-real-token").userToken).toBeNull();
    // Wrong length (15 chars, need 16) → rejected.
    expect(parseRequest("u:000000000000000").userToken).toBeNull();
    // Contains 'u', which is outside the Crockford alphabet → rejected.
    expect(parseRequest("u:uuuuuuuuuuuuuuuu").userToken).toBeNull();
  });
});
