import { describe, it, expect } from "vitest";
import {
  v1MessageToString,
  v1MessageFromString,
  V1_VERSION,
  encodeVersion,
  decodeMessage,
  type ForecastMessage,
  type Period,
  CARDINALS,
  DEFAULT_VARS_MASK,
  VARS_BIT,
  compandSqrt,
  expandSqrt,
  ACCUM_BITS,
  SNOW_K,
  RAIN_K,
} from "../src/index.js";

// Reproduce what the codec stores for a sqrt-companded accumulation, so round-trip
// expectations track the quantization exactly rather than the raw input.
const qSnow = (cm: number) => expandSqrt(compandSqrt(cm, SNOW_K, ACCUM_BITS), SNOW_K);
const qRain = (mm: number) => expandSqrt(compandSqrt(mm, RAIN_K, ACCUM_BITS), RAIN_K);

// Every v1 variable (bit 12 is `rain`, 6-bit liquid precip).
const ALL_VARS =
  (1 << 0) | (1 << 1) | (1 << 2) | (1 << 3) | (1 << 4) | (1 << 5) | (1 << 6) | (1 << 7) |
  (1 << 8) | (1 << 9) | (1 << 10) | (1 << 11) | (1 << 12) | (1 << 13);

const RESOLUTIONS_PER_DAY = [1, 2, 4, 8, 24];

const PERIOD: Period = {
  weathercode: 73,
  precip: 75,
  temp_c: 0,
  temp_min_c: -20,
  snow_cm: 4 * 2.54,       // ~10cm — sqrt-companded, compared via qSnow()
  rain_mm: 6.5,            // sqrt-companded, compared via qRain()
  freeze_m: 6 * 304.8,     // 6000 ft in m — round-trips exactly
  wind_sfc_kph: 10 * 1.609344,
  wind_sfc_dir: 2,
  wind_500_kph: 30 * 1.609344,
  wind_500_dir: 4,
  wind_600_kph: 25 * 1.609344,
  wind_600_dir: 3,
  wind_700_kph: 15 * 1.609344,
  wind_700_dir: 2,
  cloud_total: 80,
  cloud_high: 60,
  cloud_mid: 40,
  cloud_low: 20,
};

function popcount(n: number): number {
  let c = 0;
  while (n) { c += n & 1; n >>>= 1; }
  return c;
}

// v1's header carries a period count, so `days` is derived on decode as ceil(nPeriods /
// periodsPerDay). This helper keeps the input self-consistent for whole-day period counts.
function msg(overrides: Partial<ForecastMessage> = {}): ForecastMessage {
  const resolution = overrides.resolution ?? 0;
  const models_mask = overrides.models_mask ?? 0b001;
  const nModels = popcount(models_mask);
  const periodsPerDay = RESOLUTIONS_PER_DAY[resolution];
  const defaultPeriods = Array.from({ length: nModels }, () =>
    Array(3 * periodsPerDay).fill(PERIOD),
  );
  const periods = overrides.periods ?? defaultPeriods;
  const days = Math.ceil(periods[0].length / periodsPerDay);
  return {
    version: V1_VERSION,
    resolution,
    models_mask,
    vars_mask: ALL_VARS,
    month: 5,
    day: 20,
    hour: 0,
    lat: 63.135,
    lon: -150.989,
    elevation: 500,
    ...overrides,
    days,
    periods,
  };
}

function roundTrip(m: ForecastMessage): ForecastMessage {
  return v1MessageFromString(v1MessageToString(m));
}

