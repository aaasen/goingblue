import { describe, it, expect } from "vitest";
import {
  encodeWeathercode,
  decodeWeathercode,
  WMO_CODES,
  encodeWindDir,
  decodeWindDir,
  WIND_SPEED_DELTA,
  FREEZE_DELTA,
  CLOUD_LOW_DELTA,
  CLOUD_MID_DELTA,
  CLOUD_HIGH_DELTA,
  type DeltaCodec,
  encodeTempDelta,
  decodeTempDelta,
  chooseTempDeltaTable,
  TEMP_DELTA_TABLE_COUNT,
  TEMP_DELTA_CORE_RADIUS,
  TEMP_DELTA_MIN,
  TEMP_DELTA_MAX,
} from "../src/index.js";

// All contexts a weathercode symbol can be keyed by: no predecessor (bootstrap), or any WMO index.
const WC_CONTEXTS: (number | null)[] = [null, ...WMO_CODES.map((_, i) => i)];

function sequenceBits(seq: number[]): number {
  const bits: number[] = [];
  let prev: number | null = null;
  for (const idx of seq) { encodeWeathercode(bits, prev, idx); prev = idx; }
  return bits.length;
}

describe("weathercode Huffman", () => {
  it("round-trips every WMO index under every context", () => {
    for (const prevSym of WC_CONTEXTS) {
      for (let idx = 0; idx < WMO_CODES.length; idx++) {
        const bits: number[] = [];
        encodeWeathercode(bits, prevSym, idx);
        expect(bits.length).toBeGreaterThan(0);
        const [out, pos] = decodeWeathercode(bits, 0, prevSym);
        expect(out).toBe(idx);
        expect(pos).toBe(bits.length); // consumed exactly the code, no more
      }
    }
  });

  it("decodes a concatenated sequence unambiguously (prefix-free), context threaded from the previous symbol", () => {
    const seq = [0, 3, 3, 16, 17, 25, 11, 2, 0, 0, 27, 8, 20];
    const bits: number[] = [];
    let prev: number | null = null;
    for (const idx of seq) { encodeWeathercode(bits, prev, idx); prev = idx; }

    const out: number[] = [];
    let pos = 0;
    prev = null;
    for (let k = 0; k < seq.length; k++) {
      const [sym, p] = decodeWeathercode(bits, pos, prev);
      out.push(sym);
      pos = p;
      prev = sym;
    }
    expect(out).toEqual(seq);
    expect(pos).toBe(bits.length);
  });

  it("a persistent (all-clear) sequence costs fewer bits under order-1 context than under the bootstrap table alone", () => {
    const allClear = Array(64).fill(0); // index 0 = WMO clear
    const contextual = sequenceBits(allClear);
    const bootstrapOnly = allClear.reduce((bits, idx) => {
      const b: number[] = []; encodeWeathercode(b, null, idx); return bits + b.length;
    }, 0);
    expect(contextual).toBeLessThan(bootstrapOnly);
  });
});

// All contexts a direction symbol can be keyed by: no predecessor (bootstrap), or any of 0..7.
const DIR_CONTEXTS: (number | null)[] = [null, 0, 1, 2, 3, 4, 5, 6, 7];

function dirSequenceBits(seq: number[]): number {
  const bits: number[] = [];
  let prev: number | null = null;
  for (const d of seq) { encodeWindDir(bits, prev, d); prev = d; }
  return bits.length;
}

describe("wind direction Huffman", () => {
  it("round-trips every direction under every context", () => {
    for (const prevDir of DIR_CONTEXTS) {
      for (let dir = 0; dir < 8; dir++) {
        const bits: number[] = [];
        encodeWindDir(bits, prevDir, dir);
        expect(bits.length).toBeGreaterThan(0);
        const [out, pos] = decodeWindDir(bits, 0, prevDir);
        expect(out).toBe(dir);
        expect(pos).toBe(bits.length); // consumed exactly the code
      }
    }
  });

  it("decodes a concatenated direction sequence unambiguously (prefix-free), context threaded from the previous direction", () => {
    const seq = [6, 6, 7, 6, 0, 3, 4, 5, 6, 6, 1, 2, 6];
    const bits: number[] = [];
    let prev: number | null = null;
    for (const d of seq) { encodeWindDir(bits, prev, d); prev = d; }

    const out: number[] = [];
    let pos = 0;
    prev = null;
    for (let k = 0; k < seq.length; k++) {
      const [sym, p] = decodeWindDir(bits, pos, prev);
      out.push(sym);
      pos = p;
      prev = sym;
    }
    expect(out).toEqual(seq);
    expect(pos).toBe(bits.length);
  });

  it("a persistent (all-W) sequence costs fewer bits under order-1 context than under the bootstrap table alone, and beats raw 3-bit", () => {
    const allW = Array(64).fill(6); // direction index 6 = W
    const contextual = dirSequenceBits(allW);
    const bootstrapOnly = allW.reduce((bits, d) => {
      const b: number[] = []; encodeWindDir(b, null, d); return bits + b.length;
    }, 0);
    expect(contextual).toBeLessThan(bootstrapOnly);
    expect(contextual).toBeLessThan(allW.length * 3); // beats raw 3 bits/value
  });
});

