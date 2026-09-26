import { readFileSync } from "node:fs";
import { gunzipSync } from "node:zlib";
import { describe, it, expect } from "vitest";
import {
  avalancheAnchor, decodeAvalancheMessage, encodeAvalancheMessage, headerFromString, loadModels,
  withPlaceholders, type Alphabet, type AvalancheForecast,
} from "../src/index.js";
import { buildTable, Decoder, encode as ransEncode, type Decision } from "../src/avalanche-codec/rans.js";
import { decodeUtf8 } from "../src/avalanche-codec/utf8.js";
import SEA_TO_SKY from "../../mobile/fixtures/avalanche/sea-to-sky-2026-03-01.json";

const MODELS = loadModels(gunzipSync(readFileSync(new URL("../assets/avcan-model.bin.gz", import.meta.url))));
const FORECAST = SEA_TO_SKY as AvalancheForecast;
const ANCHOR = avalancheAnchor("2026-03-01", 0);

describe("avalanche wire", () => {
  it.each(["base85", "base94", "base124", "base32768"] as Alphabet[])("round-trips in %s", (alphabet) => {
    const s = encodeAvalancheMessage(MODELS, 42, ANCHOR, FORECAST, alphabet);
    expect(headerFromString(s).code).toBe(42);
    const { code, forecast } = decodeAvalancheMessage(MODELS, s, ANCHOR, alphabet);
    expect(code).toBe(42);
    expect(forecast).toEqual(withPlaceholders(FORECAST));
  });

  it("anchors the latest bulletin to the request time", () => {
    expect(avalancheAnchor(null, 490000)).toBe(490000 * 3600000);
    expect(avalancheAnchor("2026-03-01", 490000)).toBe(Date.parse("2026-03-01T19:00:00Z"));
  });

  it("carries the issue time to its 15-minute step and the expiry to the minute", () => {
    const f = {
      ...FORECAST,
      issued: Date.parse("2026-02-28T22:15:59.950Z"),
      expires: Date.parse("2026-03-03T23:00:00Z"),
    };
    const { forecast } = decodeAvalancheMessage(MODELS, encodeAvalancheMessage(MODELS, 1, ANCHOR, f), ANCHOR);
    expect(forecast.issued).toBe(Date.parse("2026-02-28T22:15:00Z"));
    expect(forecast.expires).toBe(Date.parse("2026-03-03T23:00:00Z"));
    const open = { ...FORECAST, expires: NaN };
    expect(decodeAvalancheMessage(MODELS, encodeAvalancheMessage(MODELS, 1, ANCHOR, open), ANCHOR).forecast.expires).toBeNaN();
  });

  it("reaches back months for seasonal placeholders and two days forward, and no further", () => {
    const at = (issued: number) => encodeAvalancheMessage(MODELS, 1, ANCHOR, { ...FORECAST, issued });
    const day = 24 * 3600000;
    for (const issued of [ANCHOR - 300 * day, ANCHOR + 2 * day]) {
      expect(decodeAvalancheMessage(MODELS, at(issued), ANCHOR).forecast.issued).toBe(issued);
    }
    expect(() => at(ANCHOR - 400 * day)).toThrow(/out of the header's range/);
    expect(() => at(ANCHOR + 2 * day + 15 * 60000)).toThrow(/out of the header's range/);
  });
});

describe("avalanche rANS", () => {
  // The wire's body codecs drop trailing zero bits, so a stream ending in zero bytes arrives
  // shorter than it left. The decoder reads the missing bytes as zeros.
  it("decodes a stream whose trailing zero bytes were dropped", () => {
    const table = buildTable([[0, 5], [1, 3], [2, 1]]);
    let trimmed = 0;
    let seed = 1;
    const next = () => (seed = (seed * 1103515245 + 12345) % 2147483648);
    for (let n = 0; n < 3000; n++) {
      const plan: Decision[] = Array.from({ length: 20 + (n % 50) }, () => [table, next() % 3]);
      const blob = ransEncode(plan);
      let end = blob.length;
      while (end > 0 && blob[end - 1] === 0) end--;
      if (end === blob.length) continue;
      trimmed++;
      const dec = new Decoder(blob.subarray(0, end));
      for (const [t, sym] of plan) expect(dec.get(t)).toBe(sym);
    }
    expect(trimmed).toBeGreaterThan(0);
  });
});

describe("decodeUtf8", () => {
  it("matches TextDecoder on well-formed and malformed input", () => {
    const text = "Québec: crête d'été ’quoted’ −12 °C ⚠️ 𝔸 end";
    expect(decodeUtf8(new TextEncoder().encode(text))).toBe(text);
    for (const bad of [[0xff], [0xc3], [0xe2, 0x82], [0xed, 0xa0, 0x80], [0xc0, 0xaf], [0x41, 0x80, 0x42]]) {
      expect(decodeUtf8(Uint8Array.from(bad)), JSON.stringify(bad)).toBe(new TextDecoder().decode(Uint8Array.from(bad)));
    }
  });
});
