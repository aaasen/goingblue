import { describe, expect, it } from "vitest";
import { randomBytes } from "node:crypto";
import { MODEL_BIT, VARS_BIT, DEFAULT_VARS_MASK, generateToken } from "@weather/protocol";
import { parseRequest } from "../src/forecast.js";

const newToken = () => generateToken((n) => Uint8Array.from(randomBytes(n)));

const HRES = 1 << MODEL_BIT["HRES"];
const GFS  = 1 << MODEL_BIT["GFS"];
const IFS  = 1 << MODEL_BIT["IFS"];

describe("parseRequest", () => {
  it("defaults: fills the budget (15 daily periods at horizon), daily, HRES, default vars, location 0", () => {
    // No d: → the server fits as many periods as the response budget allows; at daily
    // resolution that's the 15-day forecast horizon.
    const p = parseRequest("");
    expect(p).toMatchObject({ nPeriods: 15, resolutionIdx: 0, modelsMask: HRES, locationIdx: 0 });
    expect(p.varsMask).toBe(DEFAULT_VARS_MASK);
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

  it("c: sets the max response length and yields more periods when raised", () => {
    expect(parseRequest("c:320").maxChars).toBe(320);
    const dflt = parseRequest("r:1h").nPeriods;
    const larger = parseRequest("c:320 r:1h").nPeriods;
    const smaller = parseRequest("c:80 r:1h").nPeriods;
    expect(larger).toBeGreaterThan(dflt);
    expect(smaller).toBeLessThan(dflt);
  });

  it("c: clamps to a minimum of 1 and still returns at least one period", () => {
    expect(parseRequest("c:0").maxChars).toBe(1);
    expect(parseRequest("c:0").nPeriods).toBe(1);
  });

  it("the period count always fits the budget; a fuller var set yields fewer hourly periods", () => {
    // At 1h resolution the default var set fills more periods than an all-vars request,
    // and both stay within the response budget.
    const defaultRes = parseRequest("r:1h").nPeriods;
    const richRes = parseRequest("r:1h v:precip,temp,tmin,snow,freeze,wind,w500,w600,w700,cc,cch,ccm,ccl").nPeriods;
    expect(defaultRes).toBeGreaterThan(0);
    expect(richRes).toBeGreaterThan(0);
    expect(richRes).toBeLessThan(defaultRes);
  });

  it("r: sets resolution index", () => {
    expect(parseRequest("r:1h").resolutionIdx).toBe(4);
    expect(parseRequest("r:3h").resolutionIdx).toBe(3);
    expect(parseRequest("r:6h").resolutionIdx).toBe(2);
    expect(parseRequest("r:12h").resolutionIdx).toBe(1);
    expect(parseRequest("r:daily").resolutionIdx).toBe(0);
    expect(parseRequest("r:24h").resolutionIdx).toBe(0);
  });

  it("m: single model", () => {
    expect(parseRequest("m:ifs").modelsMask).toBe(IFS);
    expect(parseRequest("m:gfs").modelsMask).toBe(GFS);
    expect(parseRequest("m:hres").modelsMask).toBe(HRES);
    expect(parseRequest("m:ecmwf").modelsMask).toBe(HRES);
    expect(parseRequest("m:euro").modelsMask).toBe(IFS);
  });

  it("m: multiple comma-separated models", () => {
    expect(parseRequest("m:hres,ifs").modelsMask).toBe(HRES | IFS);
    expect(parseRequest("m:hres,gfs,ifs").modelsMask).toBe(HRES | GFS | IFS);
  });

  it("m: unknown model name leaves mask unchanged", () => {
    expect(parseRequest("m:bogus").modelsMask).toBe(HRES);
  });

  it("v: single variable", () => {
    expect(parseRequest("v:precip").varsMask).toBe(1 << VARS_BIT["precip"]);
    expect(parseRequest("v:wind").varsMask).toBe(1 << VARS_BIT["wind"]);
  });

  it("v: multiple comma-separated variables", () => {
    const p = parseRequest("v:precip,temp");
    expect(p.varsMask).toBe((1 << VARS_BIT["precip"]) | (1 << VARS_BIT["temp"]));
  });

  it("v: falls back to DEFAULT_VARS_MASK when no vars specified", () => {
    expect(parseRequest("l:14k m:ifs").varsMask).toBe(DEFAULT_VARS_MASK);
  });

  it("full message parses all fields", () => {
    const p = parseRequest("l:14k r:3h m:ifs v:precip,temp");
    expect(p).toMatchObject({
      locationIdx: 2,
      resolutionIdx: 3,
      modelsMask: IFS,
    });
    expect(p.nPeriods).toBeGreaterThan(0);
    expect(p.varsMask).toBe((1 << VARS_BIT["precip"]) | (1 << VARS_BIT["temp"]));
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
