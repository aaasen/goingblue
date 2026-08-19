import { describe, expect, it } from "vitest";
import { aggregateWeathercode, drySkyCode, isDryWindow } from "../src/weathercode.js";

// A window of `n` hours all reporting the same code.
const rep = (code: number, n: number): number[] => new Array<number>(n).fill(code);

describe("aggregateWeathercode", () => {
  describe("form from coverage", () => {
    it("summarizes one hour of heavy snow in an otherwise clear 12h window as snow showers", () => {
      // The motivating case: max() called this 75 "heavy snow" for the whole half-day. 2 cm in
      // that one hour is a heavy shower, so 86 — and 86 renders with sun behind the cloud.
      expect(aggregateWeathercode([...rep(75, 1), ...rep(0, 11)], 2.0, 0)).toBe(86);
    });

    it("drops to the light shower form when that hour barely accumulated", () => {
      expect(aggregateWeathercode([...rep(75, 1), ...rep(0, 11)], 0.3, 0)).toBe(85);
    });

    it("keeps the continuous form when the window was wet throughout", () => {
      expect(aggregateWeathercode(rep(61, 12), 0, 12)).toBe(61);
    });

    it("switches form at half coverage", () => {
      // 6 of 12 wet is continuous; 5 of 12 is showery. Same rate either side, so only the
      // coverage moves — and the intensity rung is preserved across the swap (63 ↔ 81).
      expect(aggregateWeathercode([...rep(63, 6), ...rep(0, 6)], 0, 18)).toBe(63);
      expect(aggregateWeathercode([...rep(63, 5), ...rep(0, 7)], 0, 15)).toBe(81);
    });

    it("never upgrades a shower code to a continuous one", () => {
      // One-directional: the model said showers for every hour, so showers it stays even at
      // full coverage. Otherwise the rule would overwrite the model's own convective call.
      expect(aggregateWeathercode(rep(80, 12), 0, 12)).toBe(80);
    });
  });

  describe("intensity from accumulation", () => {
    it("reads the rung off accumulation per wet hour, not off the peak hour's code", () => {
      // Model says "slight snow" (71) in every case; only how much fell distinguishes them.
      const shower = [...rep(71, 4), ...rep(0, 8)];  // 1/3 coverage → shower form
      expect(aggregateWeathercode(shower, 0.3, 0)).toBe(85); // 0.075 cm/wet-h → light
      expect(aggregateWeathercode(shower, 6.0, 0)).toBe(86); // 1.5   cm/wet-h → heavy
      const steady = rep(71, 12);                     // full coverage → continuous form
      expect(aggregateWeathercode(steady, 0.6, 0)).toBe(71); // 0.05 cm/h
      expect(aggregateWeathercode(steady, 3.0, 0)).toBe(73); // 0.25 cm/h
      expect(aggregateWeathercode(steady, 12.0, 0)).toBe(75); // 1.0 cm/h
    });

    it("leaves drizzle in the drizzle family at any coverage", () => {
      // 51/53/55 have no shower form in the alphabet, so they never swap — only the rung moves.
      expect(aggregateWeathercode([...rep(51, 2), ...rep(0, 10)], 0, 0.4)).toBe(51);
      expect(aggregateWeathercode([...rep(51, 2), ...rep(0, 10)], 0, 3.0)).toBe(55);
    });
  });

  describe("mixed rain and snow", () => {
    it("emits the mixed codes when both phases hold a quarter of the wet hours", () => {
      const mixed = [...rep(71, 3), ...rep(61, 3)];
      expect(aggregateWeathercode(mixed, 1.0, 3.0)).toBe(69);
      expect(aggregateWeathercode(mixed, 0.1, 0.2)).toBe(68);
    });

    it("does not fire when the minority phase is a single stray hour", () => {
      // 1 rain hour in 12 snow ones is a transition, not a wintry mix.
      expect(aggregateWeathercode([...rep(71, 11), ...rep(61, 1)], 3.0, 0.2)).not.toBe(68);
    });

    it("fires on amounts when every hourly code says snow but rain accumulated too", () => {
      // The field case: hourly codes are single-valued, so "mostly snow, some rain" hours all
      // read as snow — but the rain shipped in the same period's own row. 4.2 cm = 6 mm WE
      // against 4 mm rain: rain holds 40% of the water, well past MIX_FRAC.
      expect(aggregateWeathercode(rep(73, 12), 4.2, 4.0)).toBe(69);
    });

    it("is symmetric: snow accumulating under all-rain codes also reads as mixed", () => {
      expect(aggregateWeathercode(rep(63, 12), 4.2, 4.0)).toBe(69);
    });

    it("ignores a trace of the minority phase below the WE floor", () => {
      // 0.1 mm of rain under 3 cm of snow is quantization dust, not a wintry mix.
      expect(aggregateWeathercode(rep(73, 12), 3.0, 0.1)).toBe(73);
    });

    it("ignores a minority phase below the WE share gate however much fell", () => {
      // 2 mm rain under 14 cm (20 mm WE) of snow is 9% of the water: a snowstorm, not a mix.
      expect(aggregateWeathercode(rep(75, 12), 14.0, 2.0)).toBe(75);
    });

    it("can call a single mixed hour 68/69 at 1h resolution", () => {
      // The one place the aggregation may rewrite a 1h code: the model splits amounts by phase
      // within the hour but its weathercode cannot say "both".
      expect(aggregateWeathercode([73], 0.14, 0.2)).toBe(68);
      expect(aggregateWeathercode([73], 2.1, 2.0)).toBe(69);
    });

    it("keeps the amount arm out of the code-arm's escapes", () => {
      // Freezing rain with snow accumulating stays the freezing escape — being wrong about ice
      // is a safety problem, so it is never diluted into "mixed".
      expect(aggregateWeathercode([...rep(66, 2), ...rep(73, 10)], 2.1, 2.0)).toBe(66);
    });
  });

  describe("escapes", () => {
    it("lets a single thunder hour win the window", () => {
      expect(aggregateWeathercode([...rep(95, 1), ...rep(0, 11)], 0, 5)).toBe(95);
    });

    it("lets freezing precipitation outrank snow, which numeric max did not", () => {
      // 66 < 75 numerically, so max() reported heavy snow and dropped the ice entirely.
      expect(aggregateWeathercode([...rep(66, 1), ...rep(75, 5)], 2, 1)).toBe(66);
    });
  });

  describe("dry windows", () => {
    it("averages the cloud ladder instead of taking the worst hour", () => {
      // max() called this overcast; eleven of its twelve hours were clear sky.
      expect(aggregateWeathercode([...rep(3, 1), ...rep(0, 11)], 0, 0)).toBe(0);
      expect(aggregateWeathercode(rep(3, 12), 0, 0)).toBe(3);
      expect(aggregateWeathercode([...rep(0, 6), ...rep(3, 6)], 0, 0)).toBe(2);
    });

    it("reports fog only once it covers a quarter of the window", () => {
      expect(aggregateWeathercode([...rep(45, 4), ...rep(0, 8)], 0, 0)).toBe(45);
      // Below the gate the foggy hour dissolves into the sky mean rather than claiming the period.
      expect(aggregateWeathercode([...rep(45, 1), ...rep(0, 11)], 0, 0)).toBe(0);
    });

    it("prefers rime fog when any hour reported it", () => {
      expect(aggregateWeathercode([...rep(45, 2), ...rep(48, 2), ...rep(0, 8)], 0, 0)).toBe(48);
    });
  });

  describe("degenerate windows", () => {
    it("passes an hourly code through unchanged at 1h resolution", () => {
      // A one-hour window is fully wet or fully dry, so form and sky are exact pass-throughs.
      for (const code of [0, 1, 2, 3, 45, 63, 80, 73, 95]) {
        expect(aggregateWeathercode([code], code === 73 ? 0.3 : 0, code === 63 ? 3 : code === 80 ? 1.5 : 0))
          .toBe(code);
      }
    });

    it("returns the no-data code for an empty window", () => {
      expect(aggregateWeathercode([], 0, 0)).toBe(0);
    });
  });
});

describe("isDryWindow", () => {
  it("treats fog and cloud as dry, and any precipitation as wet", () => {
    expect(isDryWindow([0, 1, 2, 3, 45, 48])).toBe(true);
    expect(isDryWindow([0, 0, 51])).toBe(false);
    expect(isDryWindow([0, 0, 95])).toBe(false);
  });
});

describe("drySkyCode", () => {
  it("quantizes the mean implied cloud fraction back onto the 0..3 ladder", () => {
    expect(drySkyCode(rep(0, 4))).toBe(0);
    expect(drySkyCode(rep(1, 4))).toBe(1);
    expect(drySkyCode(rep(2, 4))).toBe(2);
    expect(drySkyCode(rep(3, 4))).toBe(3);
  });
});
