import { describe, it, expect } from "vitest";
import {
  quantizeFreqs, buildRansTable, symCostBits, ransEncode, ransReader,
  RANS_M, RANS_L, type RansOp, type RansTable,
} from "../src/rans.js";
import { encodeBodyLE, decodeBodyLE } from "../src/codec.js";

// Deterministic PRNG so failures reproduce.
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function randomTable(rand: () => number, n: number): RansTable {
  return buildRansTable(Array.from({ length: n }, () => 1 + Math.floor(rand() * 1000)));
}

// Encode ops, decode them back in the same order, and assert every value round-trips and the
// stream ends in sync. Returns the serialized bit length.
function roundTrip(ops: RansOp[]): number {
  const bits = ransEncode(ops);
  const rd = ransReader(bits);
  for (const op of ops) {
    if ("table" in op) expect(rd.sym(op.table)).toBe(op.sym);
    else expect(rd.raw(op.width)).toBe(op.raw);
  }
  rd.assertDone();
  return bits.length;
}

describe("quantizeFreqs", () => {
  it("sums to M with every frequency >= 1, across shapes", () => {
    const shapes = [
      [1, 1],
      [1000000, 1], // extreme skew: rare symbol must keep f >= 1
      Array(31).fill(7), // uniform, n not a power of two
      [804, 11, 5, 6, 10, 13, 18, 35, 36, 18, 12, 9, 6, 5, 12], // real cloud-delta shape
      Array.from({ length: 28 }, (_, i) => (i === 0 ? 999999 : 1)), // weathercode-like
    ];
    for (const w of shapes) {
      const f = quantizeFreqs(w);
      expect(f.reduce((a, b) => a + b, 0)).toBe(RANS_M);
      expect(Math.min(...f)).toBeGreaterThanOrEqual(1);
      expect(f.length).toBe(w.length);
    }
  });

  it("preserves proportions closely for a dominant symbol", () => {
    const f = quantizeFreqs([90, 5, 5]);
    expect(f[0] / RANS_M).toBeCloseTo(0.9, 2);
  });

  it("is deterministic", () => {
    const w = [3, 1, 4, 1, 5, 9, 2, 6];
    expect(quantizeFreqs(w)).toEqual(quantizeFreqs(w));
  });

  it("rejects non-positive weights and oversized alphabets", () => {
    expect(() => quantizeFreqs([1, 0, 2])).toThrow(/positive/);
    expect(() => quantizeFreqs([])).toThrow(/symbols/);
    expect(() => quantizeFreqs(Array(RANS_M + 1).fill(1))).toThrow(/symbols/);
  });
});

describe("rANS round-trips", () => {
  it("round-trips every symbol of a table, including f=1 outliers", () => {
    const table = buildRansTable([1000000, 1, 1, 500, 1, 20000, 1, 1]);
    const ops: RansOp[] = [];
    for (let s = 0; s < 8; s++) for (let k = 0; k < 3; k++) ops.push({ table, sym: s });
    roundTrip(ops);
  });

  it("round-trips random mixed symbol/raw sequences under many random tables", () => {
    const rand = mulberry32(42);
    for (let trial = 0; trial < 50; trial++) {
      const tables = Array.from({ length: 4 }, () => randomTable(rand, 2 + Math.floor(rand() * 30)));
      const ops: RansOp[] = [];
      const len = 1 + Math.floor(rand() * 400);
      for (let i = 0; i < len; i++) {
        if (rand() < 0.3) {
          const width = 1 + Math.floor(rand() * 16);
          ops.push({ raw: Math.floor(rand() * 2 ** width), width });
        } else {
          const table = tables[Math.floor(rand() * tables.length)];
          ops.push({ table, sym: Math.floor(rand() * (table.freq.length)) });
        }
      }
      roundTrip(ops);
    }
  });

  it("round-trips a long run of a rare (f=1) symbol", () => {
    const table = buildRansTable([100000, 1]);
    roundTrip(Array.from({ length: 200 }, () => ({ table, sym: 1 })));
  });

  it("round-trips a long peaked sequence (many renormalizations)", () => {
    const rand = mulberry32(7);
    const table = buildRansTable([9000, 400, 400, 100, 100]);
    const ops: RansOp[] = Array.from({ length: 10000 }, () => ({
      table,
      sym: rand() < 0.9 ? 0 : 1 + Math.floor(rand() * 4),
    }));
    roundTrip(ops);
  });

  it("round-trips an empty op list", () => {
    roundTrip([]);
  });

  it("round-trips raw widths 1..16 and treats width 0 as a no-op", () => {
    const ops: RansOp[] = [];
    for (let w = 1; w <= 16; w++) ops.push({ raw: 2 ** w - 1, width: w }, { raw: 0, width: w });
    ops.push({ raw: 0, width: 0 });
    roundTrip(ops);
  });

  it("is deterministic", () => {
    const table = buildRansTable([5, 3, 2]);
    const ops: RansOp[] = [
      { table, sym: 0 }, { raw: 5, width: 3 }, { table, sym: 2 }, { table, sym: 1 },
    ];
    expect(ransEncode(ops)).toEqual(ransEncode(ops));
  });
});

