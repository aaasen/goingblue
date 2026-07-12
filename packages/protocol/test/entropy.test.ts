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
  type SymSink,
  encodeTempDelta,
  decodeTempDelta,
  chooseTempDeltaTable,
  TEMP_DELTA_TABLE_COUNT,
  TEMP_DELTA_CORE_RADIUS,
  TEMP_DELTA_MIN,
  TEMP_DELTA_MAX,
  makeBitSink,
  makeBitSource,
} from "../src/index.js";

// Encode via `fn`, then return a source over the produced stream. Callers decode from it and
// finish with assertDone() to prove the exact stream was consumed.
function encoded(fn: (sink: SymSink) => void): { cost: number; source: ReturnType<typeof makeBitSource> } {
  const sink = makeBitSink();
  fn(sink);
  return { cost: sink.cost, source: makeBitSource(sink.bits) };
}

// Model cost (in bits) of encoding a whole sequence through `fn`.
function costOf(fn: (sink: SymSink) => void): number {
  const sink = makeBitSink();
  fn(sink);
  return sink.cost;
}

// All contexts a weathercode symbol can be keyed by: no predecessor (bootstrap), or any WMO index.
const WC_CONTEXTS: (number | null)[] = [null, ...WMO_CODES.map((_, i) => i)];

describe("weathercode entropy coding", () => {
  it("round-trips every WMO index under every context", () => {
    for (const prevSym of WC_CONTEXTS) {
      for (let idx = 0; idx < WMO_CODES.length; idx++) {
        const { cost, source } = encoded((sink) => encodeWeathercode(sink, prevSym, idx));
        expect(cost).toBeGreaterThan(0);
        expect(decodeWeathercode(source, prevSym)).toBe(idx);
        source.assertDone(); // consumed exactly the coded symbol, no more
      }
    }
  });

  it("decodes a concatenated sequence unambiguously, context threaded from the previous symbol", () => {
    const seq = [0, 3, 3, 16, 17, 25, 11, 2, 0, 0, 27, 8, 20];
    const { source } = encoded((sink) => {
      let prev: number | null = null;
      for (const idx of seq) { encodeWeathercode(sink, prev, idx); prev = idx; }
    });
    let prev: number | null = null;
    const out: number[] = [];
    for (let k = 0; k < seq.length; k++) {
      const sym = decodeWeathercode(source, prev);
      out.push(sym);
      prev = sym;
    }
    expect(out).toEqual(seq);
    source.assertDone();
  });

  it("a persistent (all-clear) sequence costs fewer bits under order-1 context than under the bootstrap table alone", () => {
    const allClear = Array(64).fill(0); // index 0 = WMO clear
    const contextual = costOf((sink) => {
      let prev: number | null = null;
      for (const idx of allClear) { encodeWeathercode(sink, prev, idx); prev = idx; }
    });
    const bootstrapOnly = costOf((sink) => {
      for (const idx of allClear) encodeWeathercode(sink, null, idx);
    });
    expect(contextual).toBeLessThan(bootstrapOnly);
  });
});

// All contexts a direction symbol can be keyed by: no predecessor (bootstrap), or any of 0..7.
const DIR_CONTEXTS: (number | null)[] = [null, 0, 1, 2, 3, 4, 5, 6, 7];

