import { describe, expect, it } from "vitest";
import { randomBytes } from "node:crypto";
import {
  MODEL_BIT, VARS_BIT, ALWAYS_VARS_MASK, generateToken, MODE_DETAIL, MODE_AUTO, MODE_RANGE,
  IPHONE_MAX_CHARS, SMS_MAX_CHARS, ZOLEO_MAX_CHARS, UNCAPPED_MAX_CHARS, MAX_MESSAGES, WIRE_HEADER_CHARS, maxCharsFor,
} from "@weather/protocol";
import { describeRequest, parseRequest } from "../src/forecast.js";

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

  it("the budget doesn't change what's parsed — only how far the fill refines", () => {
    expect(parseRequest("d:i p:d").mode).toBe(MODE_DETAIL);
    expect(parseRequest("d:g p:d").mode).toBe(MODE_DETAIL);
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
    // Pressure-level wind is not a `v:` group: `v:w` is ignored, `w:` lists ladder indices.
    expect(parseRequest("v:w").varsMask).toBe(ALWAYS_VARS_MASK);
    expect(parseRequest("w:234").varsMask).toBe(
      ALWAYS_VARS_MASK |
      (1 << VARS_BIT["w500"]) |
      (1 << VARS_BIT["w600"]) |
      (1 << VARS_BIT["w700"]),
    );
    expect(parseRequest("w:06").varsMask).toBe(
      ALWAYS_VARS_MASK | (1 << VARS_BIT["w300"]) | (1 << VARS_BIT["w925"]),
    );
    // Out-of-ladder characters are ignored; an empty token adds nothing.
    expect(parseRequest("w:79x").varsMask).toBe(ALWAYS_VARS_MASK);
    expect(parseRequest("w:").varsMask).toBe(ALWAYS_VARS_MASK);
    expect(parseRequest("v:f").varsMask).toBe(ALWAYS_VARS_MASK | (1 << VARS_BIT["freeze"]));
    expect(parseRequest("v:p").varsMask).toBe(ALWAYS_VARS_MASK | (1 << VARS_BIT["precip"]));
    // Air quality: one code per index, so a reader can ask for smoke without paying for ozone.
    expect(parseRequest("v:a").varsMask).toBe(ALWAYS_VARS_MASK | (1 << VARS_BIT["aqi"]));
    expect(parseRequest("v:s").varsMask).toBe(ALWAYS_VARS_MASK | (1 << VARS_BIT["aq_pm25"]));
    expect(parseRequest("v:o").varsMask).toBe(ALWAYS_VARS_MASK | (1 << VARS_BIT["aq_o3"]));
    expect(parseRequest("v:m").varsMask).toBe(ALWAYS_VARS_MASK | (1 << VARS_BIT["aq_pm10"]));
    expect(parseRequest("v:d").varsMask).toBe(ALWAYS_VARS_MASK | (1 << VARS_BIT["aq_no2"]));
    expect(parseRequest("v:u").varsMask).toBe(ALWAYS_VARS_MASK | (1 << VARS_BIT["aq_so2"]));
    expect(parseRequest("v:e").varsMask).toBe(ALWAYS_VARS_MASK | (1 << VARS_BIT["aqi_eu"]));
    expect(parseRequest("v:2").varsMask).toBe(ALWAYS_VARS_MASK | (1 << VARS_BIT["aqi_eu_pm25"]));
    expect(parseRequest("v:1").varsMask).toBe(ALWAYS_VARS_MASK | (1 << VARS_BIT["aqi_eu_pm10"]));
    expect(parseRequest("v:3").varsMask).toBe(ALWAYS_VARS_MASK | (1 << VARS_BIT["aqi_eu_o3"]));
    expect(parseRequest("v:n").varsMask).toBe(ALWAYS_VARS_MASK | (1 << VARS_BIT["aqi_eu_no2"]));
    expect(parseRequest("v:q").varsMask).toBe(ALWAYS_VARS_MASK | (1 << VARS_BIT["aqi_eu_so2"]));
  });

  it("v: mixes air-quality codes into the compact form", () => {
    // The compact form is matched as a character class; a code missing from it would fall through
    // to the comma-separated path and silently request nothing.
    expect(parseRequest("v:aso").varsMask).toBe(
      ALWAYS_VARS_MASK |
      (1 << VARS_BIT["aqi"]) |
      (1 << VARS_BIT["aq_pm25"]) |
      (1 << VARS_BIT["aq_o3"]),
    );
    expect(parseRequest("v:cfe2").varsMask).toBe(
      ALWAYS_VARS_MASK |
      (1 << VARS_BIT["cch"]) | (1 << VARS_BIT["ccm"]) | (1 << VARS_BIT["ccl"]) |
      (1 << VARS_BIT["freeze"]) |
      (1 << VARS_BIT["aqi_eu"]) | (1 << VARS_BIT["aqi_eu_pm25"]),
    );
  });

  it("air quality is available on every center — it doesn't come from the weather model", () => {
    // CAMS serves it whatever the `m:` choice is, so unlike the freezing level it is never
    // dropped for GEM or ECMWF.
    for (const center of ["best", "us", "ca", "eu"]) {
      expect(parseRequest(`m:${center} v:a`).varsMask & (1 << VARS_BIT["aqi"])).toBeTruthy();
    }
  });

  it("precip is opt-in, not part of the always-on set", () => {
    expect(ALWAYS_VARS_MASK & (1 << VARS_BIT["precip"])).toBe(0);
    expect(parseRequest("l:14k").varsMask & (1 << VARS_BIT["precip"])).toBe(0);
  });

  it("v: combines configurable variable group codes without delimiters", () => {
    const p = parseRequest("v:pcf w:234");
    expect(p.varsMask).toBe(
      ALWAYS_VARS_MASK |
      (1 << VARS_BIT["precip"]) |
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
    expect(parseRequest("v:c,p,f").varsMask).toBe(parseRequest("v:cpf").varsMask);
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

  it("resolves Range to Auto for a Canadian request", () => {
    // The center can't fill the window, so Range would clamp to a 12h-flat layout with the
    // budget unspent (see effectiveMode). Resolved at parse, so a hand-typed request gets the
    // same substitution the app applies before sending — and params.mode is what the reply is
    // encoded under, which is what the decoder derives its layout from.
    expect(parseRequest("p:r m:ca").mode).toBe(MODE_AUTO);
    expect(parseRequest("p:r m:us").mode).toBe(MODE_RANGE);
    expect(parseRequest("p:r m:eu").mode).toBe(MODE_RANGE);
    expect(parseRequest("p:r").mode).toBe(MODE_RANGE); // best_match default
    // Only Range moves.
    expect(parseRequest("p:d m:ca").mode).toBe(MODE_DETAIL);
    expect(parseRequest("p:a m:ca").mode).toBe(MODE_AUTO);
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

  it("d: picks the reply alphabet and length together", () => {
    // iPhone is the only route wide enough to pay for base32768, and it buys one satellite
    // bubble's worth — see DEVICE_TRANSPORT.
    expect(parseRequest("d:i")).toMatchObject({ alphabet: "base32768", maxChars: IPHONE_MAX_CHARS });
    // SMS spends the whole of GSM-7 basic at the same 160 characters — a wider alphabet buys bits
    // per character, not more characters.
    expect(parseRequest("d:s")).toMatchObject({ alphabet: "base124", maxChars: SMS_MAX_CHARS });
    // Internet is restricted by neither GSM-7 nor a length, so it takes every printable ASCII
    // character and runs until the upstream data does.
    expect(parseRequest("d:d")).toMatchObject({ alphabet: "base94", maxChars: UNCAPPED_MAX_CHARS });
    expect(parseRequest("d:g")).toMatchObject({ alphabet: "base85", maxChars: SMS_MAX_CHARS });
    // Same alphabet, different pipe: ZOLEO's gateway carries 240 bytes to a message, and base-85
    // spends one of them per character.
    expect(parseRequest("d:z")).toMatchObject({ alphabet: "base85", maxChars: ZOLEO_MAX_CHARS });
  });

  it("d: absent or unknown keeps the base-85 SMS defaults", () => {
    expect(parseRequest("").alphabet).toBeUndefined();
    expect(parseRequest("").maxChars).toBe(SMS_MAX_CHARS);
    // An unknown code must not silently widen the alphabet: base-85 reaches every device.
    expect(parseRequest("d:x").alphabet).toBeUndefined();
    expect(parseRequest("d:x").maxChars).toBe(SMS_MAX_CHARS);
  });

  // The length is derived, never stated: nothing in a request can widen the reply past what the
  // route it names can carry.
  it("ignores a length the request tries to state for itself", () => {
    expect(parseRequest("d:i c:320")).toMatchObject({
      alphabet: "base32768", maxChars: maxCharsFor("i", 1, WIRE_HEADER_CHARS),
    });
    expect(parseRequest("c:40 d:g").maxChars).toBe(SMS_MAX_CHARS);
  });

  it("n: spreads the reply over more messages", () => {
    // Two messages buy less than twice one, because each labelled part repeats the header.
    expect(parseRequest("d:i").maxChars).toBe(maxCharsFor("i", 1, WIRE_HEADER_CHARS));
    expect(parseRequest("d:i n:2").maxChars).toBe(maxCharsFor("i", 2, WIRE_HEADER_CHARS));
    expect(parseRequest("d:i n:2").maxChars).toBeLessThan(2 * parseRequest("d:i").maxChars);
    expect(parseRequest("d:i n:2").messages).toBe(2);
  });

  it("n: defaults to one and clamps rather than rejecting", () => {
    expect(parseRequest("").messages).toBe(1);
    expect(parseRequest("d:i n:0").messages).toBe(1);
    expect(parseRequest("d:i n:-4").messages).toBe(1);
    expect(parseRequest("d:i n:99").messages).toBe(MAX_MESSAGES);
    expect(parseRequest("d:i n:nonsense").messages).toBe(1);
  });

  it("n: is independent of the device, so token order never matters", () => {
    expect(parseRequest("n:2 d:i").maxChars).toBe(parseRequest("d:i n:2").maxChars);
    expect(parseRequest("n:2 d:g").maxChars).toBe(maxCharsFor("g", 2, WIRE_HEADER_CHARS));
    expect(parseRequest("n:2 d:s").maxChars).toBe(2 * SMS_MAX_CHARS);
  });
});

// What the gateway records about a request (the X-Request-Shape header). The masks are
// deliberately not part of it: their bit assignments belong to this protocol version, so a
// recorded mask would be misread once the next version reassigns a bit.
const describe_ = (body: string) => describeRequest(parseRequest(body));

describe("describeRequest", () => {
  it("names the priority mode", () => {
    expect(describe_("p:d").mode).toBe("detail");
    expect(describe_("p:a").mode).toBe("auto");
    expect(describe_("p:r").mode).toBe("range");
    expect(describe_("").mode).toBe("auto"); // the default, not an absent value
  });

  it("names the requested models", () => {
    expect(describe_("").models).toEqual(["best"]);
    expect(describe_("m:us,eu").models).toEqual(["us", "eu"]);
  });

  it("names the variables, always-on ones included", () => {
    // v: carries only the configurable additions; the core set is implicit in every request, and
    // the record should show what was actually asked for rather than what was typed.
    expect(describe_("").vars).toEqual(["temp", "snow", "wind", "gust", "rain"]);
    expect(describe_("v:pf").vars).toContain("precip");
    expect(describe_("v:pf").vars).toContain("freeze");
    expect(describe_("w:234").vars).toEqual(expect.arrayContaining(["w500", "w600", "w700"]));
  });

  // The rounding lives here, in the stateless service, so a position precise enough to place
  // somebody's camp is never sent to the part of the system that has a database.
  it("rounds coordinates to ~1km", () => {
    expect(describe_("63.0630419,-151.0810871")).toMatchObject({ lat: 63.06, lon: -151.08, loc: "current" });
  });

  it("resolves a named location to its own coordinates", () => {
    expect(describe_("l:summit")).toMatchObject({ lat: 63.07, lon: -151, loc: "summit" });
  });

  it("omits coordinates when the request carried none", () => {
    expect(describe_("p:a")).not.toHaveProperty("lat");
  });

  it("carries the response budget but never the account token", () => {
    const token = newToken();
    const shape = describe_(`d:i n:2 u:${token}`);
    expect(shape.maxChars).toBe(maxCharsFor("i", 2, WIRE_HEADER_CHARS));
    expect(JSON.stringify(shape)).not.toContain(token);
  });
});