describe("rANS stream properties", () => {
  it("costs match the model: serialized size ≈ Σ symCostBits + flush overhead", () => {
    const rand = mulberry32(99);
    const table = buildRansTable([8000, 2000, 500, 200, 50]);
    for (const len of [50, 500, 5000]) {
      const ops: RansOp[] = [];
      let modelBits = 0;
      for (let i = 0; i < len; i++) {
        // Sample from the table's own distribution so cost ≈ entropy.
        const r = rand() * RANS_M;
        let s = 0;
        while (table.cum[s + 1] <= r) s++;
        ops.push({ table, sym: s });
        modelBits += symCostBits(table, s);
      }
      const total = ransEncode(ops).length;
      // Flush costs ~16 bits (the seed state) plus ≤16 bits of word-granularity slack, on top
      // of the 32-bit serialized state that itself carries ~16 bits of content.
      expect(total).toBeGreaterThanOrEqual(modelBits - 1);
      expect(total).toBeLessThanOrEqual(modelBits + 64);
    }
  });

  it("beats per-symbol whole-bit coding on a peaked distribution", () => {
    // P(0) ≈ 0.95: entropy ≈ 0.29 b/sym. Huffman would pay ≥ 1 bit each; rANS must land well
    // under that for an all-zero run drawn from the model.
    const table = buildRansTable([9500, 250, 250]);
    const n = 1000;
    const bits = ransEncode(Array.from({ length: n }, () => ({ table, sym: 0 })));
    expect(bits.length).toBeLessThan(n * 0.5);
  });

  it("survives body serialization's trailing-zero drop", () => {
    // encodeBodyLE drops high-order zero bits — i.e. trailing zero renorm words. The reader must
    // reproduce them via reads-past-end. Exercise many random streams through the real body codec.
    const rand = mulberry32(1234);
    for (let trial = 0; trial < 30; trial++) {
      const table = randomTable(rand, 2 + Math.floor(rand() * 20));
      const ops: RansOp[] = Array.from({ length: 1 + Math.floor(rand() * 300) }, () => ({
        table,
        sym: Math.floor(rand() * table.freq.length),
      }));
      const bits = ransEncode(ops);
      const rehydrated = decodeBodyLE(encodeBodyLE(bits));
      expect(rehydrated.length).toBeLessThanOrEqual(bits.length); // the drop actually happens
      const rd = ransReader(rehydrated);
      for (const op of ops) expect(rd.sym((op as { table: RansTable }).table)).toBe((op as { table: RansTable; sym: number }).sym);
      rd.assertDone();
    }
  });

  it("assertDone throws on a corrupted stream", () => {
    const table = buildRansTable([100, 50, 25, 25]);
    const ops: RansOp[] = Array.from({ length: 64 }, (_, i) => ({ table, sym: i % 4 }));
    const bits = ransEncode(ops);
    let caught = 0;
    for (const flip of [3, 40, bits.length - 5]) {
      const bad = [...bits];
      bad[flip] ^= 1;
      const rd = ransReader(bad);
      try {
        for (let i = 0; i < ops.length; i++) rd.sym(table);
        rd.assertDone();
      } catch {
        caught++;
      }
    }
    expect(caught).toBe(3);
  });

  it("assertDone throws when ops are consumed under the wrong table (codebook drift)", () => {
    const a = buildRansTable([900, 50, 25, 25]);
    const b = buildRansTable([25, 25, 50, 900]);
    const ops: RansOp[] = Array.from({ length: 64 }, (_, i) => ({ table: a, sym: i % 4 }));
    const bits = ransEncode(ops);
    const rd = ransReader(bits);
    expect(() => {
      for (let i = 0; i < ops.length; i++) rd.sym(b);
      rd.assertDone();
    }).toThrow(/desynced/);
  });

  it("rejects out-of-range raw values instead of silently corrupting the stream", () => {
    expect(() => ransEncode([{ raw: 8, width: 3 }])).toThrow(/outside 3 bits/);
    expect(() => ransEncode([{ raw: -1, width: 3 }])).toThrow(/outside 3 bits/);
    expect(() => ransEncode([{ raw: 1.5, width: 3 }])).toThrow(/outside 3 bits/);
    expect(() => ransEncode([{ raw: 0, width: 17 }])).toThrow(/exceeds 16/);
  });
});
