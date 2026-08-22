import { describe, it, expect } from "vitest";
import {
  encodeWeathercode,
  decodeWeathercode,
  WMO_CODES,
  windDirBook,
  windSpeedBook,
  encodeWindSpeedDelta,
  decodeWindSpeedDelta,
  WIND_SPEED_DELTA_MAX,
  upperDeltaBucket,
  freezeDeltaBook,
  encodeFreezeDelta,
  decodeFreezeDelta,
  FREEZE_DELTA_MAX,
  cloudBandBook,
  CLOUD_BAND_LEVELS_HPA,
  type SymSink,
  encodeTempDelta,
  decodeTempDelta,
  tempDeltaBook,
  TEMP_DELTA_TOD_BUCKETS,
  TEMP_DELTA_CORE_RADIUS,
  TEMP_DELTA_MIN,
  TEMP_DELTA_MAX,
  type CodeBook,
  makeBitSink,
  WIND_LEVELS_HPA,
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

describe("wind direction entropy coding", () => {
  it("round-trips every direction under every (resolution, prev, upper) context", () => {
    for (let res = 0; res <= 3; res++) {
      for (const prev of [null, 0, 1, 2, 3, 4, 5, 6, 7]) {
        for (const upper of [null, 0, 3, 7]) {
          for (let dir = 0; dir < 8; dir++) {
            const book = windDirBook(res, prev, upper, 1);
            const { cost, source } = encoded((sink) => sink.sym(book, dir));
            expect(cost).toBeGreaterThan(0);
            expect(source.sym(book)).toBe(dir);
            source.assertDone(); // consumed exactly the coded symbol
          }
        }
      }
    }
  });

  it("decodes a concatenated direction sequence unambiguously, context threaded from the previous direction", () => {
    const seq = [6, 6, 7, 6, 0, 3, 4, 5, 6, 6, 1, 2, 6];
    const uppers = seq.map((_, i) => (i % 3 === 0 ? null : (i * 5) % 8)); // mix of with/without upper
    const { source } = encoded((sink) => {
      let prev: number | null = null;
      seq.forEach((d, i) => { sink.sym(windDirBook(2, prev, uppers[i], 1), d); prev = d; });
    });
    let prev: number | null = null;
    const out: number[] = [];
    for (let k = 0; k < seq.length; k++) {
      const sym = source.sym(windDirBook(2, prev, uppers[k], 1));
      out.push(sym);
      prev = sym;
    }
    expect(out).toEqual(seq);
    source.assertDone();
  });

  const seqCost = (dirs: number[], res: number, upper: (i: number) => number | null, bootstrapOnly = false) =>
    costOf((sink) => {
      let prev: number | null = null;
      dirs.forEach((d, i) => {
        sink.sym(windDirBook(res, bootstrapOnly ? null : prev, bootstrapOnly ? null : upper(i), 1), d);
        prev = d;
      });
    });

  it("a persistent (all-W) sequence costs fewer bits under order-1 context than under the bootstrap table alone, and beats raw 3-bit", () => {
    const allW = Array(64).fill(6); // direction index 6 = W
    const contextual = seqCost(allW, 3, () => null);
    const bootstrapOnly = seqCost(allW, 3, () => null, true);
    expect(contextual).toBeLessThan(bootstrapOnly);
    expect(contextual).toBeLessThan(allW.length * 3); // beats raw 3 bits/value
  });

  it("persistence is cheaper at 1h than at 6h (resolution-keyed tables)", () => {
    const allW = Array(64).fill(6);
    expect(seqCost(allW, 3, () => null)).toBeLessThan(seqCost(allW, 1, () => null));
  });

  it("an agreeing upper level makes a persistent sequence cheaper (cross-level context)", () => {
    const allW = Array(64).fill(6);
    expect(seqCost(allW, 2, () => 6)).toBeLessThan(seqCost(allW, 2, () => null));
  });
});

describe("wind speed delta entropy coding", () => {
  const allBooks = () => {
    const books = [];
    for (let res = 0; res <= 3; res++) {
      // Level axis: surface, then every WIND_LEVELS_HPA rung; the upper-conditioned books are
      // keyed by bucket × ladder gap class (1, 2, 3+).
      for (let level = 0; level <= WIND_LEVELS_HPA.length; level++) books.push(windSpeedBook(res, level, null, 0));
      for (const upperDelta of [-5, -1, 0, 1, 5]) {
        for (const gap of [1, 2, 3, 7]) books.push(windSpeedBook(res, 0, upperDelta, gap));
      }
    }
    return books;
  };

  it(`round-trips every delta (-${WIND_SPEED_DELTA_MAX}..${WIND_SPEED_DELTA_MAX}) under every (resolution, level, upper-bucket) book`, () => {
    for (const book of allBooks()) {
      for (let d = -WIND_SPEED_DELTA_MAX; d <= WIND_SPEED_DELTA_MAX; d++) {
        const { cost, source } = encoded((sink) => encodeWindSpeedDelta(sink, book, d));
        expect(cost).toBeGreaterThan(0);
        expect(decodeWindSpeedDelta(source, book)).toBe(d);
        source.assertDone();
      }
    }
  });

  it("decodes a concatenated delta sequence unambiguously", () => {
    const seq = [0, 1, -1, 0, 2, -3, 17, 0, 1, -17, 0, 0];
    const book = windSpeedBook(3, 1, null, 0);
    const { source } = encoded((sink) => { for (const d of seq) encodeWindSpeedDelta(sink, book, d); });
    const out: number[] = [];
    for (let k = 0; k < seq.length; k++) out.push(decodeWindSpeedDelta(source, book));
    expect(out).toEqual(seq);
    source.assertDone();
  });

  it("buckets upper deltas as ≤-2, -1, 0, +1, ≥+2", () => {
    expect([-31, -2, -1, 0, 1, 2, 31].map(upperDeltaBucket)).toEqual([0, 0, 1, 2, 3, 4, 4]);
  });

  const bitsFor = (deltas: number[], book = windSpeedBook(3, 0, null, 0)) =>
    costOf((sink) => { for (const d of deltas) encodeWindSpeedDelta(sink, book, d); });

  it("a near-constant column costs fewer bits than a wide-swinging one, and beats raw 5-bit", () => {
    const flat = Array(64).fill(0);
    const swings = Array.from({ length: 64 }, (_, i) => (i % 2 === 0 ? 5 : -5));
    expect(bitsFor(flat)).toBeLessThan(bitsFor(swings));
    expect(bitsFor(flat)).toBeLessThan(flat.length * 5); // beats raw 5 bits/value
  });

  it("a matching upper-level delta makes the same delta cheaper (cross-level context)", () => {
    const rising = Array(64).fill(2);
    expect(bitsFor(rising, windSpeedBook(2, 2, 2, 1))).toBeLessThan(bitsFor(rising, windSpeedBook(2, 2, null, 0)));
    // A level further down the ladder still helps, under its own gap class.
    expect(bitsFor(rising, windSpeedBook(2, 2, 2, 3))).toBeLessThan(bitsFor(rising, windSpeedBook(2, 2, null, 0)));
  });
});

describe("freezing level delta entropy coding", () => {
  // Every distinct freeze codebook: per resolution, the res-keyed fallback (temp absent) plus one
  // table per temp-delta bucket, reached through the same freezeDeltaBook the wire uses. One
  // representative same-period temp delta per bucket: ≤-2 | -1 | 0 | +1 | ≥+2.
  const allBooks = () => {
    const books = [];
    for (let res = 0; res <= 3; res++) {
      for (const tempDelta of [null, -5, -1, 0, 1, 5]) books.push(freezeDeltaBook(res, tempDelta));
    }
    return books;
  };

  it(`round-trips every delta (-${FREEZE_DELTA_MAX}..${FREEZE_DELTA_MAX}) under every (resolution, tempΔ-bucket) book`, () => {
    for (const book of allBooks()) {
      for (let d = -FREEZE_DELTA_MAX; d <= FREEZE_DELTA_MAX; d++) {
        const { cost, source } = encoded((sink) => encodeFreezeDelta(sink, book, d));
        expect(cost).toBeGreaterThan(0);
        expect(decodeFreezeDelta(source, book)).toBe(d);
        source.assertDone();
      }
    }
  });

  it("decodes a concatenated delta sequence unambiguously", () => {
    const seq = [0, 1, -1, 0, 2, -3, 17, 0, 1, -25, 0, 0];
    const book = freezeDeltaBook(3, 0);
    const { source } = encoded((sink) => { for (const d of seq) encodeFreezeDelta(sink, book, d); });
    const out: number[] = [];
    for (let k = 0; k < seq.length; k++) out.push(decodeFreezeDelta(source, book));
    expect(out).toEqual(seq);
    source.assertDone();
  });

  const bitsFor = (deltas: number[], book = freezeDeltaBook(3, null)) =>
    costOf((sink) => { for (const d of deltas) encodeFreezeDelta(sink, book, d); });

  it("a near-constant column costs fewer bits than a wide-swinging one, and beats raw 5-bit", () => {
    const flat = Array(64).fill(0);
    const swings = Array.from({ length: 64 }, (_, i) => (i % 2 === 0 ? 5 : -5));
    expect(bitsFor(flat)).toBeLessThan(bitsFor(swings));
    expect(bitsFor(flat)).toBeLessThan(flat.length * 5); // beats raw 5 bits/value
  });

  it("a warming period makes a rising freezing level cheaper than the no-temp fallback (cross-variable context)", () => {
    const rising = Array(64).fill(1);
    expect(bitsFor(rising, freezeDeltaBook(2, 3))).toBeLessThan(bitsFor(rising, freezeDeltaBook(2, null)));
  });
});

// The cloud band's order-1 value books: one per (level, previous step), reached through the
// same cloudBandBook the wire uses. Table-driven so every level gets the same coverage without
// eight copies of the test body.
describe.each(CLOUD_BAND_LEVELS_HPA.map((hpa, li) => ({ hpa, li })))(
  "cloud band $hpa hPa entropy coding", ({ li }) => {
    // Cost of a value column with the context threaded the way v3.ts threads it: each step's
    // book keyed by the previous decoded step.
    const bitsFor = (steps: number[], first: number): number =>
      costOf((sink) => {
        let prev = first;
        for (const s of steps) { sink.sym(cloudBandBook(li, prev), s); prev = s; }
      });

    it("round-trips every step under every previous-step context", () => {
      for (let prev = 0; prev < 8; prev++) {
        for (let s = 0; s < 8; s++) {
          const { cost, source } = encoded((sink) => sink.sym(cloudBandBook(li, prev), s));
          expect(cost).toBeGreaterThan(0);
          expect(source.sym(cloudBandBook(li, prev))).toBe(s);
          source.assertDone(); // consumed exactly the coded symbol, no more
        }
      }
    });

    it("decodes a concatenated column unambiguously, context threaded like the wire", () => {
      const seq = [0, 1, 0, 0, 2, 7, 7, 5, 0, 0, 3];
      const { source } = encoded((sink) => {
        let prev = 0;
        for (const s of seq) { sink.sym(cloudBandBook(li, prev), s); prev = s; }
      });
      const out: number[] = [];
      let prev = 0;
      for (let k = 0; k < seq.length; k++) { out.push(source.sym(cloudBandBook(li, prev))); prev = out[k]; }
      expect(out).toEqual(seq);
      source.assertDone();
    });

    it("a persistent column costs fewer bits than a flickering one, and beats raw 3-bit", () => {
      const clear = Array(64).fill(0);
      const flicker = Array.from({ length: 64 }, (_, i) => (i % 2 === 0 ? 0 : 7));
      expect(bitsFor(clear, 0)).toBeLessThan(bitsFor(flicker, 0));
      expect(bitsFor(clear, 0)).toBeLessThan(clear.length * 3);
    });
  });

// Every distinct temp codebook: the bootstrap plus one (res × tod × prevΔ-bucket) table per
// combination, reached through the same tempDeltaBook the wire uses. One representative
// previous delta per bucket: ≤-2 | -1 | 0 | +1 | ≥+2.
const PREV_BUCKET_REPS = [-5, -1, 0, 1, 5];
function allTempBooks(): CodeBook[] {
  const books: CodeBook[] = [tempDeltaBook(0, 0, null)]; // bootstrap (context args ignored)
  for (let res = 0; res < 4; res++) {
    for (let tod = 0; tod < TEMP_DELTA_TOD_BUCKETS; tod++) {
      for (const prev of PREV_BUCKET_REPS) books.push(tempDeltaBook(res, tod, prev));
    }
  }
  return books;
}

// Cost of a delta sequence with the context threaded the way v3.ts threads it: each delta's
// book keyed by the previous delta (bootstrap first), at a fixed resolution and time-of-day.
function tempBits(deltas: number[]): number {
  return costOf((sink) => {
    let prev: number | null = null;
    for (const d of deltas) { encodeTempDelta(sink, tempDeltaBook(3, 0, prev), d); prev = d; }
  });
}

describe("temperature delta entropy coding", () => {
  it("round-trips every core delta (-7..7) under every codebook", () => {
    for (const book of allTempBooks()) {
      for (let d = -TEMP_DELTA_CORE_RADIUS; d <= TEMP_DELTA_CORE_RADIUS; d++) {
        const { cost, source } = encoded((sink) => encodeTempDelta(sink, book, d));
        expect(cost).toBeGreaterThan(0);
        expect(decodeTempDelta(source, book)).toBe(d);
        source.assertDone(); // consumed exactly the coded symbol, no more
      }
    }
  });

  it("round-trips escape-path deltas (|delta| > 7) via the raw 6-bit payload, including the exact field bounds", () => {
    const jumps = [8, -8, 11, -11, 20, -20, 31, -32, TEMP_DELTA_MAX, TEMP_DELTA_MIN];
    for (const book of allTempBooks()) {
      for (const d of jumps) {
        const { source } = encoded((sink) => encodeTempDelta(sink, book, d));
        expect(decodeTempDelta(source, book)).toBe(d);
        source.assertDone();
      }
    }
  });

  it("throws on deltas outside the escape field's range instead of silently truncating", () => {
    // An unchecked encode of e.g. +40 would silently wrap in the 6-bit escape field and corrupt
    // every later temperature in the chain. The guard makes that impossible to emit;
    // v3.ts clamps before calling (see the healing round-trip test in encoding.test.ts).
    for (const d of [TEMP_DELTA_MAX + 1, TEMP_DELTA_MIN - 1, 40, -40, 100]) {
      expect(() => encodeTempDelta(makeBitSink(), tempDeltaBook(0, 0, null), d)).toThrow(/temp delta/);
    }
  });

  it("decodes a concatenated context-threaded sequence unambiguously, mixing core and escape", () => {
    const seq = [0, 1, -1, 0, 2, -3, 9, 0, 1, -14, 0, 0];
    for (let res = 0; res < 4; res++) {
      const { source } = encoded((sink) => {
        let prev: number | null = null;
        for (const d of seq) { encodeTempDelta(sink, tempDeltaBook(res, 3, prev), d); prev = d; }
      });
      const out: number[] = [];
      let prev: number | null = null;
      for (let k = 0; k < seq.length; k++) {
        const d = decodeTempDelta(source, tempDeltaBook(res, 3, prev));
        out.push(d);
        prev = d;
      }
      expect(out).toEqual(seq);
      source.assertDone();
    }
  });

  it("a near-constant column costs fewer bits than a wide-swinging one, and beats raw 8-bit", () => {
    const flat = Array(64).fill(0);
    const swings = Array.from({ length: 64 }, (_, i) => (i % 2 === 0 ? 5 : -5));
    expect(tempBits(flat)).toBeLessThan(tempBits(swings));
    expect(tempBits(flat)).toBeLessThan(flat.length * 8); // beats raw 8 bits/value
  });
});
