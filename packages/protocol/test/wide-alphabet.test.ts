import { describe, it, expect } from "vitest";
import {
  encodeBodyLE, decodeBodyLE, encodeBodyWide, decodeBodyWide, bodyAlphabet, decodeBodyAuto,
} from "../src/codec.js";
import { v2Codec, V2_HEADER_CHARS } from "../src/versions/v2.js";
import { decodeMessage } from "../src/registry.js";
import { IPHONE_MAX_CHARS, DEVICE_TRANSPORT } from "../src/devices.js";
import type { ForecastMessage } from "../src/model.js";
import v2Fixture from "./fixtures/v2.fixture.json";

const d = v2Fixture.decoded as ForecastMessage;
const req = v2Fixture.request;
const ctx = () => ({
  model: 31 - Math.clz32(d.models_mask & -d.models_mask),
  vars_mask: d.vars_mask,
  lat: d.lat,
  lon: d.lon,
  start: Date.UTC(new Date().getUTCFullYear(), req.month - 1, req.day, req.hour),
  mode: req.mode,
  utcOffsetHours: req.utcOffsetHours,
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

// Both body codecs drop trailing zeros, so a round trip restores the meaningful low bits and
// pads the rest with the zeros the decoder already treats as implicit.
function expectRoundTrip(bits: number[], got: number[]) {
  let n = bits.length;
  while (n > 0 && bits[n - 1] === 0) n--;
  expect(got.slice(0, n)).toEqual(bits.slice(0, n));
  expect(got.slice(n).every((b) => b === 0)).toBe(true);
}

describe("base32768 body codec", () => {
  it("round-trips bit arrays of every length past a character boundary", () => {
    // 15 bits per character and 8 per byte, so the interesting lengths are around lcm(8, 15).
    for (let n = 0; n <= 130; n++) {
      const bits = lcgBits(n + 1, n);
      expectRoundTrip(bits, decodeBodyWide(encodeBodyWide(bits)));
    }
  });

  it("round-trips a body long enough to need many characters", () => {
    const bits = lcgBits(7, 4096);
    expectRoundTrip(bits, decodeBodyWide(encodeBodyWide(bits)));
  });

  it("spends 15 bits per character, against base-85's 6.41", () => {
    const bits = lcgBits(11, 1500);
    // The bit array is packed to whole bytes before base32768 sees it, so the character count
    // is ceil(bytes × 8 / 15) — 15 bits each, plus whatever the last one carries.
    const wide = encodeBodyWide(bits);
    expect(wide.length).toBe(Math.ceil((Math.ceil(1500 / 8) * 8) / 15));
    expect(1500 / wide.length).toBeGreaterThan(14.5);
    expect(1500 / encodeBodyLE(bits).length).toBeLessThan(6.5);
  });

  it("encodes an all-zero body to nothing, like base-85", () => {
    expect(encodeBodyWide(new Array(64).fill(0))).toBe("");
    expect(encodeBodyLE(new Array(64).fill(0))).toBe("");
  });
});

describe("alphabet detection", () => {
  it("reads the alphabet off the body itself", () => {
    const bits = lcgBits(13, 300);
    expect(bodyAlphabet(encodeBodyWide(bits))).toBe("base32768");
    expect(bodyAlphabet(encodeBodyLE(bits))).toBe("base85");
  });

  it("treats an empty body as base-85, which decodes identically either way", () => {
    expect(bodyAlphabet("")).toBe("base85");
    expect(decodeBodyAuto("")).toEqual([]);
    expect(decodeBodyWide("")).toEqual(decodeBodyLE(""));
  });

  it("decodes either alphabet without being told which", () => {
    const bits = lcgBits(17, 600);
    expectRoundTrip(bits, decodeBodyAuto(encodeBodyWide(bits)));
    expectRoundTrip(bits, decodeBodyAuto(encodeBodyLE(bits)));
  });
});

describe("v2 messages in base32768", () => {
  it("decodes to the same message the base-85 encoding does", () => {
    const wide = v2Codec.encode(d, "base32768");
    expect(wide).not.toBe(v2Fixture.encoded);
    expect(v2Codec.decode(wide, ctx)).toEqual(v2Fixture.decoded);
  });

  it("dispatches by version tag with no knowledge of the alphabet", () => {
    expect(decodeMessage(v2Codec.encode(d, "base32768"), ctx)).toEqual(v2Fixture.decoded);
  });

  it("defaults to base-85, so an unmarked request is unaffected", () => {
    expect(v2Codec.encode(d)).toBe(v2Fixture.encoded);
    expect(v2Codec.encode(d, "base85")).toBe(v2Fixture.encoded);
  });

  it("keeps the version tag and packed header in ASCII", () => {
    const wide = v2Codec.encode(d, "base32768");
    expect(wide.slice(0, V2_HEADER_CHARS)).toBe(v2Fixture.encoded.slice(0, V2_HEADER_CHARS));
    expect([...wide.slice(0, V2_HEADER_CHARS)].every((c) => c.codePointAt(0)! < 0x80)).toBe(true);
    expect(wide.codePointAt(V2_HEADER_CHARS)!).toBeGreaterThan(0x7f);
  });

  it("carries the same forecast in fewer characters", () => {
    expect(v2Codec.encode(d, "base32768").length).toBeLessThan(v2Fixture.encoded.length);
  });
});

// The budget that makes the wide alphabet worth having: one reply, one satellite bubble, one
// paste. Apple's relay frames a bubble at min(70 UTF-16 code units, ~140 bytes of compressed
// UTF-8), so a reply at the cap has to clear BOTH — and one character more must not.
describe("the iPhone one-bubble budget", () => {
  const BUBBLE_UNITS = 70;
  const BUBBLE_BYTES = 140;
  // Worst case: every body character costs 3 UTF-8 bytes. base32768 spends 2 on its tail
  // character when the bit count doesn't fill it, so this is an upper bound on any real reply.
  const replyBytes = (chars: number) => V2_HEADER_CHARS + (chars - V2_HEADER_CHARS) * 3;

  it("fits a bubble at the cap", () => {
    expect(IPHONE_MAX_CHARS).toBeLessThanOrEqual(BUBBLE_UNITS);
    expect(replyBytes(IPHONE_MAX_CHARS)).toBeLessThanOrEqual(BUBBLE_BYTES);
  });

  it("splits one character past it", () => {
    expect(replyBytes(IPHONE_MAX_CHARS + 1)).toBeGreaterThan(BUBBLE_BYTES);
  });

  it("routes iPhone to the wide alphabet and everything else to base-85", () => {
    expect(DEVICE_TRANSPORT.i).toEqual({ alphabet: "base32768", maxChars: IPHONE_MAX_CHARS });
    for (const code of ["s", "z", "d", "g"] as const) {
      expect(DEVICE_TRANSPORT[code].alphabet).toBe("base85");
      expect(DEVICE_TRANSPORT[code].maxChars).toBe(160);
    }
  });
});
