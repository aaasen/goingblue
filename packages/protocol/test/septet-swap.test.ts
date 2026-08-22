import { describe, it, expect } from "vitest";
import { ALPHABET, SEPTET_SWAP, foldSeptetSwap } from "../src/constants.js";
import { CODECS, decodeMessage, peekHeader, encodeMessage } from "../src/registry.js";
import { peekVersion, encodeVersion } from "../src/version.js";
import { DEVICE_TRANSPORT } from "../src/devices.js";
import type { ForecastMessage, RequestContext, DeviceCode } from "../src/index.js";
import v3Fixture from "./fixtures/v3.fixture.json";

// The inReach display swap: Garmin Messenger shows a base-85 reply's $ @ _ as ¤ ¡ § — the GSM-7
// reading of the same three septets. Field-confirmed 2026-08-22 (a v2 reply on the shipped app:
// nothing else in 160 characters was touched, and the swapped-back paste decoded). The decoder
// folds them back wherever the text is known to be base-85, and leaves an SMS body alone because
// there the three are real base-124 symbols. See SEPTET_SWAP in constants.ts.

const d = v3Fixture.decoded as ForecastMessage;
const req = v3Fixture.request;
const ctx = (device?: DeviceCode): RequestContext => ({
  model: 31 - Math.clz32(d.models_mask & -d.models_mask),
  vars_mask: d.vars_mask,
  lat: d.lat,
  lon: d.lon,
  start: Date.UTC(new Date().getUTCFullYear(), req.month - 1, req.day, req.hour),
  mode: req.mode,
  utcOffsetHours: req.utcOffsetHours,
  device,
});

// What Garmin does to a reply on the way to the reader.
const garmin = (s: string) => s.replace(/[$@_]/g, (c) => ({ $: "¤", "@": "¡", _: "§" })[c]!);

describe("the inReach septet swap", () => {
  it("maps exactly the three GSM-7 positions ASCII spends on $ @ _", () => {
    expect(Object.entries(SEPTET_SWAP)).toEqual([["¤", "$"], ["¡", "@"], ["§", "_"]]);
    for (const ascii of Object.values(SEPTET_SWAP)) expect(ALPHABET).toContain(ascii);
    for (const gsm of Object.keys(SEPTET_SWAP)) expect(ALPHABET).not.toContain(gsm);
  });

  it("folds back to the character the route wrote, and is a no-op on base-85 text", () => {
    expect(foldSeptetSwap("#¤Hiv§bU¡x")).toBe("#$Hiv_bU@x");
    expect(foldSeptetSwap(ALPHABET)).toBe(ALPHABET);
  });

  it("reads a v3 version tag through the swap — the tag itself is `$`", () => {
    expect(encodeVersion(3)).toBe("$");
    expect(peekVersion(garmin(encodeVersion(3) + "rest"))).toBe(3);
  });
});

describe("decoding a swapped reply", () => {
  for (const device of ["g", "z", "d"] as const) {
    it(`route ${device} (${DEVICE_TRANSPORT[device].alphabet}): the swapped paste decodes to the same message as the clean one`, () => {
      const clean = encodeMessage(d, DEVICE_TRANSPORT[device].alphabet);
      // The fixture must actually exercise the swap, or this test proves nothing.
      expect(clean).toMatch(/[$@_]/);
      const swapped = garmin(clean);
      expect(swapped).not.toBe(clean);
      const resolve = () => ctx(device);
      expect(peekHeader(swapped)).toEqual(peekHeader(clean));
      expect(decodeMessage(swapped, resolve)).toEqual(decodeMessage(clean, resolve));
    });
  }

  it("a route that recorded no device still folds — the guess can only be base-85 or wide", () => {
    const clean = encodeMessage(d, "base85");
    expect(clean).toMatch(/[$@_]/);
    const resolve = () => ctx(undefined);
    expect(decodeMessage(garmin(clean), resolve)).toEqual(decodeMessage(clean, resolve));
  });

  it("leaves an SMS body alone: there ¤ ¡ § are base-124's own characters", () => {
    const clean = encodeMessage(d, "base124");
    const resolve = () => ctx("s");
    const header = clean.slice(0, CODECS[3].headerChars);
    const body = clean.slice(header.length);
    // Only the base-85 prefix may be folded. Swap the header (as Garmin would) but keep the body
    // exactly as the SMS route wrote it; the message must survive unchanged.
    expect(decodeMessage(garmin(header) + body, resolve)).toEqual(decodeMessage(clean, resolve));
    // And a base-124 body that genuinely contains the three must NOT be folded: build one by
    // swapping a base-85 body's $ @ _ — if the decoder folded it, the two would read the same.
    const b85 = encodeMessage(d, "base85");
    if (/[$@_]/.test(b85.slice(header.length))) {
      const asSms = garmin(b85);
      const folded = (() => { try { return decodeMessage(asSms, resolve); } catch { return null; } })();
      expect(folded).not.toEqual(decodeMessage(b85, () => ctx("g")));
    }
  });
});

