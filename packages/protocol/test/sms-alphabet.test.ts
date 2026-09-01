import { describe, it, expect } from "vitest";
import { decode as wideDecode } from "base32768";
import { encodeBodyLE, decodeBodyLE, decodeBodyAuto, bodyAlphabet } from "../src/codec.js";
import { ALPHABET, GSM_LATIN1, GSM_GREEK, SMS_ALPHABET } from "../src/constants.js";
import { wireCodec, messageToString, WIRE_HEADER_CHARS } from "../src/wire.js";
import { DEVICE_TRANSPORT } from "../src/devices.js";
import type { ForecastMessage, RequestContext, Variable } from "../src/model.js";
import wireFixture from "./fixtures/wire.fixture.json";

// The SMS route's alphabet — GSM-7 basic in full rather than its intersection with ASCII. See
// constants.ts for what each half survives, decided by a field run.

const d = { ...wireFixture.decoded,
  vars: new Set(wireFixture.decoded.vars as Variable[]) } as ForecastMessage;
const req = wireFixture.request;
const ctx = (device?: RequestContext["device"]): RequestContext => ({
  model: 31 - Math.clz32(d.models_mask & -d.models_mask),
  vars: d.vars,
  lat: d.lat,
  lon: d.lon,
  start: Date.UTC(new Date().getUTCFullYear(), req.month - 1, req.day, req.hour),
  mode: req.mode,
  utcOffsetHours: req.utcOffsetHours,
  device,
});

// Deterministic bit stream, so a failure is reproducible from the seed alone.
function lcgBits(seed: number, count: number): number[] {
  const bits: number[] = [];
  let x = seed >>> 0;
  for (let i = 0; i < count; i++) {
    x = (Math.imul(x, 1103515245) + 12345) >>> 0;
    bits.push((x >>> 20) & 1);
  }
  return bits;
}

// The body codec drops trailing zeros, so a round trip restores the meaningful low bits and pads
// the rest with the zeros the decoder already treats as implicit.
function expectRoundTrip(bits: number[], got: number[]) {
  let n = bits.length;
  while (n > 0 && bits[n - 1] === 0) n--;
  expect(got.slice(0, n)).toEqual(bits.slice(0, n));
  expect(got.slice(n).every((b) => b === 0)).toBe(true);
}

describe("the base-124 alphabet", () => {
  it("is base-85 plus the whole non-ASCII half of GSM-7 basic, with nothing repeated", () => {
    expect([...GSM_LATIN1]).toHaveLength(29);
    expect([...GSM_GREEK]).toHaveLength(10);
    expect([...SMS_ALPHABET]).toHaveLength(124);
    expect(new Set(SMS_ALPHABET).size).toBe(124);
    expect(SMS_ALPHABET.startsWith(ALPHABET)).toBe(true);
  });

  it("splits the extras by what they survive: Latin-1 has an equivalent, Greek doesn't", () => {
    // The split is the fallback (drop GSM_GREEK for 114), so it has to be exactly the Latin-1
    // boundary and not an approximation of it — U+00FF is the top of ISO-8859-1.
    for (const c of GSM_LATIN1) {
      const cp = c.codePointAt(0)!;
      expect(cp).toBeGreaterThan(0x7f);
      expect(cp).toBeLessThanOrEqual(0xff);
    }
    for (const c of GSM_GREEK) {
      expect(c.codePointAt(0)!).toBeGreaterThan(0xff);
    }
  });

  it("shares no character with base32768's repertoire", () => {
    // Asked of the library rather than of a code-point range, because the repertoire is not one
    // range: base32768 uses U+04A0 upward for its 15-bit characters plus two small blocks at
    // U+0180 and U+0240 for the 7-bit tail, and the Greek extras sit in the gap between them.
    // "Unrecognised" is the library's verdict for a character it has no digit for at all.
    for (const c of GSM_LATIN1 + GSM_GREEK) {
      expect(() => wideDecode(c)).toThrow(/Unrecognised/);
    }
  });
});

