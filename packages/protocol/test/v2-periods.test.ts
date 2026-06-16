import { describe, it, expect } from "vitest";
import { v2Codec } from "../src/versions/v2.js";
import { V2_HEADER_CHARS } from "../src/versions/v2.js";
import { DEFAULT_VARS_MASK } from "../src/constants.js";
import type { ForecastMessage, Period } from "../src/model.js";

const PERIOD: Period = {
  weathercode: 3, precip: 57, snow_cm: 0, freeze_m: 3048,
  wind_500_kph: 48, wind_500_dir: 4, wind_600_kph: 40, wind_600_dir: 3,
  wind_700_kph: 24, wind_700_dir: 2,
};

function msg(nPeriods: number, resolution: number): ForecastMessage {
  return {
    version: 2,
    days: 0, // ignored by v2 encode — period count comes from the periods array
    resolution,
    models_mask: 0b0001,
    vars_mask: DEFAULT_VARS_MASK,
    month: 6, day: 15, hour: 0,
    lat: 63.063, lon: -151.081, elevation: 4267,
    periods: [Array.from({ length: nPeriods }, () => ({ ...PERIOD }))],
  };
}

describe("v2 period count", () => {
  it("round-trips a partial day at 1h resolution (46 periods)", () => {
    const decoded = v2Codec.decode(v2Codec.encode(msg(46, 4)));
    expect(decoded.periods[0]).toHaveLength(46);
    // 46 hourly periods span two calendar days (rounded up).
    expect(decoded.days).toBe(2);
    expect(decoded.resolution).toBe(4);
  });

  it("round-trips a single period", () => {
    const decoded = v2Codec.decode(v2Codec.encode(msg(1, 4)));
    expect(decoded.periods[0]).toHaveLength(1);
    expect(decoded.days).toBe(1);
  });

  it("round-trips the max 256 periods", () => {
    const decoded = v2Codec.decode(v2Codec.encode(msg(256, 4)));
    expect(decoded.periods[0]).toHaveLength(256);
  });

  it("uses a 15-char header", () => {
    expect(V2_HEADER_CHARS).toBe(15);
    expect(v2Codec.encode(msg(1, 4)).length).toBeGreaterThanOrEqual(V2_HEADER_CHARS);
  });
});
