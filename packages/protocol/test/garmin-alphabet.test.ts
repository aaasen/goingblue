import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { gunzipSync } from "node:zlib";
import { encode, decode, encodeBodyLE, decodeBodyLE } from "../src/codec.js";
import { ALPHABET, GARMIN_ALPHABET } from "../src/constants.js";
import { DEVICE_TRANSPORT, type DeviceCode } from "../src/devices.js";
import { encodeVersion } from "../src/version.js";
import { decodeMessage, encodeMessage } from "../src/registry.js";
import { WIRE_HEADER_BITS, WIRE_HEADER_CHARS, WIRE_VERSION } from "../src/wire.js";
import { avalancheAnchor, encodeAvalancheMessage, loadModels, type AvalancheForecast } from "../src/index.js";
import { decodeAvalancheReply } from "../src/avalanche-codec/wire.js";
import SEA_TO_SKY from "../../mobile/fixtures/avalanche/sea-to-sky-2026-03-01.json";
import type { ForecastMessage, RequestContext, Variable } from "../src/model.js";
import wireFixture from "./fixtures/wire.fixture.json";

// Garmin counts $ @ _ as two characters each and splits a message that runs over 160, so nothing
// an inReach reader receives may contain them: not the body, and not the version tag or packed
// header, which every route shares. See GARMIN_ALPHABET in constants.ts.

const DOUBLED = /[$@_]/;

const d = { ...wireFixture.decoded,
  vars: new Set(wireFixture.decoded.vars as Variable[]) } as ForecastMessage;
const req = wireFixture.request;
const ctx = (device?: DeviceCode): RequestContext => ({
  model: 31 - Math.clz32(d.models_mask & -d.models_mask),
  vars: d.vars,
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

describe("the base-82 alphabet", () => {
  it("is base-85 without $ @ _, in the same order", () => {
    expect(GARMIN_ALPHABET).toHaveLength(82);
    expect(GARMIN_ALPHABET).not.toMatch(DOUBLED);
    expect([...ALPHABET].filter((c) => !"$@_".includes(c)).join("")).toBe(GARMIN_ALPHABET);
  });

  it("is the inReach body alphabet", () => {
    expect(DEVICE_TRANSPORT.g.alphabet).toBe("base82");
  });

  it("round-trips a body", () => {
    for (let seed = 1; seed <= 20; seed++) {
      const bits = lcgBits(seed, 900);
      const s = encodeBodyLE(bits, "base82");
      expect(s).not.toMatch(DOUBLED);
      let n = bits.length;
      while (n > 0 && bits[n - 1] === 0) n--;
      expect(decodeBodyLE(s, "base82").slice(0, n)).toEqual(bits.slice(0, n));
    }
  });
});

describe("the prefix every route shares", () => {
  it("tags this version with a character Garmin counts once", () => {
    expect(encodeVersion(WIRE_VERSION)).not.toMatch(DOUBLED);
  });

  it("fits the packed header in 4 base-82 characters, the largest value included", () => {
    expect(WIRE_HEADER_CHARS).toBe(5);
    const max = new Array(WIRE_HEADER_BITS).fill(1);
    expect(encode(max)).toHaveLength(4);
    expect(decode(encode(max), WIRE_HEADER_BITS)).toEqual(max);
    for (let seed = 1; seed <= 200; seed++) {
      const bits = lcgBits(seed, WIRE_HEADER_BITS);
      const s = encode(bits);
      expect(s).not.toMatch(DOUBLED);
      expect(decode(s, WIRE_HEADER_BITS)).toEqual(bits);
    }
  });
});

describe("an inReach reply", () => {
  it("contains no character Garmin counts twice, and decodes", () => {
    const s = encodeMessage(d, DEVICE_TRANSPORT.g.alphabet);
    expect(s).not.toMatch(DOUBLED);
    expect(decodeMessage(s, () => ctx("g"))).toEqual(decodeMessage(encodeMessage(d, "base85"), () => ctx("z")));
  });

  it("does the same for an avalanche bulletin", () => {
    const models = loadModels(gunzipSync(readFileSync(new URL("../assets/avcan-model.bin.gz", import.meta.url))));
    const anchor = avalancheAnchor("2026-03-01", 0);
    const forecast = SEA_TO_SKY as AvalancheForecast;
    const s = encodeAvalancheMessage(models, 7, anchor, forecast, DEVICE_TRANSPORT.g.alphabet);
    expect(s).not.toMatch(DOUBLED);
    const viaZoleo = encodeAvalancheMessage(models, 7, anchor, forecast, DEVICE_TRANSPORT.z.alphabet);
    expect(decodeAvalancheReply(models, s, anchor, "g")).toEqual(decodeAvalancheReply(models, viaZoleo, anchor, "z"));
  });
});