describe("wind direction entropy coding", () => {
  it("round-trips every direction under every context", () => {
    for (const prevDir of DIR_CONTEXTS) {
      for (let dir = 0; dir < 8; dir++) {
        const { cost, source } = encoded((sink) => encodeWindDir(sink, prevDir, dir));
        expect(cost).toBeGreaterThan(0);
        expect(decodeWindDir(source, prevDir)).toBe(dir);
        source.assertDone(); // consumed exactly the coded symbol
      }
    }
  });

  it("decodes a concatenated direction sequence unambiguously, context threaded from the previous direction", () => {
    const seq = [6, 6, 7, 6, 0, 3, 4, 5, 6, 6, 1, 2, 6];
    const { source } = encoded((sink) => {
      let prev: number | null = null;
      for (const d of seq) { encodeWindDir(sink, prev, d); prev = d; }
    });
    let prev: number | null = null;
    const out: number[] = [];
    for (let k = 0; k < seq.length; k++) {
      const sym = decodeWindDir(source, prev);
      out.push(sym);
      prev = sym;
    }
    expect(out).toEqual(seq);
    source.assertDone();
  });

  it("a persistent (all-W) sequence costs fewer bits under order-1 context than under the bootstrap table alone, and beats raw 3-bit", () => {
    const allW = Array(64).fill(6); // direction index 6 = W
    const contextual = costOf((sink) => {
      let prev: number | null = null;
      for (const d of allW) { encodeWindDir(sink, prev, d); prev = d; }
    });
    const bootstrapOnly = costOf((sink) => {
      for (const d of allW) encodeWindDir(sink, null, d);
    });
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

describe.each(DELTA_CODECS)("$label delta entropy coding", ({ codec, maxDelta, rawBits }) => {
  const bitsFor = (deltas: number[]): number =>
    costOf((sink) => { for (const d of deltas) codec.encode(sink, d); });

  it(`round-trips every delta in the bounded range (-${maxDelta}..${maxDelta})`, () => {
    for (let d = -maxDelta; d <= maxDelta; d++) {
      const { cost, source } = encoded((sink) => codec.encode(sink, d));
      expect(cost).toBeGreaterThan(0);
      expect(codec.decode(source)).toBe(d);
      source.assertDone(); // consumed exactly the coded symbol, no more
    }
  });

  it("decodes a concatenated delta sequence unambiguously", () => {
    const seq = [0, 1, -1, 0, 2, -3, 0, 1, -2, 0, 0];
    const { source } = encoded((sink) => { for (const d of seq) codec.encode(sink, d); });
    const out: number[] = [];
    for (let k = 0; k < seq.length; k++) out.push(codec.decode(source));
    expect(out).toEqual(seq);
    source.assertDone();
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
  return costOf((sink) => { for (const d of deltas) encodeTempDelta(sink, table, d); });
}

describe("temperature delta entropy coding", () => {
  it("round-trips every core delta (-7..7) under every codebook", () => {
    for (let table = 0; table < TEMP_DELTA_TABLE_COUNT; table++) {
      for (let d = -TEMP_DELTA_CORE_RADIUS; d <= TEMP_DELTA_CORE_RADIUS; d++) {
        const { cost, source } = encoded((sink) => encodeTempDelta(sink, table, d));
        expect(cost).toBeGreaterThan(0);
        expect(decodeTempDelta(source, table)).toBe(d);
        source.assertDone(); // consumed exactly the coded symbol, no more
      }
    }
  });

  it("round-trips escape-path deltas (|delta| > 7) via the raw 6-bit payload, including the exact field bounds", () => {
    const jumps = [8, -8, 11, -11, 20, -20, 31, -32, TEMP_DELTA_MAX, TEMP_DELTA_MIN];
    for (let table = 0; table < TEMP_DELTA_TABLE_COUNT; table++) {
      for (const d of jumps) {
        const { source } = encoded((sink) => encodeTempDelta(sink, table, d));
        expect(decodeTempDelta(source, table)).toBe(d);
        source.assertDone();
      }
    }
  });

  it("throws on deltas outside the escape field's range instead of silently truncating", () => {
    // An unchecked encode of e.g. +40 would silently wrap in the 6-bit escape field and corrupt
    // every later temperature in the chain. The guard makes that impossible to emit;
    // v1.ts clamps before calling (see the healing round-trip test in encoding.test.ts).
    for (const d of [TEMP_DELTA_MAX + 1, TEMP_DELTA_MIN - 1, 40, -40, 100]) {
      expect(() => encodeTempDelta(makeBitSink(), 0, d)).toThrow(/temp delta/);
    }
  });

  it("decodes a concatenated delta sequence unambiguously, mixing core and escape", () => {
    const seq = [0, 1, -1, 0, 2, -3, 9, 0, 1, -14, 0, 0];
    for (let table = 0; table < TEMP_DELTA_TABLE_COUNT; table++) {
      const { source } = encoded((sink) => { for (const d of seq) encodeTempDelta(sink, table, d); });
      const out: number[] = [];
      for (let k = 0; k < seq.length; k++) out.push(decodeTempDelta(source, table));
      expect(out).toEqual(seq);
      source.assertDone();
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