describe("v1 round-trip encoding", () => {
  it("preserves header fields", () => {
    // resolution=2 (6h) → 4 periods/day; 3 days → 12 periods per model; 2 models
    const original = msg({ resolution: 2, models_mask: 0b011, month: 1, day: 31, hour: 0 });
    const decoded = roundTrip(original);
    expect(decoded.version).toBe(V1_VERSION);
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

  it("preserves all period fields", () => {
    const decoded = roundTrip(msg());
    const p = decoded.periods[0][0];
    expect(p.weathercode).toBe(PERIOD.weathercode);
    expect(p.precip).toBe(Math.round(Math.round((PERIOD.precip ?? 0) * 7 / 100) * 100 / 7));
    expect(p.temp_c).toBe(PERIOD.temp_c);
    expect(p.temp_min_c).toBe(PERIOD.temp_min_c);
    expect(p.snow_cm).toBeCloseTo(qSnow(PERIOD.snow_cm!), 5);
    expect(p.rain_mm).toBeCloseTo(qRain(PERIOD.rain_mm!), 5);
    expect(p.freeze_m).toBeCloseTo(PERIOD.freeze_m!, 5);
    expect(p.wind_sfc_kph).toBeCloseTo(PERIOD.wind_sfc_kph!, 3);
    expect(p.wind_sfc_dir).toBe(PERIOD.wind_sfc_dir);
    expect(p.wind_500_kph).toBeCloseTo(PERIOD.wind_500_kph!, 3);
    expect(p.wind_500_dir).toBe(PERIOD.wind_500_dir);
    expect(p.wind_600_kph).toBeCloseTo(PERIOD.wind_600_kph!, 3);
    expect(p.wind_600_dir).toBe(PERIOD.wind_600_dir);
    expect(p.wind_700_kph).toBeCloseTo(PERIOD.wind_700_kph!, 3);
    expect(p.wind_700_dir).toBe(PERIOD.wind_700_dir);
    // cloud cover is quantized to 3 bits (0–7 steps), decoded back to nearest %
    expect(p.cloud_total).toBe(Math.round(Math.round((PERIOD.cloud_total ?? 0) * 7 / 100) * 100 / 7));
    expect(p.cloud_high).toBe(Math.round(Math.round((PERIOD.cloud_high   ?? 0) * 7 / 100) * 100 / 7));
    expect(p.cloud_mid).toBe(Math.round(Math.round((PERIOD.cloud_mid     ?? 0) * 7 / 100) * 100 / 7));
    expect(p.cloud_low).toBe(Math.round(Math.round((PERIOD.cloud_low     ?? 0) * 7 / 100) * 100 / 7));
  });

  it("omits all optional fields when vars_mask=0", () => {
    const decoded = roundTrip(msg({ vars_mask: 0 }));
    const p = decoded.periods[0][0];
    expect(p.precip).toBeUndefined();
    expect(p.temp_c).toBeUndefined();
    expect(p.temp_min_c).toBeUndefined();
    expect(p.snow_cm).toBeUndefined();
    expect(p.rain_mm).toBeUndefined();
    expect(p.freeze_m).toBeUndefined();
    expect(p.wind_sfc_kph).toBeUndefined();
    expect(p.wind_500_kph).toBeUndefined();
    expect(p.cloud_total).toBeUndefined();
    expect(p.cloud_high).toBeUndefined();
  });

  it("only includes selected vars", () => {
    const varsMask = (1 << VARS_BIT.precip) | (1 << VARS_BIT.freeze);
    const decoded = roundTrip(msg({ vars_mask: varsMask }));
    const p = decoded.periods[0][0];
    expect(p.precip).toBe(Math.round(Math.round(75 * 7 / 100) * 100 / 7));
    expect(p.freeze_m).toBeCloseTo(6 * 304.8, 5);
    expect(p.temp_c).toBeUndefined();
    expect(p.temp_min_c).toBeUndefined();
    expect(p.snow_cm).toBeUndefined();
    expect(p.wind_500_kph).toBeUndefined();
  });

  it("temp and tmin are independent bits", () => {
    const maxOnly = roundTrip(msg({ vars_mask: 1 << VARS_BIT.temp }));
    expect(maxOnly.periods[0][0].temp_c).toBe(PERIOD.temp_c);
    expect(maxOnly.periods[0][0].temp_min_c).toBeUndefined();

    const minOnly = roundTrip(msg({ vars_mask: 1 << VARS_BIT.tmin }));
    expect(minOnly.periods[0][0].temp_min_c).toBe(PERIOD.temp_min_c);
    expect(minOnly.periods[0][0].temp_c).toBeUndefined();
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

  it("round-trips a partial final day (period count, not whole days)", () => {
    // 6h resolution (4 periods/day) with 10 periods → 2.5 days, rounded up to 3 on decode.
    const decoded = roundTrip(msg({ resolution: 2, periods: [Array(10).fill(PERIOD)] }));
    expect(decoded.periods[0]).toHaveLength(10);
    expect(decoded.days).toBe(3);
  });

  it("round-trips with non-zero start hour", () => {
    const nPeriods = 2 * 4; // 2 days * 4 periods/day
    const decoded = roundTrip(msg({ resolution: 2, hour: 6, periods: [Array(nPeriods).fill(PERIOD)] }));
    expect(decoded.hour).toBe(6);
    expect(decoded.days).toBe(2);
    expect(decoded.periods[0]).toHaveLength(nPeriods);
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
    const decoded = roundTrip(msg({ periods: [[{ ...PERIOD, wind_700_kph: 27 * 1.609344 }]] }));
    expect(decoded.periods[0][0].wind_700_kph).toBeCloseTo(25 * 1.609344, 3);
  });

  it("clamps snow to 200 cm max", () => {
    const decoded = roundTrip(msg({ periods: [[{ ...PERIOD, snow_cm: 300 }]] }));
    expect(decoded.periods[0][0].snow_cm).toBeCloseTo(200, 3);
  });

  it("keeps fine resolution for light snow (sqrt companding)", () => {
    // a 1 cm dusting round-trips to well within half a cm
    const decoded = roundTrip(msg({ periods: [[{ ...PERIOD, snow_cm: 1 }]] }));
    expect(decoded.periods[0][0].snow_cm).toBeCloseTo(1, 0);
  });

  it("clamps rain to 144 mm max", () => {
    const decoded = roundTrip(msg({ periods: [[{ ...PERIOD, rain_mm: 200 }]] }));
    expect(decoded.periods[0][0].rain_mm).toBeCloseTo(144, 3);
  });

  it("keeps fine resolution for light rain (sqrt companding)", () => {
    // light drizzle near 1 mm round-trips to well within half a mm
    const decoded = roundTrip(msg({ periods: [[{ ...PERIOD, rain_mm: 1 }]] }));
    expect(decoded.periods[0][0].rain_mm).toBeCloseTo(1, 0);
  });

  it("clamps freeze level to 15,000 ft max (4572 m)", () => {
    const decoded = roundTrip(msg({ periods: [[{ ...PERIOD, freeze_m: 20000 * 0.3048 }]] }));
    expect(decoded.periods[0][0].freeze_m).toBeCloseTo(15 * 304.8, 5);
  });

  it("rounds precip to nearest 3-bit step", () => {
    const decoded = roundTrip(msg({ periods: [[{ ...PERIOD, precip: 73 }]] }));
    expect(decoded.periods[0][0].precip).toBe(Math.round(Math.round(73 * 7 / 100) * 100 / 7));
  });

  it("preserves negative temp", () => {
    const decoded = roundTrip(msg({ periods: [[{ ...PERIOD, temp_c: -20, temp_min_c: -35 }]] }));
    expect(decoded.periods[0][0].temp_c).toBe(-20);
    expect(decoded.periods[0][0].temp_min_c).toBe(-35);
  });

  it("throws when decoding a different version's tag", () => {
    // Swap the self-describing version prefix to v3; the v1 codec must reject it.
    const encoded = v1MessageToString(msg());
    const reTagged = encodeVersion(3) + encoded.slice(1);
    expect(() => v1MessageFromString(reTagged)).toThrow(/Version mismatch.*v3/);
  });

  it("dispatches an unknown version to a clear error", () => {
    const encoded = v1MessageToString(msg());
    const reTagged = encodeVersion(7) + encoded.slice(1);
    expect(() => decodeMessage(reTagged)).toThrow(/Unsupported protocol version: v7/);
  });

  it("throws on short message", () => {
    // Valid v1 tag but no room for the header.
    expect(() => v1MessageFromString(encodeVersion(V1_VERSION) + "abc")).toThrow("Unexpected message length");
  });

  it("round-trips a minimal weathercode-only, all-clear message (self-delimiting body)", () => {
    // vars_mask=0 leaves only the weathercode column; all-clear may pack to a near-empty body,
    // exercising the little-endian self-terminating path (trailing zero bits dropped).
    const clear = Array.from({ length: 8 }, () => ({ weathercode: 0 }));
    const decoded = roundTrip(msg({ vars_mask: 0, periods: [clear] }));
    expect(decoded.periods[0]).toHaveLength(8);
    decoded.periods[0].forEach((p) => expect(p.weathercode).toBe(0));
  });
});

describe("frame-of-reference temperature encoding", () => {
  it("round-trips a clustered temperature column exactly", () => {
    const temps = [-5, -4, -3, 0, 2, 5, 3, 1, -2, 4];
    const periods = [temps.map((t) => ({ ...PERIOD, temp_c: t }))];
    const decoded = roundTrip(msg({ resolution: 4, vars_mask: 1 << VARS_BIT.temp, periods }));
    decoded.periods[0].forEach((p, i) => expect(p.temp_c).toBe(temps[i]));
  });

  it("encodes a constant column smaller than a wide-spread one (adaptive width)", () => {
    const vars_mask = 1 << VARS_BIT.temp;
    const flat = Array.from({ length: 64 }, () => ({ ...PERIOD, temp_c: 5 }));
    const spread = Array.from({ length: 64 }, (_, i) => ({ ...PERIOD, temp_c: i - 20 }));
    const flatLen = v1MessageToString(msg({ resolution: 4, vars_mask, periods: [flat] })).length;
    const spreadLen = v1MessageToString(msg({ resolution: 4, vars_mask, periods: [spread] })).length;
    expect(flatLen).toBeLessThan(spreadLen);
  });
});

describe("sparse / empty precipitation encoding", () => {
  const vars_mask = 1 << VARS_BIT.snow;

  it("collapses an all-dry snow column (empty mode) and round-trips to zero", () => {
    const dry = Array.from({ length: 48 }, () => ({ ...PERIOD, snow_cm: 0 }));
    const decoded = roundTrip(msg({ resolution: 4, vars_mask, periods: [dry] }));
    decoded.periods[0].forEach((p) => expect(p.snow_cm).toBe(0));
    // The empty column should be far smaller than one with snow every period.
    const snowy = Array.from({ length: 48 }, () => ({ ...PERIOD, snow_cm: 20 }));
    const dryLen = v1MessageToString(msg({ resolution: 4, vars_mask, periods: [dry] })).length;
    const snowyLen = v1MessageToString(msg({ resolution: 4, vars_mask, periods: [snowy] })).length;
    expect(dryLen).toBeLessThan(snowyLen);
  });

  it("round-trips a mostly-zero snow column exactly (sparse mode)", () => {
    const vals = Array.from({ length: 48 }, (_, i) => (i % 12 === 0 ? 10 : 0));
    const periods = [vals.map((s) => ({ ...PERIOD, snow_cm: s }))];
    const decoded = roundTrip(msg({ resolution: 4, vars_mask, periods }));
    decoded.periods[0].forEach((p, i) => expect(p.snow_cm).toBeCloseTo(qSnow(vals[i]), 5));
    // Sparse beats a column where every cell is nonzero and widely spread (≈ raw cost).
    const dense = Array.from({ length: 48 }, (_, i) => ({ ...PERIOD, snow_cm: 3 * (i + 1) }));
    const sparseLen = v1MessageToString(msg({ resolution: 4, vars_mask, periods })).length;
    const denseLen = v1MessageToString(msg({ resolution: 4, vars_mask, periods: [dense] })).length;
    expect(sparseLen).toBeLessThan(denseLen);
  });
});
