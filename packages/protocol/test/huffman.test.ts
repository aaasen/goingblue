import { describe, it, expect } from "vitest";
import {
  encodeWeathercode,
  decodeWeathercode,
  chooseWcTable,
  WC_TABLE_COUNT,
  WMO_CODES,
  encodeWindDir,
  decodeWindDir,
  chooseWindDirTable,
  WIND_DIR_TABLE_COUNT,
  encodeTempDelta,
  decodeTempDelta,
  chooseTempDeltaTable,
  TEMP_DELTA_TABLE_COUNT,
  TEMP_DELTA_CORE_RADIUS,
} from "../src/index.js";

function totalBits(idxs: number[], table: number): number {
  const bits: number[] = [];
  for (const i of idxs) encodeWeathercode(bits, table, i);
  return bits.length;
}

describe("weathercode Huffman", () => {
  it("round-trips every WMO index under every table", () => {
    for (let table = 0; table < WC_TABLE_COUNT; table++) {
      for (let idx = 0; idx < WMO_CODES.length; idx++) {
        const bits: number[] = [];
        encodeWeathercode(bits, table, idx);
        expect(bits.length).toBeGreaterThan(0);
        const [out, pos] = decodeWeathercode(bits, 0, table);
        expect(out).toBe(idx);
        expect(pos).toBe(bits.length); // consumed exactly the code, no more
      }
    }
  });

  it("decodes a concatenated sequence unambiguously (prefix-free)", () => {
    const seq = [0, 3, 3, 16, 17, 25, 11, 2, 0, 0, 27, 8, 20];
    for (let table = 0; table < WC_TABLE_COUNT; table++) {
      const bits: number[] = [];
      for (const i of seq) encodeWeathercode(bits, table, i);
      const out: number[] = [];
      let pos = 0;
      for (let k = 0; k < seq.length; k++) {
        const [sym, p] = decodeWeathercode(bits, pos, table);
        out.push(sym);
        pos = p;
      }
      expect(out).toEqual(seq);
      expect(pos).toBe(bits.length);
    }
  });

  it("picks the codebook that minimizes total bits", () => {
    // An all-clear column should be cheaper under the chosen table than under any other.
    const allClear = Array(64).fill(0); // index 0 = WMO clear
    const chosen = chooseWcTable(allClear);
    for (let t = 0; t < WC_TABLE_COUNT; t++) {
      expect(totalBits(allClear, chosen)).toBeLessThanOrEqual(totalBits(allClear, t));
    }
    // And it beats the near-uniform general table (0) for this skewed input.
    expect(totalBits(allClear, chosen)).toBeLessThan(totalBits(allClear, 0));
  });
});

function dirBits(idxs: number[], table: number): number {
  const bits: number[] = [];
  for (const i of idxs) encodeWindDir(bits, table, i);
  return bits.length;
}

describe("wind direction Huffman", () => {
  it("round-trips every direction under every codebook", () => {
    for (let table = 0; table < WIND_DIR_TABLE_COUNT; table++) {
      for (let dir = 0; dir < 8; dir++) {
        const bits: number[] = [];
        encodeWindDir(bits, table, dir);
        expect(bits.length).toBeGreaterThan(0);
        const [out, pos] = decodeWindDir(bits, 0, table);
        expect(out).toBe(dir);
        expect(pos).toBe(bits.length); // consumed exactly the code
      }
    }
  });

  it("decodes a concatenated direction sequence unambiguously (prefix-free)", () => {
    const seq = [6, 6, 7, 6, 0, 3, 4, 5, 6, 6, 1, 2, 6];
    for (let table = 0; table < WIND_DIR_TABLE_COUNT; table++) {
      const bits: number[] = [];
      for (const d of seq) encodeWindDir(bits, table, d);
      const out: number[] = [];
      let pos = 0;
      for (let k = 0; k < seq.length; k++) { const [sym, p] = decodeWindDir(bits, pos, table); out.push(sym); pos = p; }
      expect(out).toEqual(seq);
      expect(pos).toBe(bits.length);
    }
  });

  it("a peaked column costs fewer bits than a uniform spread, and beats raw 3-bit", () => {
    const peaked = Array(64).fill(6); // all from one direction (W)
    const spread = Array.from({ length: 64 }, (_, i) => i % 8);
    const chosen = chooseWindDirTable(peaked);
    for (let t = 0; t < WIND_DIR_TABLE_COUNT; t++) {
      expect(dirBits(peaked, chosen)).toBeLessThanOrEqual(dirBits(peaked, t));
    }
    expect(dirBits(peaked, chosen)).toBeLessThan(dirBits(spread, chooseWindDirTable(spread)));
    expect(dirBits(peaked, chosen)).toBeLessThan(peaked.length * 3); // beats raw 3 bits/value
  });
});

function tempBits(deltas: number[], table: number): number {
  const bits: number[] = [];
  for (const d of deltas) encodeTempDelta(bits, table, d);
  return bits.length;
}

describe("temperature delta Huffman", () => {
  it("round-trips every core delta (-7..7) under every codebook", () => {
    for (let table = 0; table < TEMP_DELTA_TABLE_COUNT; table++) {
      for (let d = -TEMP_DELTA_CORE_RADIUS; d <= TEMP_DELTA_CORE_RADIUS; d++) {
        const bits: number[] = [];
        encodeTempDelta(bits, table, d);
        expect(bits.length).toBeGreaterThan(0);
        const [out, pos] = decodeTempDelta(bits, 0, table);
        expect(out).toBe(d);
        expect(pos).toBe(bits.length); // consumed exactly the code, no more
      }
    }
  });

  it("round-trips escape-path deltas (|delta| > 7) via the raw 6-bit payload", () => {
    const jumps = [8, -8, 11, -11, 20, -20, 31, -32]; // -32..31 is the escape field's full range
    for (let table = 0; table < TEMP_DELTA_TABLE_COUNT; table++) {
      for (const d of jumps) {
        const bits: number[] = [];
        encodeTempDelta(bits, table, d);
        const [out, pos] = decodeTempDelta(bits, 0, table);
        expect(out).toBe(d);
        expect(pos).toBe(bits.length);
      }
    }
  });

  it("decodes a concatenated delta sequence unambiguously (prefix-free), mixing core and escape", () => {
    const seq = [0, 1, -1, 0, 2, -3, 9, 0, 1, -14, 0, 0];
    for (let table = 0; table < TEMP_DELTA_TABLE_COUNT; table++) {
      const bits: number[] = [];
      for (const d of seq) encodeTempDelta(bits, table, d);
      const out: number[] = [];
      let pos = 0;
      for (let k = 0; k < seq.length; k++) { const [d, p] = decodeTempDelta(bits, pos, table); out.push(d); pos = p; }
      expect(out).toEqual(seq);
      expect(pos).toBe(bits.length);
    }
  });

  it("a near-constant column costs fewer bits than a wide-swinging one, and beats raw 8-bit", () => {
    const flat = Array(64).fill(0);
    const swings = Array.from({ length: 64 }, (_, i) => (i % 2 === 0 ? 5 : -5));
    const chosen = chooseTempDeltaTable(flat);
    for (let t = 0; t < TEMP_DELTA_TABLE_COUNT; t++) {
      expect(tempBits(flat, chosen)).toBeLessThanOrEqual(tempBits(flat, t));
    }
    expect(tempBits(flat, chosen)).toBeLessThan(tempBits(swings, chooseTempDeltaTable(swings)));
    expect(tempBits(flat, chosen)).toBeLessThan(flat.length * 8); // beats raw 8 bits/value
  });
});
