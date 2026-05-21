import { describe, expect, it } from "vitest";
import { MODEL_BIT, VARS_BIT, DEFAULT_VARS_MASK } from "@weather/protocol";
import { parseRequest } from "../src/forecast.js";

const HRES = 1 << MODEL_BIT["HRES"];
const GFS  = 1 << MODEL_BIT["GFS"];
const IFS  = 1 << MODEL_BIT["IFS"];

describe("parseRequest", () => {
  it("defaults: 10 days, daily, HRES, default vars, location 0", () => {
    const p = parseRequest("");
    expect(p).toMatchObject({ days: 10, resolutionIdx: 0, modelsMask: HRES, locationIdx: 0 });
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

  it("d: sets days, clamped 1–10", () => {
    expect(parseRequest("d:7").days).toBe(7);
    expect(parseRequest("d:0").days).toBe(1);
    expect(parseRequest("d:99").days).toBe(10);
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
    expect(parseRequest("l:14k d:7 m:ifs").varsMask).toBe(DEFAULT_VARS_MASK);
  });

  it("full message parses all fields", () => {
    const p = parseRequest("l:14k d:7 r:3h m:ifs v:precip,temp");
    expect(p).toMatchObject({
      locationIdx: 2,
      days: 7,
      resolutionIdx: 3,
      modelsMask: IFS,
    });
    expect(p.varsMask).toBe((1 << VARS_BIT["precip"]) | (1 << VARS_BIT["temp"]));
  });
});
