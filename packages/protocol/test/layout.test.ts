import { describe, it, expect } from "vitest";
import {
  layoutFor, maxFillSeq, RESOLUTION_HOURS, FILL_SLOTS,
  MODE_DETAIL, MODE_AUTO, MODE_RANGE,
} from "../src/index.js";

// A representative request instant: 2026-07-12, at various hours of the (UTC) day.
const BASE_DAY_UTC_HOUR = Date.UTC(2026, 6, 12) / 3600000;

const MODES = [MODE_DETAIL, MODE_AUTO, MODE_RANGE];
const OFFSETS = [-9, 0, 5, 13];

// The compiled path lengths are WIRE FORMAT (an anchor edit that changes them re-numbers every
// seq). If one of these fails, the protocol version must be bumped, not the number updated.
it("path lengths are pinned", () => {
  expect(maxFillSeq(MODE_DETAIL)).toBe(47);
  expect(maxFillSeq(MODE_AUTO)).toBe(45);
  expect(maxFillSeq(MODE_RANGE)).toBe(42);
});

describe("layoutFor — invariants over every mode's full path", () => {
  for (const mode of MODES) {
    for (const z of OFFSETS) {
      for (const hourOfDay of [0, 5, 13, 23]) {
        const reqUtc = BASE_DAY_UTC_HOUR + hourOfDay - z; // local hour-of-day == hourOfDay
        it(`mode=${mode} z=${z} local ${hourOfDay}:00 — every seq is well-formed`, () => {
          const local = reqUtc + z;
          const day0 = Math.floor(local / 24) * 24;

          let prevPeriods = 0;
          let prevProfile: number[] = [];
          for (let seq = 1; seq <= maxFillSeq(mode); seq++) {
            const l = layoutFor(mode, reqUtc, z, seq);
            const n = l.periodHours.length;
            expect(l.periodStartUtcHour).toHaveLength(n);
            expect(l.dayResolution).toHaveLength(l.days);
            expect(l.days).toBeLessThanOrEqual(FILL_SLOTS);

            // The binary-search invariant: period count never shrinks along the path. (It can
            // stay equal when a step refines slot 0 late in the local day — at 23:00 one 12h
            // period and one 1h period both cover the remainder — the same non-strict caveat
            // fitFillToBudget has always tolerated.)
            expect(n).toBeGreaterThanOrEqual(prevPeriods);
            prevPeriods = n;

            // Each step refines the previous layout: coverage never shrinks, no slot gets coarser.
            expect(l.dayResolution.length).toBeGreaterThanOrEqual(prevProfile.length);
            for (let d = 0; d < prevProfile.length; d++) {
              expect(l.dayResolution[d]).toBeGreaterThanOrEqual(prevProfile[d]);
            }
            prevProfile = l.dayResolution;

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

            // Refinement runs front-to-back: day resolutions never get finer later in the
            // window (larger index = finer).
            for (let d = 1; d < l.days; d++) {
              expect(l.dayResolution[d]).toBeLessThanOrEqual(l.dayResolution[d - 1]);
            }

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

describe("layoutFor — path waypoints", () => {
  const z = -9;
  // Request at 13:00 local (the 13:03 example, aligned down to the hour).
  const reqUtc = BASE_DAY_UTC_HOUR + 13 - z;

  it("every mode starts with the shared truncated-12h ramp", () => {
    for (const mode of MODES) {
      for (let seq = 1; seq <= 3; seq++) {
        const l = layoutFor(mode, reqUtc, z, seq);
        expect(l.dayResolution).toEqual(Array(seq).fill(1));
        // Slot 0 at 13:00 local contributes one 12h period (12:00–24:00).
        expect(l.periodHours).toEqual(Array(2 * seq - 1).fill(12));
      }
    }
  });

  it("Detail reaches 3 hourly days before coverage exceeds 5 slots", () => {
    let seenThreeHourly = false;
    for (let seq = 1; seq <= maxFillSeq(MODE_DETAIL); seq++) {
      const l = layoutFor(MODE_DETAIL, reqUtc, z, seq);
      const hourlyDays = l.dayResolution.filter((r) => r === 4).length;
      if (!seenThreeHourly && hourlyDays >= 3) seenThreeHourly = true;
      if (!seenThreeHourly) expect(l.days).toBeLessThanOrEqual(5);
    }
    expect(seenThreeHourly).toBe(true);
  });

  it("Range covers the whole horizon before refining anything", () => {
    for (let seq = 1; seq <= maxFillSeq(MODE_RANGE); seq++) {
      const l = layoutFor(MODE_RANGE, reqUtc, z, seq);
      if (l.days < FILL_SLOTS) expect(l.dayResolution.every((r) => r === 1)).toBe(true);
    }
    // seq 13 = full coverage at 12h; the last all-12h layout on the path.
    expect(layoutFor(MODE_RANGE, reqUtc, z, FILL_SLOTS).dayResolution)
      .toEqual(Array(FILL_SLOTS).fill(1));
  });

  it("Auto holds coverage at 7 slots through the 3h refinement, then extends to 10", () => {
    // Anchor waypoints (see ANCHORS in layout.ts): 12h×7 → 6h×5+12h×2 → 3h×5+12h×2 → 3h×5+12h×5.
    const profiles = Array.from({ length: maxFillSeq(MODE_AUTO) }, (_, i) =>
      layoutFor(MODE_AUTO, reqUtc, z, i + 1).dayResolution.join(","));
    expect(profiles).toContain(Array(7).fill(1).join(","));
    expect(profiles).toContain([3, 3, 3, 3, 3, 1, 1].join(","));
    expect(profiles).toContain([3, 3, 3, 3, 3, 1, 1, 1, 1, 1].join(","));
  });

  it("mode tops are pinned", () => {
    const top = (mode: number) =>
      layoutFor(mode, reqUtc, z, maxFillSeq(mode)).dayResolution;
    expect(top(MODE_DETAIL)).toEqual([4, 4, 4, 4, 4, 4, 4, 4, 3, 3, 3, 3, 3]);
    expect(top(MODE_AUTO)).toEqual([4, 4, 4, 4, 4, 4, 3, 3, 3, 3, 3, 3, 3]);
    expect(top(MODE_RANGE)).toEqual([4, 4, 4, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3]);
  });

  it("a request at exactly local midnight has a whole request day, so it over-covers by one day", () => {
    const midnightUtc = BASE_DAY_UTC_HOUR - z; // 0:00 local
    // Slot 0 is the *remainder* of the request day, which at 0:00 is all of it. Truncated
    // layouts then have exactly two 12h periods per covered day.
    for (let seq = 1; seq <= 3; seq++) {
      expect(layoutFor(MODE_RANGE, midnightUtc, z, seq).periodHours).toHaveLength(2 * seq);
    }
  });

  it("rejects out-of-range inputs", () => {
    expect(() => layoutFor(MODE_DETAIL, reqUtc, z, 0)).toThrow();
    expect(() => layoutFor(MODE_DETAIL, reqUtc, z, maxFillSeq(MODE_DETAIL) + 1)).toThrow();
    expect(() => layoutFor(3, reqUtc, z, 1)).toThrow();
    expect(() => layoutFor(-1, reqUtc, z, 1)).toThrow();
    expect(() => layoutFor(MODE_DETAIL, reqUtc, 15, 1)).toThrow();
    expect(() => layoutFor(MODE_DETAIL, reqUtc, -13, 1)).toThrow();
    expect(() => layoutFor(MODE_DETAIL, reqUtc + 0.5, z, 1)).toThrow();
  });
});
