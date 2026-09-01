import { describe, it, expect } from "vitest";
import {
  encodeBodyLE, decodeBodyLE, encodeBodyWide, decodeBodyWide, bodyAlphabet, decodeBodyAuto,
} from "../src/codec.js";
import { wireCodec, WIRE_HEADER_CHARS } from "../src/wire.js";
import { decodeMessage } from "../src/registry.js";
import { IPHONE_MAX_CHARS, DEVICE_TRANSPORT } from "../src/devices.js";
import type { ForecastMessage, Variable } from "../src/model.js";
import wireFixture from "./fixtures/wire.fixture.json";

const d = { ...wireFixture.decoded,
  vars: new Set(wireFixture.decoded.vars as Variable[]) } as ForecastMessage;
const req = wireFixture.request;
const ctx = () => ({
  model: 31 - Math.clz32(d.models_mask & -d.models_mask),
  vars: d.vars,
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

describe("messages in base32768", () => {
  it("decodes to the same message the base-85 encoding does", () => {
    const wide = wireCodec.encode(d, "base32768");
    expect(wide).not.toBe(wireFixture.encoded);
    expect(wireCodec.decode(wide, ctx)).toEqual(d);
  });

  it("dispatches by version tag with no knowledge of the alphabet", () => {
    expect(decodeMessage(wireCodec.encode(d, "base32768"), ctx)).toEqual(d);
  });

  it("defaults to base-85, so an unmarked request is unaffected", () => {
    expect(wireCodec.encode(d)).toBe(wireFixture.encoded);
    expect(wireCodec.encode(d, "base85")).toBe(wireFixture.encoded);
  });

  it("keeps the version tag and packed header in ASCII", () => {
    const wide = wireCodec.encode(d, "base32768");
    expect(wide.slice(0, WIRE_HEADER_CHARS)).toBe(wireFixture.encoded.slice(0, WIRE_HEADER_CHARS));
    expect([...wide.slice(0, WIRE_HEADER_CHARS)].every((c) => c.codePointAt(0)! < 0x80)).toBe(true);
    expect(wide.codePointAt(WIRE_HEADER_CHARS)!).toBeGreaterThan(0x7f);
  });

  it("carries the same forecast in fewer characters", () => {
    expect(wireCodec.encode(d, "base32768").length).toBeLessThan(wireFixture.encoded.length);
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
  const replyBytes = (chars: number) => WIRE_HEADER_CHARS + (chars - WIRE_HEADER_CHARS) * 3;

  it("fits a bubble at the cap", () => {
    expect(IPHONE_MAX_CHARS).toBeLessThanOrEqual(BUBBLE_UNITS);
    expect(replyBytes(IPHONE_MAX_CHARS)).toBeLessThanOrEqual(BUBBLE_BYTES);
  });

  it("splits one character past it", () => {
    expect(replyBytes(IPHONE_MAX_CHARS + 1)).toBeGreaterThan(BUBBLE_BYTES);
  });

  it("gives every route the widest alphabet its own unit allows", () => {
    // Four routes, four different answers, each from what the pipe counts: UTF-16 code units for
    // Apple's relay, septets for SMS, bytes for HTTP, and the ASCII-and-GSM-7 intersection for the
    // routes that must satisfy both. See sms-alphabet.test.ts and http-alphabet.test.ts.
    expect(DEVICE_TRANSPORT.i).toEqual({ alphabet: "base32768", maxChars: IPHONE_MAX_CHARS });
    expect(DEVICE_TRANSPORT.s.alphabet).toBe("base124");
    expect(DEVICE_TRANSPORT.d.alphabet).toBe("base94");
    for (const code of ["z", "g"] as const) {
      expect(DEVICE_TRANSPORT[code].alphabet).toBe("base85");
    }
    // The SMS-segment routes are a single 160-character segment — the alphabet changes what a
    // character carries, not how many there are. ZOLEO's gateway carries 240: its cap is raw
    // UTF-8 bytes (measured), which an ASCII alphabet spends one per character.
    for (const code of ["s", "g"] as const) {
      expect(DEVICE_TRANSPORT[code].maxChars).toBe(160);
    }
    expect(DEVICE_TRANSPORT.z.maxChars).toBe(240);
  });
});
