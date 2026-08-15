import { describe, it, expect } from "vitest";
import {
  effectiveMode, maxFillSeq, fillProfile, FILL_SLOTS,
  MODE_DETAIL, MODE_AUTO, MODE_RANGE, MODEL_BIT,
  predictBestMatch, MODELS, type ModelSpec,
} from "../src/index.js";

const MODES = [MODE_DETAIL, MODE_AUTO, MODE_RANGE];
const CENTERS = ["BEST", "US", "CA", "EU"];

describe("effectiveMode", () => {
  it("substitutes Auto for Range on Canadian models only", () => {
    for (const center of CENTERS) {
      for (const mode of MODES) {
        const expected = center === "CA" && mode === MODE_RANGE ? MODE_AUTO : mode;
        expect(effectiveMode(mode, MODEL_BIT[center]), `${center} mode ${mode}`).toBe(expected);
      }
    }
  });

  it("is idempotent", () => {
    // Both sides may apply it — the client before sending, the server on parse, the decoder on
    // resolve — so applying it twice must not move the mode again.
    for (const center of CENTERS) {
      for (const mode of MODES) {
        const once = effectiveMode(mode, MODEL_BIT[center]);
        expect(effectiveMode(once, MODEL_BIT[center])).toBe(once);
      }
    }
  });

  it("leaves an unknown model's mode alone", () => {
    expect(effectiveMode(MODE_RANGE, 99)).toBe(MODE_RANGE);
  });
});

// Why Range is the mode that needed substituting, stated as a property of the paths rather than
// prose: it is the only one whose coverage ramp reaches full width before anything is refined,
// so the layouts a short-horizon model can serve are all 12h.
describe("the paths behind the substitution", () => {
  it("Range covers the full window before refining, Detail and Auto do not", () => {
    const firstRefined = (mode: number): number => {
      for (let seq = 1; seq <= maxFillSeq(mode); seq++) {
        if (fillProfile(mode, seq).some((r) => r > 1)) return seq;
      }
      return Infinity;
    };
    const fullCoverage = (mode: number): number => {
      for (let seq = 1; seq <= maxFillSeq(mode); seq++) {
        if (fillProfile(mode, seq).length === FILL_SLOTS) return seq;
      }
      return Infinity;
    };
    // Range: every slot covered before any is refined — so a model that can't fill the window
    // has no refined layout available to it at all.
    expect(fullCoverage(MODE_RANGE)).toBeLessThan(firstRefined(MODE_RANGE));
    // Auto and Detail refine long before they finish covering, so their short-horizon layouts
    // still carry sub-12h periods.
    expect(firstRefined(MODE_AUTO)).toBeLessThan(fullCoverage(MODE_AUTO));
    expect(firstRefined(MODE_DETAIL)).toBeLessThan(fullCoverage(MODE_DETAIL));
  });

  it("Auto has refined layouts inside a 9-day window", () => {
    // The substitution is only worth making if Auto's servable prefix is better than Range's.
    const withinNineDays = [];
    for (let seq = 1; seq <= maxFillSeq(MODE_AUTO); seq++) {
      const p = fillProfile(MODE_AUTO, seq);
      if (p.length <= 9) withinNineDays.push(p);
    }
    expect(withinNineDays.some((p) => p.some((r) => r > 1))).toBe(true);
  });
});

// The substitution list is a claim about upstream horizons. These fail if a center listed as
// short-horizon grows past the window, or an unlisted one falls short of it — either way the
// list needs revisiting.
describe("which centers fall short of the window", () => {
  const guaranteedReach = (models: ModelSpec[]): number =>
    Math.max(...models.map((m) => m.horizonHours - m.runIntervalHours - m.delayHours));
  // The widest window a request can ask for: FILL_SLOTS whole days.
  const WINDOW_HOURS = FILL_SLOTS * 24;

  it("Canada still falls short", () => {
    const gem = [MODELS.gem_hrdps_continental, MODELS.gem_regional, MODELS.gem_global];
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
