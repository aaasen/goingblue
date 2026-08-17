import { describe, it, expect } from "vitest";
import { encodeBodyLE, decodeBodyLE } from "../src/codec.js";
import { ALPHABET, HTTP_ALPHABET, SMS_ALPHABET } from "../src/constants.js";
import { v2Codec, v2MessageToString } from "../src/versions/v2.js";
import { DEVICE_TRANSPORT, UNCAPPED_MAX_CHARS, maxCharsFor } from "../src/devices.js";
import { V2_HEADER_CHARS } from "../src/versions/v2.js";
import type { ForecastMessage, RequestContext } from "../src/model.js";
import v2Fixture from "./fixtures/v2.fixture.json";

// The internet route: the only one restricted by neither GSM-7 nor a character count, so it takes
// every printable ASCII character and the whole forecast. See constants.ts for why the answer is
// ASCII rather than something wider — over a byte-counted transport, wider is bigger.

const d = v2Fixture.decoded as ForecastMessage;
const req = v2Fixture.request;
const ctx = (device?: RequestContext["device"]): RequestContext => ({
  model: 31 - Math.clz32(d.models_mask & -d.models_mask),
  vars_mask: d.vars_mask,
  lat: d.lat,
  lon: d.lon,
  start: Date.UTC(new Date().getUTCFullYear(), req.month - 1, req.day, req.hour),
  mode: req.mode,
  utcOffsetHours: req.utcOffsetHours,
  device,
});

function lcgBits(seed: number, count: number): number[] {
  const bits: number[] = [];
  let x = seed >>> 0;
  for (let i = 0; i < count; i++) {
    x = (Math.imul(x, 1103515245) + 12345) >>> 0;
    bits.push((x >>> 20) & 1);
  }
  return bits;
}

function expectRoundTrip(bits: number[], got: number[]) {
  let n = bits.length;
  while (n > 0 && bits[n - 1] === 0) n--;
  expect(got.slice(0, n)).toEqual(bits.slice(0, n));
  expect(got.slice(n).every((b) => b === 0)).toBe(true);
}

describe("the base-94 alphabet", () => {
  it("is every printable ASCII character except space", () => {
    expect([...HTTP_ALPHABET]).toHaveLength(94);
    expect(new Set(HTTP_ALPHABET).size).toBe(94);
    for (const c of HTTP_ALPHABET) {
      const cp = c.codePointAt(0)!;
      expect(cp).toBeGreaterThanOrEqual(0x21); // past space
      expect(cp).toBeLessThanOrEqual(0x7e);    // before DEL
    }
    expect(HTTP_ALPHABET).not.toContain(" ");
  });

  it("adds back exactly what GSM-7 costs base-85", () => {
    // base-85 is base-94 minus the nine printable characters GSM-7 either omits or relegates to
    // its two-septet extension table. Nothing else separates them.
    for (const c of ALPHABET) expect(HTTP_ALPHABET).toContain(c);
    const extra = [...HTTP_ALPHABET].filter((c) => !ALPHABET.includes(c)).join("");
    expect(extra).toBe("[\\]^`{|}~");
    expect(extra).toHaveLength(9);
  });

  it("is one byte a character, which is the whole reason it wins over HTTP", () => {
    // The claim the route's alphabet rests on: ASCII is the only tier UTF-8 doesn't tax. base-94
    // carries 6.555 bits per byte; base-124 averages 1.315 bytes a character for 5.29, and
    // base32768 is 3 bytes a character for 5.01. Wider would mean bigger.
    expect(Buffer.byteLength(HTTP_ALPHABET, "utf8")).toBe(94);
    const bitsPerByte = (chars: string) =>
      Math.log2([...chars].length) / (Buffer.byteLength(chars, "utf8") / [...chars].length);
    expect(bitsPerByte(HTTP_ALPHABET)).toBeCloseTo(6.555, 2);
    expect(bitsPerByte(HTTP_ALPHABET)).toBeGreaterThan(bitsPerByte(ALPHABET));
    expect(bitsPerByte(HTTP_ALPHABET)).toBeGreaterThan(bitsPerByte(SMS_ALPHABET));
  });
});

describe("base-94 body codec", () => {
  it("round-trips bit arrays of every length past a character boundary", () => {
    for (let n = 0; n <= 130; n++) {
      const bits = lcgBits(n + 1, n);
      expectRoundTrip(bits, decodeBodyLE(encodeBodyLE(bits, "base94"), "base94"));
    }
  });

  it("round-trips a body long enough to need many characters", () => {
    const bits = lcgBits(7, 4096);
    expectRoundTrip(bits, decodeBodyLE(encodeBodyLE(bits, "base94"), "base94"));
  });

  it("spends 6.555 bits per character against base-85's 6.409", () => {
    const bits = lcgBits(11, 1024);
    expect(encodeBodyLE(bits, "base94").length).toBe(Math.ceil(1024 / Math.log2(94)));
    expect(encodeBodyLE(bits, "base94").length).toBeLessThan(encodeBodyLE(bits).length);
  });

  it("rejects a base-94 body read as base-85, naming the character", () => {
    const body = encodeBodyLE(lcgBits(17, 900), "base94");
    expect([...body].some((c) => !ALPHABET.includes(c))).toBe(true);
    expect(() => decodeBodyLE(body)).toThrow(/is not a base-85 character/);
  });
});

describe("the internet route", () => {
  it("takes base-94 and no character budget", () => {
    expect(DEVICE_TRANSPORT.d.alphabet).toBe("base94");
    expect(DEVICE_TRANSPORT.d.maxChars).toBe(UNCAPPED_MAX_CHARS);
    // Big enough that no reply can reach it, and a real number, so it survives a JSON log.
    expect(Number.isSafeInteger(UNCAPPED_MAX_CHARS)).toBe(true);
    expect(maxCharsFor("d", 1, V2_HEADER_CHARS)).toBe(UNCAPPED_MAX_CHARS);
  });

  it("decodes its replies from the route, the same as every other alphabet", () => {
    expect(v2Codec.decode(v2MessageToString(d, "base94"), () => ctx("d"))).toEqual(d);
  });

  it("refuses a base-94 body handed the wrong route rather than inventing a forecast", () => {
    // base-94 is a superset of base-85, so the same characters mean different numbers. This is
    // why the alphabet is read off the stored route and never guessed from the body: both are
    // ASCII, so nothing in the text could tell them apart.
    const encoded = v2MessageToString(d, "base94");
    expect(() => v2Codec.decode(encoded, () => ctx("g"))).toThrow();
    expect(() => v2Codec.decode(encoded, () => ctx(undefined))).toThrow();
  });
});
