import { describe, it, expect } from "vitest";
import { apparentTempC, relativeHumidityPct } from "../src/model.js";

describe("reader-side derived readings", () => {
  it("relative humidity from a temp/dewpoint pair", () => {
    expect(relativeHumidityPct(20, 20)).toBe(100);
    expect(relativeHumidityPct(20, 10)).toBe(53);
    expect(relativeHumidityPct(20, 21)).toBe(100); // dewpoint above temp is model rounding
  });

  it("wind chill below 10 °C with wind, air temperature otherwise", () => {
    expect(apparentTempC(-10, 30)).toBeCloseTo(-19.5, 0); // NWS chart: -10 °C / 30 km/h → -20
    expect(apparentTempC(-10, 3)).toBe(-10);              // calm
    expect(apparentTempC(15, 30)).toBe(15);               // too warm for wind chill
  });

  it("heat index at or above 27 °C when humidity is known and high", () => {
    expect(apparentTempC(32, 5, 70)).toBeCloseTo(40.4, 1); // NWS: 89.6 °F / 70% → ~104.7 °F
    expect(apparentTempC(32, 5, 30)).toBe(32);           // dry air
    expect(apparentTempC(32, 5)).toBe(32);               // humidity unknown: no heat index
  });
});
