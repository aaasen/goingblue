import { describe, it, expect } from "vitest";
import {
  messageToString,
  messageFromString,
  type ForecastMessage,
  type Period,
  CARDINALS,
  DEFAULT_VARS_MASK,
  VARS_BIT,
} from "../src/index.js";

const ALL_VARS =
  (1 << 0) | (1 << 1) | (1 << 2) | (1 << 3) | (1 << 4) | (1 << 5) | (1 << 6) | (1 << 7) |
  (1 << 8) | (1 << 9) | (1 << 10) | (1 << 11) | (1 << 12);

const RESOLUTIONS_PER_DAY = [1, 2, 4, 8, 24];

const PERIOD: Period = {
  weathercode: 73,
  precip: 75,
  temp_f: 32,
  snow_in: 4,
  freeze_ft: 6000,
  wind_sfc_mph: 10,
  wind_sfc_dir: 2,
  wind_500_mph: 30,
  wind_500_dir: 4,
  wind_600_mph: 25,
  wind_600_dir: 3,
  wind_700_mph: 15,
  wind_700_dir: 2,
  cloud_total: 80,
  cloud_high: 60,
  cloud_mid: 40,
  cloud_low: 20,
  vis_km: 8,
};

function popcount(n: number): number {
  let c = 0;
  while (n) { c += n & 1; n >>>= 1; }
  return c;
}

// Always derives `days` from periods[0].length / periodsPerDay to keep encoding consistent.
function msg(overrides: Partial<ForecastMessage> = {}): ForecastMessage {
  const resolution = overrides.resolution ?? 0;
  const models_mask = overrides.models_mask ?? 0b001;
  const nModels = popcount(models_mask);
  const periodsPerDay = RESOLUTIONS_PER_DAY[resolution];
  const defaultPeriods = Array.from({ length: nModels }, () =>
    Array(3 * periodsPerDay).fill(PERIOD),
  );
  const periods = overrides.periods ?? defaultPeriods;
  const days = periods[0].length / periodsPerDay;
  return {
    version: 7,
    location: 0,
    resolution,
    models_mask,
    vars_mask: ALL_VARS,
    month: 5,
    day: 20,
    hour: 12,
    lat: 63.135,
    lon: -150.989,
    elevation: 500,
    ...overrides,
    days,
    periods,
  };
}

function roundTrip(m: ForecastMessage): ForecastMessage {
  return messageFromString(messageToString(m));
}

