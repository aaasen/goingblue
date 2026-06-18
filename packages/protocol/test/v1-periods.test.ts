import { describe, it, expect } from "vitest";
import { v1Codec } from "../src/versions/v1.js";
import { V1_HEADER_CHARS } from "../src/versions/v1.js";
import { DEFAULT_VARS_MASK } from "../src/constants.js";
import type { ForecastMessage, Period } from "../src/model.js";

const PERIOD: Period = {
  weathercode: 3, precip: 57, snow_cm: 0, freeze_m: 3048,
  wind_500_kph: 48, wind_500_dir: 4, wind_600_kph: 40, wind_600_dir: 3,
  wind_700_kph: 24, wind_700_dir: 2,
};

function msg(nPeriods: number, resolution: number): ForecastMessage {
  return {
    version: 1,
    code: 0,
    days: 0, // ignored by v1 encode — period count comes from the periods array
    resolution,
    models_mask: 0b0001,
    vars_mask: DEFAULT_VARS_MASK,
    month: 6, day: 15, hour: 0,
    lat: 63.063, lon: -151.081, elevation: 4267,
    periods: [Array.from({ length: nPeriods }, () => ({ ...PERIOD }))],
  };
}

// Round-trip with a resolver that returns the message's own request context.
function dec(m: ForecastMessage): ForecastMessage {
  return v1Codec.decode(v1Codec.encode(m), () => ({
    resolution: m.resolution, models_mask: m.models_mask, vars_mask: m.vars_mask, lat: m.lat, lon: m.lon,
  }));
}

describe("v1 period count", () => {
  it("round-trips a partial day at 1h resolution (46 periods)", () => {
    const decoded = dec(msg(46, 4));
    expect(decoded.periods[0]).toHaveLength(46);
    // 46 hourly periods span two calendar days (rounded up).
    expect(decoded.days).toBe(2);
    expect(decoded.resolution).toBe(4);
  });

  it("round-trips a single period", () => {
    const decoded = dec(msg(1, 4));
    expect(decoded.periods[0]).toHaveLength(1);
    expect(decoded.days).toBe(1);
  });

  it("round-trips the max 128 periods", () => {
    const decoded = dec(msg(128, 4));
    expect(decoded.periods[0]).toHaveLength(128);
  });

  it("uses a 7-char header", () => {
    expect(V1_HEADER_CHARS).toBe(7);
    expect(v1Codec.encode(msg(1, 4)).length).toBeGreaterThanOrEqual(V1_HEADER_CHARS);
  });
});
