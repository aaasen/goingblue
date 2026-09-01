import { describe, it, expect } from "vitest";
import {
  fillSlotsFor, FILL_REACH_HOURS, maxFillSeq, fillProfile, FILL_SLOTS,
  MODE_DETAIL, MODE_AUTO, MODE_RANGE, MODEL_BIT,
  predictBestMatch, MODELS, type ModelSpec,
} from "../src/index.js";

const MODES = [MODE_DETAIL, MODE_AUTO, MODE_RANGE];

describe("fillSlotsFor", () => {
  // A UTC epoch hour whose local time-of-day is `h` at offset 0 (day boundary far from zero so
  // negative offsets can't go below the epoch).
  const utcHourAtLocal = (h: number, offset: number): number => 24 * 1000 + h - offset;

  it("counts the day slots whose end lies within Canada's guaranteed reach", () => {
    // 221h from local hour 0 ends 5h into day 9, so 9 whole slots; a request at local hour 19
    // or later reaches the end of slot 9, the 10th.
    expect(fillSlotsFor(MODEL_BIT.CA, utcHourAtLocal(0, 0), 0)).toBe(9);
    expect(fillSlotsFor(MODEL_BIT.CA, utcHourAtLocal(18, 0), 0)).toBe(9);
    expect(fillSlotsFor(MODEL_BIT.CA, utcHourAtLocal(19, 0), 0)).toBe(10);
    expect(fillSlotsFor(MODEL_BIT.CA, utcHourAtLocal(23, 0), 0)).toBe(10);
  });

  it("computes the local hour through the UTC offset, including negative offsets", () => {
    for (const offset of [-9, -1, 0, 5, 14]) {
      expect(fillSlotsFor(MODEL_BIT.CA, utcHourAtLocal(18, offset), offset)).toBe(9);
      expect(fillSlotsFor(MODEL_BIT.CA, utcHourAtLocal(19, offset), offset)).toBe(10);
    }
  });

  it("serves the full window for models without a reach entry", () => {
    for (const center of ["BEST", "US", "EU"]) {
      expect(fillSlotsFor(MODEL_BIT[center], utcHourAtLocal(0, 0), 0), center).toBe(FILL_SLOTS);
    }
    expect(fillSlotsFor(99, utcHourAtLocal(0, 0), 0)).toBe(FILL_SLOTS);
  });
});

describe("capped paths", () => {
  it("keeps the ladder invariants at every cap", () => {
    for (const mode of MODES) {
      for (let slots = 6; slots <= FILL_SLOTS; slots++) {
        const label = `mode ${mode} slots ${slots}`;
        let prevPeriods = 0;
        for (let seq = 1; seq <= maxFillSeq(mode, slots); seq++) {
          const p = fillProfile(mode, seq, slots);
          expect(p.length, label).toBeLessThanOrEqual(slots);
          for (let i = 1; i < p.length; i++) {
            expect(p[i], `${label} seq ${seq}: finer after coarser`).toBeLessThanOrEqual(p[i - 1]);
          }
          // Period count strictly grows along the path, so encoded size grows with seq and the
          // budget search stays a prefix search.
          const periods = p.reduce((n, r) => n + 24 / [0, 12, 6, 3, 1][r], 0);
          expect(periods, `${label} seq ${seq}`).toBeGreaterThan(prevPeriods);
          prevPeriods = periods;
        }
      }
    }
  });

  it("shrinks the path as the cap tightens, and matches the full path uncapped", () => {
    for (const mode of MODES) {
      expect(maxFillSeq(mode, FILL_SLOTS)).toBe(maxFillSeq(mode));
      for (let slots = 7; slots <= FILL_SLOTS; slots++) {
        expect(maxFillSeq(mode, slots - 1)).toBeLessThan(maxFillSeq(mode, slots));
      }
    }
  });

  it("refines to the top anchor inside Canada's window", () => {
    // The point of the cap: a short-horizon center's budget goes into refinement instead of
    // stranding against days it can't serve. At 10 slots the tops are the truncated anchors.
    expect(fillProfile(MODE_AUTO, maxFillSeq(MODE_AUTO, 10), 10))
      .toEqual([4, 4, 4, 4, 4, 4, 3, 3, 3, 3]);
    expect(fillProfile(MODE_RANGE, maxFillSeq(MODE_RANGE, 10), 10))
      .toEqual([4, 4, 4, 3, 3, 3, 3, 3, 3, 3]);
    expect(fillProfile(MODE_DETAIL, maxFillSeq(MODE_DETAIL, 10), 10))
      .toEqual([4, 4, 4, 4, 4, 4, 4, 4, 3, 3]);
  });
});

// FILL_REACH_HOURS is a frozen claim about upstream horizons, and it must err low. These fail
// if a listed center's guaranteed reach shrinks below its frozen entry (the cap would then put
// unservable periods inside every capped path), or if an unlisted center falls short of the
// window (it would strand budget at the data cliff) — either way the table needs revisiting.
describe("which centers fall short of the window", () => {
  const guaranteedReach = (models: ModelSpec[]): number =>
    Math.max(...models.map((m) => m.horizonHours - m.runIntervalHours - m.delayHours));
  // The widest window a request can ask for: FILL_SLOTS whole days.
  const WINDOW_HOURS = FILL_SLOTS * 24;

  it("Canada's frozen reach is still guaranteed by its models", () => {
    const gem = [MODELS.gem_hrdps_continental, MODELS.gem_regional, MODELS.gem_global];
    expect(FILL_REACH_HOURS[MODEL_BIT.CA]).toBeLessThanOrEqual(guaranteedReach(gem));
    expect(guaranteedReach(gem)).toBeLessThan(WINDOW_HOURS);
  });

  it("NOAA and ECMWF still clear it", () => {
    expect(guaranteedReach([MODELS.gfs_hrrr, MODELS.gfs_global])).toBeGreaterThanOrEqual(WINDOW_HOURS);
    expect(guaranteedReach([MODELS.ecmwf_ifs])).toBeGreaterThanOrEqual(WINDOW_HOURS);
  });

  it("every best_match branch still clears it", () => {
    const points: Array<[string, number, number]> = [
      ["netherlands-knmi", 52.37, 4.90], ["nordic-metno", 69.65, 18.96], ["uk-ukmo", 51.5, -0.12],
      ["central-europe-icon-d2", 45.83, 6.87], ["france-arome", 48.39, -4.49],
      ["northern-europe-dmi", 52.23, 21.01], ["conus-hrrr", 47.61, -122.33],
      ["japan-jma-msm", 35.68, 139.77], ["europe-icon-eu", 42.0, 9.1],
      ["global-fallback", 63.07, -151.0],
    ];
    for (const [branch, lat, lon] of points) {
      const prediction = predictBestMatch(lat, lon);
      expect(prediction.branch).toBe(branch);
      expect(guaranteedReach(prediction.models), branch).toBeGreaterThanOrEqual(WINDOW_HOURS);
    }
  });
});