describe("round-trip encoding", () => {
  it("preserves header fields", () => {
    // resolution=2 (6h) → 4 periods/day; 3 days → 12 periods per model; 2 models
    const original = msg({ location: 1, resolution: 2, models_mask: 0b011, month: 1, day: 31, hour: 0 });
    const decoded = roundTrip(original);
    expect(decoded.version).toBe(7);
    expect(decoded.location).toBe(1);
    expect(decoded.days).toBe(3);
    expect(decoded.resolution).toBe(2);
    expect(decoded.models_mask).toBe(0b011);
    expect(decoded.vars_mask).toBe(ALL_VARS);
    expect(decoded.month).toBe(1);
    expect(decoded.day).toBe(31);
    expect(decoded.hour).toBe(0);
  });

  it("preserves lat/lon within 1km", () => {
    const decoded = roundTrip(msg({ lat: 63.135, lon: -150.989 }));
    expect(decoded.lat).toBeCloseTo(63.135, 2);
    expect(decoded.lon).toBeCloseTo(-150.989, 2);
    // negative lat/lon
    const s = roundTrip(msg({ lat: -33.868, lon: 151.209 }));
    expect(s.lat).toBeCloseTo(-33.868, 2);
    expect(s.lon).toBeCloseTo(151.209, 2);
  });

  it("preserves elevation", () => {
    const decoded = roundTrip(msg({ elevation: 2200 }));
    expect(decoded.elevation).toBe(2200);
    // clamps negative to 0
    const clamped = roundTrip(msg({ elevation: -50 }));
    expect(clamped.elevation).toBe(0);
  });

  it("preserves location=2 (current)", () => {
    const decoded = roundTrip(msg({ location: 2 }));
    expect(decoded.location).toBe(2);
  });

  it("preserves all period fields", () => {
    const decoded = roundTrip(msg());
    const p = decoded.periods[0][0];
    expect(p.weathercode).toBe(PERIOD.weathercode);
    expect(p.precip).toBe(Math.round(Math.round((PERIOD.precip ?? 0) * 7 / 100) * 100 / 7));
    expect(p.temp_f).toBe(PERIOD.temp_f);
    expect(p.snow_in).toBe(PERIOD.snow_in);
    expect(p.freeze_ft).toBe(PERIOD.freeze_ft);
    expect(p.wind_sfc_mph).toBe(PERIOD.wind_sfc_mph);
    expect(p.wind_sfc_dir).toBe(PERIOD.wind_sfc_dir);
    expect(p.wind_500_mph).toBe(PERIOD.wind_500_mph);
    expect(p.wind_500_dir).toBe(PERIOD.wind_500_dir);
    expect(p.wind_600_mph).toBe(PERIOD.wind_600_mph);
    expect(p.wind_600_dir).toBe(PERIOD.wind_600_dir);
    expect(p.wind_700_mph).toBe(PERIOD.wind_700_mph);
    expect(p.wind_700_dir).toBe(PERIOD.wind_700_dir);
    // cloud cover is quantized to 3 bits (0–7 steps), decoded back to nearest %
    expect(p.cloud_total).toBe(Math.round(Math.round((PERIOD.cloud_total ?? 0) * 7 / 100) * 100 / 7));
    expect(p.cloud_high).toBe(Math.round(Math.round((PERIOD.cloud_high   ?? 0) * 7 / 100) * 100 / 7));
    expect(p.cloud_mid).toBe(Math.round(Math.round((PERIOD.cloud_mid     ?? 0) * 7 / 100) * 100 / 7));
    expect(p.cloud_low).toBe(Math.round(Math.round((PERIOD.cloud_low     ?? 0) * 7 / 100) * 100 / 7));
    expect(p.vis_km).toBe(PERIOD.vis_km);
  });

  it("omits all optional fields when vars_mask=0", () => {
    const decoded = roundTrip(msg({ vars_mask: 0 }));
    const p = decoded.periods[0][0];
    expect(p.precip).toBeUndefined();
    expect(p.temp_f).toBeUndefined();
    expect(p.snow_in).toBeUndefined();
    expect(p.freeze_ft).toBeUndefined();
    expect(p.wind_sfc_mph).toBeUndefined();
    expect(p.wind_500_mph).toBeUndefined();
    expect(p.cloud_total).toBeUndefined();
    expect(p.cloud_high).toBeUndefined();
    expect(p.vis_km).toBeUndefined();
  });

  it("only includes selected vars", () => {
    const varsMask = (1 << VARS_BIT.precip) | (1 << VARS_BIT.freeze);
    const decoded = roundTrip(msg({ vars_mask: varsMask }));
    const p = decoded.periods[0][0];
    expect(p.precip).toBe(Math.round(Math.round(75 * 7 / 100) * 100 / 7));
    expect(p.freeze_ft).toBe(6000);
    expect(p.temp_f).toBeUndefined();
    expect(p.snow_in).toBeUndefined();
    expect(p.wind_500_mph).toBeUndefined();
  });

  it("default vars mask includes expected vars", () => {
    expect(DEFAULT_VARS_MASK & (1 << VARS_BIT.precip)).toBeTruthy();
    expect(DEFAULT_VARS_MASK & (1 << VARS_BIT.snow)).toBeTruthy();
    expect(DEFAULT_VARS_MASK & (1 << VARS_BIT.freeze)).toBeTruthy();
    expect(DEFAULT_VARS_MASK & (1 << VARS_BIT.w500)).toBeTruthy();
    expect(DEFAULT_VARS_MASK & (1 << VARS_BIT.w600)).toBeTruthy();
    expect(DEFAULT_VARS_MASK & (1 << VARS_BIT.w700)).toBeTruthy();
    expect(DEFAULT_VARS_MASK & (1 << VARS_BIT.temp)).toBeFalsy();
    expect(DEFAULT_VARS_MASK & (1 << VARS_BIT.wind)).toBeFalsy();
  });

  it("handles all 8 wind directions", () => {
    for (let dir = 0; dir < 8; dir++) {
      const period = { ...PERIOD, wind_700_dir: dir };
      const decoded = roundTrip(msg({ periods: [[period]] }));
      expect(decoded.periods[0][0].wind_700_dir).toBe(dir);
      expect(CARDINALS[decoded.periods[0][0].wind_700_dir!]).toBe(CARDINALS[dir]);
    }
  });

  it("handles all resolutions", () => {
    for (let resolution = 0; resolution <= 4; resolution++) {
      const periodsPerDay = RESOLUTIONS_PER_DAY[resolution];
      const nPeriods = 2 * periodsPerDay;
      const decoded = roundTrip(msg({ resolution, periods: [Array(nPeriods).fill(PERIOD)] }));
      expect(decoded.resolution).toBe(resolution);
      expect(decoded.days).toBe(2);
      expect(decoded.periods[0]).toHaveLength(nPeriods);
    }
  });

  it("handles multiple models", () => {
    const periods = [[PERIOD, PERIOD, PERIOD], [PERIOD, PERIOD, PERIOD]];
    const decoded = roundTrip(msg({ models_mask: 0b011, periods }));
    expect(decoded.models_mask).toBe(0b011);
    expect(decoded.periods).toHaveLength(2);
    expect(decoded.periods[0]).toHaveLength(3);
    expect(decoded.periods[1]).toHaveLength(3);
  });

  it("handles all four models", () => {
    const row = Array(5).fill(PERIOD);
    const decoded = roundTrip(msg({ models_mask: 0b1111, periods: [row, row, row, row] }));
    expect(decoded.models_mask).toBe(0b1111);
    expect(decoded.periods).toHaveLength(4);
    expect(decoded.days).toBe(5);
  });

  it("clamps wind speed to 5 mph steps", () => {
    const decoded = roundTrip(msg({ periods: [[{ ...PERIOD, wind_700_mph: 27 }]] }));
    expect(decoded.periods[0][0].wind_700_mph).toBe(25);
  });

  it("clamps snow to 15 max", () => {
    const decoded = roundTrip(msg({ periods: [[{ ...PERIOD, snow_in: 20 }]] }));
    expect(decoded.periods[0][0].snow_in).toBe(15);
  });

  it("clamps freeze level to 15,000 ft max", () => {
    const decoded = roundTrip(msg({ periods: [[{ ...PERIOD, freeze_ft: 20000 }]] }));
    expect(decoded.periods[0][0].freeze_ft).toBe(15000);
  });

  it("rounds precip to nearest 3-bit step", () => {
    const decoded = roundTrip(msg({ periods: [[{ ...PERIOD, precip: 73 }]] }));
    expect(decoded.periods[0][0].precip).toBe(Math.round(Math.round(73 * 7 / 100) * 100 / 7));
  });

  it("preserves negative temp", () => {
    const decoded = roundTrip(msg({ periods: [[{ ...PERIOD, temp_f: -20 }]] }));
    expect(decoded.periods[0][0].temp_f).toBe(-20);
  });

  it("throws on version mismatch", () => {
    const encoded = messageToString(msg({ version: 99 }));
    expect(() => messageFromString(encoded)).toThrow(/Version mismatch.*v99/);
  });

  it("throws on short message", () => {
    expect(() => messageFromString("abc")).toThrow("Unexpected message length");
  });
});
