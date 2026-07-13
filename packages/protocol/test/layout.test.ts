import { describe, it, expect } from "vitest";
import { layoutFor, maxFillSeq, slotsFor, RESOLUTION_HOURS } from "../src/index.js";

// A representative request instant: 2026-07-12, at various hours of the (UTC) day.
const BASE_DAY_UTC_HOUR = Date.UTC(2026, 6, 12) / 3600000;

const DURATIONS = [3, 5, 7, 10];
const OFFSETS = [-9, 0, 5, 13];

describe("layoutFor — invariants over the full sequence", () => {
  for (const D of DURATIONS) {
    for (const z of OFFSETS) {
      for (const hourOfDay of [0, 5, 13, 23]) {
        const reqUtc = BASE_DAY_UTC_HOUR + hourOfDay - z; // local hour-of-day == hourOfDay
        it(`D=${D} z=${z} local ${hourOfDay}:00 — every seq is well-formed`, () => {
          const local = reqUtc + z;
          const day0 = Math.floor(local / 24) * 24;

          for (let seq = 1; seq <= maxFillSeq(D); seq++) {
            const l = layoutFor(D, reqUtc, z, seq);
            const n = l.periodHours.length;
            expect(l.periodStartUtcHour).toHaveLength(n);
            expect(l.dayResolution).toHaveLength(l.days);
            expect(l.days).toBe(l.truncated ? seq : slotsFor(D));

            // Periods are contiguous: each starts where the previous ended.
            for (let i = 1; i < n; i++) {
              expect(l.periodStartUtcHour[i]).toBe(
                l.periodStartUtcHour[i - 1] + l.periodHours[i - 1]);
            }

            // The first period contains the request time.
            const firstLocal = l.periodStartUtcHour[0] + z;
            expect(firstLocal).toBeLessThanOrEqual(local);
            expect(firstLocal + l.periodHours[0]).toBeGreaterThan(local);

            for (let i = 0; i < n; i++) {
              const h = l.periodHours[i];
              const startLocal = l.periodStartUtcHour[i] + z;
              // Every period start is aligned to its own resolution within the local day
              // (12h at 0:00/12:00, 6h at 0:00/6:00/12:00/18:00, …).
              expect((((startLocal % 24) + 24) % 24) % h).toBe(0);
              // No period crosses local midnight.
              expect(Math.floor(startLocal / 24)).toBe(Math.floor((startLocal + h - 1) / 24));
            }

            // The window always ends at local midnight after the last covered day.
            const endLocal = l.periodStartUtcHour[n - 1] + l.periodHours[n - 1] + z;
            expect(endLocal).toBe(day0 + 24 * l.days);

            // The requested duration is a floor on forward coverage, whatever the request hour:
            // an untruncated layout always reaches at least D × 24h past the request.
            if (!l.truncated) expect(endLocal - local).toBeGreaterThanOrEqual(24 * D);

            // Refinement runs front-to-back: day resolutions never get finer later in the
            // window (larger index = finer).
            for (let d = 1; d < l.days; d++) {
              expect(l.dayResolution[d]).toBeLessThanOrEqual(l.dayResolution[d - 1]);
            }
            // Adjacent stages only: at most two distinct resolutions, one ladder step apart.
            const distinct = [...new Set(l.dayResolution)];
            expect(distinct.length).toBeLessThanOrEqual(2);
            if (distinct.length === 2) expect(distinct[0] - distinct[1]).toBe(1);

            // periodHours matches each day's resolution.
            let p = 0;
            for (let d = 0; d < l.days; d++) {
              const h = RESOLUTION_HOURS[l.dayResolution[d]];
              const dayEndLocal = day0 + 24 * (d + 1);
              while (p < n && l.periodStartUtcHour[p] + z < dayEndLocal) {
                expect(l.periodHours[p]).toBe(h);
                p++;
              }
            }
            expect(p).toBe(n);
          }
        });
      }
    }
  }
});