// Wind speed, freezing level, and the three cloud levels all use single-table bounded delta
// codecs from makeDeltaCodec — same shape, different weights/range. Table-driven so all five get
// the same coverage without quintupling the test body.
const DELTA_CODECS: { label: string; codec: DeltaCodec; maxDelta: number; rawBits: number }[] = [
  { label: "wind speed", codec: WIND_SPEED_DELTA, maxDelta: 15, rawBits: 4 },
  { label: "freezing level", codec: FREEZE_DELTA, maxDelta: 15, rawBits: 4 },
  { label: "cloud low", codec: CLOUD_LOW_DELTA, maxDelta: 7, rawBits: 3 },
  { label: "cloud mid", codec: CLOUD_MID_DELTA, maxDelta: 7, rawBits: 3 },
  { label: "cloud high", codec: CLOUD_HIGH_DELTA, maxDelta: 7, rawBits: 3 },
];

describe.each(DELTA_CODECS)("$label delta Huffman", ({ codec, maxDelta, rawBits }) => {
  const bitsFor = (deltas: number[]): number => {
    const bits: number[] = [];
    for (const d of deltas) codec.encode(bits, d);
    return bits.length;
  };

  it(`round-trips every delta in the bounded range (-${maxDelta}..${maxDelta})`, () => {
    for (let d = -maxDelta; d <= maxDelta; d++) {
      const bits: number[] = [];
      codec.encode(bits, d);
      expect(bits.length).toBeGreaterThan(0);
      const [out, pos] = codec.decode(bits, 0);
      expect(out).toBe(d);
      expect(pos).toBe(bits.length); // consumed exactly the code, no more
    }
  });

  it("decodes a concatenated delta sequence unambiguously (prefix-free)", () => {
    const seq = [0, 1, -1, 0, 2, -3, 0, 1, -2, 0, 0];
    const bits: number[] = [];
    for (const d of seq) codec.encode(bits, d);
    const out: number[] = [];
    let pos = 0;
    for (let k = 0; k < seq.length; k++) { const [d, p] = codec.decode(bits, pos); out.push(d); pos = p; }
    expect(out).toEqual(seq);
    expect(pos).toBe(bits.length);
  });

  it(`a near-constant column costs fewer bits than a wide-swinging one, and beats raw ${rawBits}-bit`, () => {
    const flat = Array(64).fill(0);
    const swing = Math.min(5, maxDelta);
    const swings = Array.from({ length: 64 }, (_, i) => (i % 2 === 0 ? swing : -swing));
    expect(bitsFor(flat)).toBeLessThan(bitsFor(swings));
    expect(bitsFor(flat)).toBeLessThan(flat.length * rawBits);
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

  it("round-trips escape-path deltas (|delta| > 7) via the raw 6-bit payload, including the exact field bounds", () => {
    const jumps = [8, -8, 11, -11, 20, -20, 31, -32, TEMP_DELTA_MAX, TEMP_DELTA_MIN];
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

  it("throws on deltas outside the escape field's range instead of silently truncating", () => {
    // putInt masks to the field width, so an unchecked encode of e.g. +40 would decode as -24 and
    // corrupt every later temperature in the chain. The guard makes that impossible to emit;
    // v1.ts clamps before calling (see the healing round-trip test in encoding.test.ts).
    for (const d of [TEMP_DELTA_MAX + 1, TEMP_DELTA_MIN - 1, 40, -40, 100]) {
      expect(() => encodeTempDelta([], 0, d)).toThrow(/temp delta/);
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