describe("base-124 body codec", () => {
  it("round-trips bit arrays of every length past a character boundary", () => {
    for (let n = 0; n <= 130; n++) {
      const bits = lcgBits(n + 1, n);
      expectRoundTrip(bits, decodeBodyLE(encodeBodyLE(bits, "base124"), "base124"));
    }
  });

  it("round-trips a body long enough to need many characters", () => {
    const bits = lcgBits(7, 4096);
    expectRoundTrip(bits, decodeBodyLE(encodeBodyLE(bits, "base124"), "base124"));
  });

  it("spends 6.954 bits per character against base-85's 6.409", () => {
    const bits = lcgBits(11, 1024);
    const wide = encodeBodyLE(bits, "base124").length;
    const narrow = encodeBodyLE(bits).length;
    expect(wide).toBeLessThan(narrow);
    // 1024 bits: ceil(1024 / log2(124)) = 148 characters, against 160 for base-85.
    expect(wide).toBe(Math.ceil(1024 / Math.log2(124)));
    expect(narrow).toBe(Math.ceil(1024 / Math.log2(85)));
  });

  it("leaves base-85 encoding untouched when no alphabet is named", () => {
    const bits = lcgBits(13, 600);
    expect(encodeBodyLE(bits)).toBe(encodeBodyLE(bits, "base85"));
  });

  it("rejects a base-124 body read as base-85, naming the character", () => {
    // Guaranteed to contain extras at this length, so the guard fires rather than the rANS stream.
    const body = encodeBodyLE(lcgBits(17, 900), "base124");
    expect([...body].some((c) => c.codePointAt(0)! > 0x7f)).toBe(true);
    expect(() => decodeBodyLE(body)).toThrow(/is not a base-85 character/);
  });
});

describe("the alphabet a reply is decoded in", () => {
  const encodedFor = (alphabet: "base85" | "base124") => messageToString(d, alphabet);

  it("comes from the request's route, not from inspecting the body", () => {
    const encoded = encodedFor("base124");
    expect(wireCodec.decode(encoded, () => ctx("s"))).toEqual(d);
  });

  it("carries more of the forecast in the same 160 characters", () => {
    // The same message, both ways: the point of the whole exercise is that the base-124 body is
    // shorter, which the fill search spends on more periods rather than a shorter reply.
    expect(encodedFor("base124").length).toBeLessThan(encodedFor("base85").length);
  });

  it("still decodes base-85 for the routes that keep it", () => {
    for (const code of ["z", "g"] as const) {
      expect(DEVICE_TRANSPORT[code].alphabet).toBe("base85");
      expect(wireCodec.decode(encodedFor("base85"), () => ctx(code))).toEqual(d);
    }
  });

  it("falls back to guessing when the context predates the device field", () => {
    // A stored context with no route can only be base-85 or base32768, and bodyAlphabet tells
    // those apart exactly — every base-124 reply comes from a context that records the route.
    expect(wireCodec.decode(encodedFor("base85"), () => ctx(undefined))).toEqual(d);
    expect(bodyAlphabet(encodedFor("base85").slice(WIRE_HEADER_CHARS))).toBe("base85");
  });

  it("refuses a base-124 body handed the wrong route, rather than inventing a forecast", () => {
    // The failure this protects: base-124 is a superset of base-85, so the same characters mean
    // different numbers. Reading one as the other must not quietly produce weather.
    const encoded = encodedFor("base124");
    expect(() => wireCodec.decode(encoded, () => ctx("g"))).toThrow();
    // And with no route at all the guess is wrong too — the extras read as non-ASCII, so it
    // reaches for base32768 and that codec refuses them. Loud either way, never a forecast.
    expect(() => wireCodec.decode(encoded, () => ctx(undefined))).toThrow();
  });

  it("hands decodeBodyAuto an explicit alphabet in preference to the guess", () => {
    const bits = lcgBits(23, 300);
    const body = encodeBodyLE(bits, "base124");
    expectRoundTrip(bits, decodeBodyAuto(body, "base124"));
  });
});