describe("layoutFor — sequence stages", () => {
  const D = 10;
  const S = slotsFor(D); // 11 slots: the rest of the request day, then 10 whole days
  const z = -9;
  // Request at 13:00 local (the 13:03 example, aligned down to the hour).
  const reqUtc = BASE_DAY_UTC_HOUR + 13 - z;

  it("seq < S is a truncated pure-12h forecast", () => {
    const l = layoutFor(D, reqUtc, z, 4);
    expect(l.truncated).toBe(true);
    expect(l.days).toBe(4);
    expect(l.periodHours).toEqual(Array(7).fill(12));
    // Slot 0 starts with the 12h period containing the request time.
    expect(l.periodStartUtcHour[0] + z).toBe(Math.floor((reqUtc + z) / 24) * 24 + 12);
  });

  it("seq = S covers the full duration at 12h", () => {
    const l = layoutFor(D, reqUtc, z, S);
    expect(l.truncated).toBe(false);
    expect(l.days).toBe(S);
    expect(l.periodHours).toEqual(Array(2 * S - 1).fill(12));
  });

  it("seq = S + 3 refines the first three slots to 6h (the 13:03 example)", () => {
    const l = layoutFor(D, reqUtc, z, S + 3);
    expect(l.dayResolution).toEqual([2, 2, 2, 1, 1, 1, 1, 1, 1, 1, 1]);
    // At 13:00 local, slot 0's 6h grid yields two periods; the next two days four each;
    // then eight days at 12h.
    expect(l.periodHours).toEqual([
      6, 6, 6, 6, 6, 6, 6, 6, 6, 6,
      12, 12, 12, 12, 12, 12, 12, 12, 12, 12, 12, 12, 12, 12, 12, 12,
    ]);
    expect(l.periodStartUtcHour[0] + z - Math.floor((reqUtc + z) / 24) * 24).toBe(12);
  });

  it("stage boundaries meet: seq = 2S from below and above is all-6h", () => {
    const l = layoutFor(D, reqUtc, z, 2 * S);
    expect(l.dayResolution).toEqual(Array(S).fill(2));
  });

  it("seq = 4S is the whole window at 1h, starting at the request hour", () => {
    const l = layoutFor(D, reqUtc, z, 4 * S);
    expect(l.dayResolution).toEqual(Array(S).fill(4));
    expect(l.periodHours.every((h) => h === 1)).toBe(true);
    expect(l.periodStartUtcHour[0]).toBe(reqUtc);
    // 11 hours left of the request day (13:00–24:00) + the 10 whole days asked for.
    expect(l.periodHours).toHaveLength(11 + D * 24);
  });

  it("a request at exactly local midnight has a whole request day, so it over-covers by one day", () => {
    const midnightUtc = BASE_DAY_UTC_HOUR - z; // 0:00 local
    // Slot 0 is the *remainder* of the request day, which at 0:00 is all of it: D + 1 whole
    // days. The coverage floor still holds (it is the only hour that exceeds it); the cost is
    // a day's worth of periods, so the fill just lands a rung coarser.
    const l = layoutFor(D, midnightUtc, z, 4 * S);
    expect(l.periodHours).toHaveLength(S * 24);
    // No partial day anywhere: truncated layouts have exactly two periods per day.
    for (let seq = 1; seq <= S; seq++) {
      expect(layoutFor(D, midnightUtc, z, seq).periodHours).toHaveLength(2 * seq);
    }
  });

  it("rejects out-of-range inputs", () => {
    expect(() => layoutFor(D, reqUtc, z, 0)).toThrow();
    expect(() => layoutFor(D, reqUtc, z, 4 * S + 1)).toThrow();
    expect(() => layoutFor(0, reqUtc, z, 1)).toThrow();
    expect(() => layoutFor(D, reqUtc, 15, 1)).toThrow();
    expect(() => layoutFor(D, reqUtc, -13, 1)).toThrow();
    expect(() => layoutFor(D, reqUtc + 0.5, z, 1)).toThrow();
  });
});
