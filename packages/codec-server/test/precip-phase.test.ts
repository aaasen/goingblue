import { describe, expect, it } from "vitest";
import { adjustPrecipPhase, type HourlyData } from "../src/forecast.js";

// Build a minimal HourlyData: every column the adjustment reads, one entry per hour.
function hourly(cols: {
  temp?: (number | null)[];
  fz?: (number | null)[];
  wc?: (number | null)[];
  rain?: (number | null)[];
  showers?: (number | null)[];
  snow?: (number | null)[];
}): HourlyData {
  const n = Math.max(...Object.values(cols).map((c) => c?.length ?? 0), 1);
  const h: Record<string, unknown[]> = {
    time: Array.from({ length: n }, (_, i) => `2026-08-08T${String(i).padStart(2, "0")}:00`),
  };
  if (cols.temp) h.temperature_2m = cols.temp;
  if (cols.fz) h.freezing_level_height = cols.fz;
  if (cols.wc) h.weather_code = cols.wc;
  if (cols.rain) h.rain = cols.rain;
  if (cols.showers) h.showers = cols.showers;
  if (cols.snow) h.snowfall = cols.snow;
  return h as unknown as HourlyData;
}

describe("adjustPrecipPhase", () => {
  it("remaps liquid to snow when the site is above the freezing level (Denali case)", () => {
    // GFS at Denali: drizzle decided at the 2818 m grid cell, requested elevation 6096 m.
    const h = hourly({ temp: [-20.4], fz: [2900], wc: [51], rain: [0.1], snow: [0] });
    const out = adjustPrecipPhase(h, 6096);
    expect(out.rain).toEqual([0]);
    expect(out.snowfall).toEqual([expect.closeTo(0.07, 5)]); // 0.1 mm * 0.7 cm/mm
    expect(out.weather_code).toEqual([71]);
  });

  it("sums showers into the converted snow and zeroes both liquid columns", () => {
    const h = hourly({ temp: [-20], fz: [2900], wc: [80], rain: [0.1], showers: [0.2], snow: [0] });
    const out = adjustPrecipPhase(h, 6096);
    expect(out.rain).toEqual([0]);
    expect(out.showers).toEqual([0]);
    expect(out.snowfall).toEqual([expect.closeTo(0.3 * 0.7, 5)]);
    expect(out.weather_code).toEqual([85]);
  });

  it("adds onto existing snowfall in a mixed hour rather than replacing it", () => {
    const h = hourly({ temp: [-5], fz: [100], wc: [63], rain: [1.0], snow: [0.5] });
    const out = adjustPrecipPhase(h, 1500);
    expect(out.snowfall).toEqual([expect.closeTo(0.5 + 0.7, 5)]);
    expect(out.weather_code).toEqual([73]);
  });

  it("treats freezing level 0 as a real value (whole column below freezing), not as missing", () => {
    const h = hourly({ temp: [-10], fz: [0], wc: [61], rain: [0.4], snow: [0] });
    const out = adjustPrecipPhase(h, 500);
    expect(out.rain).toEqual([0]);
    expect(out.weather_code).toEqual([71]);
  });

  it("fires on temperature alone when freezing level is absent (GEM/ECMWF)", () => {
    const h = hourly({ temp: [-5], wc: [61], rain: [0.5], snow: [0] });
    const out = adjustPrecipPhase(h, 2000);
    expect(out.rain).toEqual([0]);
    expect(out.snowfall).toEqual([expect.closeTo(0.35, 5)]);
    expect(out.weather_code).toEqual([71]);
  });

  it("fires on temperature in an inversion even with the site below the freezing level", () => {
    // Cold air pooled under a warm layer: freezing level aloft, surface well below freezing.
    const h = hourly({ temp: [-6], fz: [2500], wc: [61], rain: [0.3], snow: [0] });
    const out = adjustPrecipPhase(h, 400);
    expect(out.rain).toEqual([0]);
    expect(out.weather_code).toEqual([71]);
  });

  it("leaves warm rain alone (site below freezing level, temp above the catch)", () => {
    const h = hourly({ temp: [5], fz: [2000], wc: [63], rain: [2.0], snow: [0] });
    const out = adjustPrecipPhase(h, 400);
    expect(out.rain).toEqual([2.0]);
    expect(out.snowfall).toEqual([0]);
    expect(out.weather_code).toEqual([63]);
  });

  it("leaves near-freezing liquid alone: the temp catch starts at -2, not 0", () => {
    const h = hourly({ temp: [-1], fz: [1500], wc: [61], rain: [0.5], snow: [0] });
    const out = adjustPrecipPhase(h, 400);
    expect(out.rain).toEqual([0.5]);
    expect(out.weather_code).toEqual([61]);
  });

  it("never remaps snow to rain", () => {
    const h = hourly({ temp: [1], fz: [3000], wc: [71], rain: [0], snow: [1.2] });
    const out = adjustPrecipPhase(h, 400);
    expect(out.snowfall).toEqual([1.2]);
    expect(out.weather_code).toEqual([71]);
  });

  it("leaves freezing drizzle/rain hours (56/57/66/67) entirely alone", () => {
    for (const code of [56, 57, 66, 67]) {
      const h = hourly({ temp: [-4], fz: [0], wc: [code], rain: [0.6], snow: [0] });
      const out = adjustPrecipPhase(h, 2000);
      expect(out.rain).toEqual([0.6]);
      expect(out.snowfall).toEqual([0]);
      expect(out.weather_code).toEqual([code]);
    }
  });

  it("keeps non-liquid codes (thunderstorm) while still moving the amounts", () => {
    const h = hourly({ temp: [-8], fz: [0], wc: [95], rain: [1.0], snow: [0] });
    const out = adjustPrecipPhase(h, 3000);
    expect(out.rain).toEqual([0]);
    expect(out.snowfall).toEqual([expect.closeTo(0.7, 5)]);
    expect(out.weather_code).toEqual([95]);
  });

  it("remaps a contradictory liquid code even in an hour with no measurable liquid", () => {
    const h = hourly({ temp: [-15], fz: [2000], wc: [61], rain: [0], snow: [0] });
    const out = adjustPrecipPhase(h, 6000);
    expect(out.weather_code).toEqual([71]);
  });

  it("classifies each hour independently across a frontal passage", () => {
    const h = hourly({
      temp: [3, -3, -6], fz: [2000, 300, 0], wc: [61, 61, 61],
      rain: [1.0, 1.0, 1.0], snow: [0, 0, 0],
    });
    const out = adjustPrecipPhase(h, 500);
    expect(out.rain).toEqual([1.0, 0, 0]);
    expect(out.snowfall).toEqual([0, expect.closeTo(0.7, 5), expect.closeTo(0.7, 5)]);
    expect(out.weather_code).toEqual([61, 71, 71]);
  });

  it("materializes a snowfall column when the cell lacks one so the amount is not dropped", () => {
    const h = hourly({ temp: [-10], fz: [0], wc: [61], rain: [0.5] });
    const out = adjustPrecipPhase(h, 2000);
    expect(out.rain).toEqual([0]);
    expect(out.snowfall).toEqual([expect.closeTo(0.35, 5)]);
  });

  it("skips the freezing-level test when site elevation is null, keeping the temp catch", () => {
    const warm = hourly({ temp: [1], fz: [0], wc: [61], rain: [0.5], snow: [0] });
    expect(adjustPrecipPhase(warm, null).rain).toEqual([0.5]);
    const cold = hourly({ temp: [-5], fz: [0], wc: [61], rain: [0.5], snow: [0] });
    expect(adjustPrecipPhase(cold, null).rain).toEqual([0]);
  });

  it("does not mutate its input", () => {
    const h = hourly({ temp: [-20], fz: [0], wc: [61], rain: [0.5], snow: [0] });
    adjustPrecipPhase(h, 6000);
    expect(h.rain).toEqual([0.5]);
    expect(h.snowfall).toEqual([0]);
    expect(h.weather_code).toEqual([61]);
  });
});
