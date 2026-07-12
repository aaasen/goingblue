import { describe, it, expect } from "vitest";
import {
  v1MessageToString,
  v1MessageFromString,
  v1EncodeBreakdown,
  V1_VERSION,
  encodeVersion,
  decodeMessage,
  type ForecastMessage,
  type Period,
  type RequestContext,
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

// The decoder derives the period layout from (context, seq) — see layout.ts — so a test
// message must be a canonical layout. Two shapes cover every column test, both anchored so the
// request time equals the FIRST period's start (which lets ctxOf rebuild the request from the
// message's own month/day/hour):
//   daily:  n periods of 24h = an n-day duration at seq n, requested at local midnight.
//   hourly: n periods of 1h  = D = ceil(n/24) days at seq 5D, requested at hour 24D − n, so
//           day 0's partial tail plus the D−1 full days is exactly n periods.
// The context's UTC offset is 0 throughout, so local time == UTC.
function uniformLayout(n: number, hourly: boolean): { durationDays: number; seq: number; hourOfDay: number; stepHours: number } {
  if (hourly) {
    const durationDays = Math.ceil(n / 24);
    return { durationDays, seq: 5 * durationDays, hourOfDay: 24 * durationDays - n, stepHours: 1 };
  }
  return { durationDays: n, seq: n, hourOfDay: 0, stepHours: 24 };
}

function msg(overrides: Partial<ForecastMessage> = {}, opts: { hourly?: boolean } = {}): ForecastMessage {
  const models_mask = overrides.models_mask ?? 0b001;
  const nModels = popcount(models_mask);
  const periods = overrides.periods ?? Array.from({ length: nModels }, () => Array(3).fill(PERIOD));
  const n = periods[0].length;
  const { durationDays, seq, hourOfDay, stepHours } = uniformLayout(n, opts.hourly ?? false);
  return {
    version: V1_VERSION,
    code: 0,
    days: durationDays,
    models_mask,
    vars_mask: ALL_VARS,
    month: 5,
    day: 20,
    hour: hourOfDay,
    lat: 63.135,
    lon: -150.989,
    elevation: 500,
    seq,
    durationDays,
    periodHours: Array(n).fill(stepHours),
    ...overrides,
    periods,
  };
}

// The slim response omits lat/lon/model/vars/duration and the request datetime; the decoder
// recovers them by code. The model is the lowest set bit of models_mask; the request time is
// built (UTC) from m/d/h — valid because msg() anchors the request at the first period's start.
const ctxOf = (m: ForecastMessage): RequestContext => ({
  model: 31 - Math.clz32(m.models_mask & -m.models_mask),
  vars_mask: m.vars_mask,
  lat: m.lat,
  lon: m.lon,
  start: Date.UTC(new Date().getUTCFullYear(), m.month - 1, m.day, m.hour),
  durationDays: m.durationDays,
  utcOffsetHours: 0,
});
const noCtx = (): RequestContext | undefined => undefined;

function roundTrip(m: ForecastMessage): ForecastMessage {
  return v1MessageFromString(v1MessageToString(m), () => ctxOf(m));
}

describe("v1 round-trip encoding", () => {
  it("preserves header fields", () => {
    // 3 daily periods → a 3-day duration at seq 3; single model
    const original = msg({ models_mask: 0b001, month: 1, day: 31 });
    const decoded = roundTrip(original);
    expect(decoded.version).toBe(V1_VERSION);
    expect(decoded.days).toBe(3);
    expect(decoded.seq).toBe(3);
    expect(decoded.durationDays).toBe(3);
    expect(decoded.periodHours).toEqual([24, 24, 24]);
    expect(decoded.models_mask).toBe(0b001);
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

  it("handles every resolution stage of the fill sequence", () => {
    // A 2-day duration requested at midnight (msg() anchors daily layouts there): each stage
    // boundary seq = (stage + 1) × D is the whole window at one resolution.
    const D = 2;
    const stageHours = [24, 12, 6, 3, 1];
    for (let stage = 0; stage <= 4; stage++) {
      const seq = (stage + 1) * D;
      const n = D * (24 / stageHours[stage]);
      const decoded = roundTrip(msg({
        seq, durationDays: D, hour: 0,
        periodHours: Array(n).fill(stageHours[stage]),
        periods: [Array(n).fill(PERIOD)],
      }));
      expect(decoded.seq).toBe(seq);
      expect(decoded.days).toBe(2);
      expect(decoded.periodHours).toEqual(Array(n).fill(stageHours[stage]));
      expect(decoded.periods[0]).toHaveLength(n);
    }
  });

  it("round-trips a partial FIRST day (hourly layout anchored mid-day)", () => {
    // 10 hourly periods → a 1-day duration requested at 14:00: periods run 14:00–24:00.
    const decoded = roundTrip(msg({ periods: [Array(10).fill(PERIOD)] }, { hourly: true }));
    expect(decoded.periods[0]).toHaveLength(10);
    expect(decoded.days).toBe(1);
    expect(decoded.hour).toBe(14);
    expect(decoded.periodHours).toEqual(Array(10).fill(1));
  });

  it("round-trips each of the four model indices (single model per response)", () => {
    for (let idx = 0; idx < 4; idx++) {
      const decoded = roundTrip(msg({ models_mask: 1 << idx, periods: [Array(5).fill(PERIOD)] }));
      expect(decoded.models_mask).toBe(1 << idx);
      expect(decoded.periods).toHaveLength(1);
      expect(decoded.periods[0]).toHaveLength(5);
      expect(decoded.days).toBe(5);
    }
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

  it("encodes a near-constant freeze-level column smaller than a wide-swinging one (Huffman-coded deltas)", () => {
    const vars_mask = 1 << VARS_BIT.freeze;
    const flat = Array.from({ length: 64 }, () => ({ ...PERIOD, freeze_m: 6 * 304.8 }));
    const swings = Array.from({ length: 64 }, (_, i) => ({ ...PERIOD, freeze_m: (i % 2 === 0 ? 2 : 13) * 304.8 }));
    const flatLen = v1MessageToString(msg({ vars_mask, periods: [flat] }, { hourly: true })).length;
    const swingsLen = v1MessageToString(msg({ vars_mask, periods: [swings] }, { hourly: true })).length;
    expect(flatLen).toBeLessThan(swingsLen);
  });

  it("freeze reports no adaptive mode — it's Huffman-coded deltas, not raw/for/sparse/empty columns", () => {
    const vars_mask = 1 << VARS_BIT.freeze;
    const periods = [Array.from({ length: 8 }, () => ({ ...PERIOD, freeze_m: 6 * 304.8 }))];
    const { columns } = v1EncodeBreakdown(msg({ vars_mask, periods }, { hourly: true }));
    expect(columns.find((c) => c.name === "freeze")?.mode).toBeNull();
  });

  const CLOUD_LEVELS = [
    { field: "cloud_high" as const, bit: VARS_BIT.cch, name: "cch" },
    { field: "cloud_mid" as const, bit: VARS_BIT.ccm, name: "ccm" },
    { field: "cloud_low" as const, bit: VARS_BIT.ccl, name: "ccl" },
  ];

  it.each(CLOUD_LEVELS)("encodes a near-constant $field column smaller than a wide-swinging one (Huffman-coded deltas)", ({ field, bit }) => {
    const vars_mask = 1 << bit;
    const flat = Array.from({ length: 64 }, () => ({ ...PERIOD, [field]: 40 }));
    const swings = Array.from({ length: 64 }, (_, i) => ({ ...PERIOD, [field]: i % 2 === 0 ? 0 : 100 }));
    const flatLen = v1MessageToString(msg({ vars_mask, periods: [flat] }, { hourly: true })).length;
    const swingsLen = v1MessageToString(msg({ vars_mask, periods: [swings] }, { hourly: true })).length;
    expect(flatLen).toBeLessThan(swingsLen);
  });

  it.each(CLOUD_LEVELS)("$name reports no adaptive mode — it's Huffman-coded deltas, not raw/for/sparse/empty columns", ({ field, bit, name }) => {
    const vars_mask = 1 << bit;
    const periods = [Array.from({ length: 8 }, () => ({ ...PERIOD, [field]: 40 }))];
    const { columns } = v1EncodeBreakdown(msg({ vars_mask, periods }, { hourly: true }));
    expect(columns.find((c) => c.name === name)?.mode).toBeNull();
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
    expect(() => v1MessageFromString(reTagged, noCtx)).toThrow(/Version mismatch.*v3/);
  });

  it("dispatches an unknown version to a clear error", () => {
    const encoded = v1MessageToString(msg());
    const reTagged = encodeVersion(7) + encoded.slice(1);
    expect(() => decodeMessage(reTagged, noCtx)).toThrow(/Unsupported protocol version: v7/);
  });

  it("throws on short message", () => {
    // Valid v1 tag but no room for the header.
    expect(() => v1MessageFromString(encodeVersion(V1_VERSION) + "abc", noCtx)).toThrow("Unexpected message length");
  });

  it("throws when the message code can't be resolved", () => {
    const encoded = v1MessageToString(msg({ code: 5 }));
    expect(() => v1MessageFromString(encoded, () => undefined)).toThrow(/Unknown forecast code 5/);
  });

  it("round-trips the message code", () => {
    const decoded = roundTrip(msg({ code: 99 }));
    expect(decoded.code).toBe(99);
  });

  it("round-trips a minimal weathercode-only, all-clear message (self-delimiting body)", () => {
    // vars_mask=0 leaves only the weathercode column; all-clear may pack to a near-empty body,
    // exercising the little-endian self-terminating path (trailing zero bits dropped).
    const clear = Array.from({ length: 8 }, () => ({ weathercode: 0 }));
    const decoded = roundTrip(msg({ vars_mask: 0, periods: [clear] }));
    expect(decoded.periods[0]).toHaveLength(8);
    decoded.periods[0].forEach((p) => expect(p.weathercode).toBe(0));
  });

  // Surface wind speed is an anchor + entropy-coded period-over-period delta (like temp/tmin);
  // direction is entropy-coded under (resolution, prev, upper-level) context, with calm periods
  // carrying no direction symbol at all.
  const WIND_STEP = 5 * 1.609344;
  const windMsg = (periods: Period[]) =>
    msg({ vars_mask: 1 << VARS_BIT.wind, periods: [periods] }, { hourly: true });

  it("round-trips varied surface wind speeds (entropy-coded deltas) and directions", () => {
    const steps = [3, 5, 4, 6, 7, 4, 5, 3, 6, 5];
    const dirs = [0, 1, 2, 3, 4, 5, 6, 7, 0, 1];
    const periods = steps.map((s, i) => ({ weathercode: 0, wind_sfc_kph: s * WIND_STEP, wind_sfc_dir: dirs[i] }));
    const decoded = roundTrip(windMsg(periods));
    decoded.periods[0].forEach((p, i) => {
      expect(p.wind_sfc_kph).toBeCloseTo(steps[i] * WIND_STEP, 3);
      expect(p.wind_sfc_dir).toBe(dirs[i]);
    });
  });

  it("round-trips calm surface wind (all-zero speed)", () => {
    const periods = Array.from({ length: 24 }, () => ({ weathercode: 0, wind_sfc_kph: 0, wind_sfc_dir: 0 }));
    const decoded = roundTrip(windMsg(periods));
    decoded.periods[0].forEach((p) => { expect(p.wind_sfc_kph).toBe(0); expect(p.wind_sfc_dir).toBe(0); });
  });

  it("encodes a near-constant surface wind speed column smaller than a wide-swinging one", () => {
    const flat = Array.from({ length: 64 }, () => ({ weathercode: 0, wind_sfc_kph: 7 * WIND_STEP, wind_sfc_dir: 0 }));
    const swings = Array.from({ length: 64 }, (_, i) => ({ weathercode: 0, wind_sfc_kph: (i % 2 === 0 ? 2 : 13) * WIND_STEP, wind_sfc_dir: 0 }));
    expect(v1MessageToString(windMsg(flat)).length).toBeLessThan(v1MessageToString(windMsg(swings)).length);
  });

  it("wind speed reports no adaptive mode — it's entropy-coded deltas, not raw/for/sparse/empty columns", () => {
    const periods = [Array.from({ length: 8 }, () => ({ weathercode: 0, wind_sfc_kph: 5 * WIND_STEP, wind_sfc_dir: 0 }))];
    const { columns } = v1EncodeBreakdown(windMsg(periods[0]));
    expect(columns.find((c) => c.name === "wind")?.mode).toBeNull();
  });

  it("round-trips wind speeds above the old 75 mph cap (5-bit domain, up to 155 mph)", () => {
    const periods = [[
      { ...PERIOD, wind_500_kph: 24 * WIND_STEP },  // 120 mph
      { ...PERIOD, wind_500_kph: 28 * WIND_STEP },  // 140 mph
      { ...PERIOD, wind_500_kph: 31 * WIND_STEP },  // 155 mph (domain max)
    ]];
    const decoded = roundTrip(msg({ periods }, { hourly: true }));
    expect(decoded.periods[0][0].wind_500_kph).toBeCloseTo(24 * WIND_STEP, 3);
    expect(decoded.periods[0][1].wind_500_kph).toBeCloseTo(28 * WIND_STEP, 3);
    expect(decoded.periods[0][2].wind_500_kph).toBeCloseTo(31 * WIND_STEP, 3);
  });

  it("clamps wind speed at 155 mph", () => {
    const decoded = roundTrip(msg({ periods: [[{ ...PERIOD, wind_700_kph: 40 * WIND_STEP }]] }));
    expect(decoded.periods[0][0].wind_700_kph).toBeCloseTo(31 * WIND_STEP, 3);
  });

  it("calm periods carry no direction bits: direction values during calm can't change the encoding", () => {
    const dirsA = [3, 0, 0, 0, 5];
    const dirsB = [3, 7, 1, 4, 5]; // differs only where the wind is calm
    const speeds = [4, 0, 0, 0, 6];
    const build = (dirs: number[]) =>
      windMsg(speeds.map((s, i) => ({ weathercode: 0, wind_sfc_kph: s * WIND_STEP, wind_sfc_dir: dirs[i] })));
    expect(v1MessageToString(build(dirsA))).toBe(v1MessageToString(build(dirsB)));
  });

  it("calm periods display the last decoded direction (0 before any)", () => {
    const speeds = [0, 4, 0, 0, 6, 0];
    const dirs = [7, 3, 7, 7, 5, 7]; // calm-period values are noise the encoder must ignore
    const decoded = roundTrip(windMsg(speeds.map((s, i) => ({ weathercode: 0, wind_sfc_kph: s * WIND_STEP, wind_sfc_dir: dirs[i] }))));
    expect(decoded.periods[0].map((p) => p.wind_sfc_dir)).toEqual([0, 3, 3, 3, 5, 5]);
    expect(decoded.periods[0].map((p) => p.wind_sfc_kph! / WIND_STEP)).toEqual(speeds);
  });

  it("round-trips w600 without w500 present (no upper-level context available)", () => {
    const vars_mask = 1 << VARS_BIT.w600;
    const steps = [10, 12, 11, 13, 12];
    const dirs = [2, 2, 3, 3, 4];
    const periods = [steps.map((s, i) => ({ weathercode: 0, wind_600_kph: s * WIND_STEP, wind_600_dir: dirs[i] }))];
    const decoded = roundTrip(msg({ vars_mask, periods }, { hourly: true }));
    decoded.periods[0].forEach((p, i) => {
      expect(p.wind_600_kph).toBeCloseTo(steps[i] * WIND_STEP, 3);
      expect(p.wind_600_dir).toBe(dirs[i]);
    });
  });

  it("an upper level that agrees makes the lower direction column cheaper (cross-level context)", () => {
    // w500+w600 both steady W vs w600 alone steady W: with the upper column present, the joint
    // message's w600 model cost must undercut the standalone one. A uniform 6h layout: 16 days
    // at stage 2 (seq = 3D), requested at midnight → 64 periods.
    const n = 64;
    const sixHourly: Partial<ForecastMessage> = {
      seq: 48, durationDays: 16, hour: 0, periodHours: Array(n).fill(6),
    };
    const both = msg({ ...sixHourly, vars_mask: (1 << VARS_BIT.w500) | (1 << VARS_BIT.w600),
      periods: [Array.from({ length: n }, () => ({ weathercode: 0, wind_500_kph: 20 * WIND_STEP, wind_500_dir: 6, wind_600_kph: 15 * WIND_STEP, wind_600_dir: 6 }))] });
    const alone = msg({ ...sixHourly, vars_mask: 1 << VARS_BIT.w600,
      periods: [Array.from({ length: n }, () => ({ weathercode: 0, wind_600_kph: 15 * WIND_STEP, wind_600_dir: 6 }))] });
    const w600Bits = (m: ForecastMessage) =>
      v1EncodeBreakdown(m).columns.find((c) => c.name === "w600")!.bits;
    expect(w600Bits(both)).toBeLessThan(w600Bits(alone));
  });
});

describe("delta temperature encoding", () => {
  it("round-trips a clustered temperature column exactly", () => {
    const temps = [-5, -4, -3, 0, 2, 5, 3, 1, -2, 4];
    const periods = [temps.map((t) => ({ ...PERIOD, temp_c: t }))];
    const decoded = roundTrip(msg({ vars_mask: 1 << VARS_BIT.temp, periods }, { hourly: true }));
    decoded.periods[0].forEach((p, i) => expect(p.temp_c).toBe(temps[i]));
  });

  it("encodes a constant column smaller than a wide-spread one (FOR offset width)", () => {
    const vars_mask = 1 << VARS_BIT.temp;
    const flat = Array.from({ length: 64 }, () => ({ ...PERIOD, temp_c: 5 }));
    const spread = Array.from({ length: 64 }, (_, i) => ({ ...PERIOD, temp_c: i - 20 }));
    const flatLen = v1MessageToString(msg({ vars_mask, periods: [flat] }, { hourly: true })).length;
    const spreadLen = v1MessageToString(msg({ vars_mask, periods: [spread] }, { hourly: true })).length;
    expect(flatLen).toBeLessThan(spreadLen);
  });

  it("temp and tmin report no adaptive mode — they're Huffman-coded deltas, not raw/for/sparse/empty columns", () => {
    const vars_mask = (1 << VARS_BIT.temp) | (1 << VARS_BIT.tmin);
    const periods = [Array.from({ length: 8 }, () => ({ ...PERIOD, temp_c: 0, temp_min_c: 0 }))];
    const { columns } = v1EncodeBreakdown(msg({ vars_mask, periods }, { hourly: true }));
    expect(columns.find((c) => c.name === "temp")?.mode).toBeNull();
    expect(columns.find((c) => c.name === "tmin")?.mode).toBeNull();
  });

  it("round-trips a clustered tmin column exactly", () => {
    const temps = [-8, -6, -5, -2, 0, 3, 1, -1, -4, 2];
    const periods = [temps.map((t) => ({ ...PERIOD, temp_min_c: t }))];
    const decoded = roundTrip(msg({ vars_mask: 1 << VARS_BIT.tmin, periods }, { hourly: true }));
    decoded.periods[0].forEach((p, i) => expect(p.temp_min_c).toBe(temps[i]));
  });

  it("round-trips a >31°C period-over-period swing at the escape field's edge exactly", () => {
    // ±31 is the largest delta the escape payload can carry — no clamping yet.
    const temps = [-15, 16, 14, 15, -16, -14];
    const periods = [temps.map((t) => ({ ...PERIOD, temp_c: t }))];
    const decoded = roundTrip(msg({ vars_mask: 1 << VARS_BIT.temp, periods }, { hourly: true }));
    decoded.periods[0].forEach((p, i) => expect(p.temp_c).toBe(temps[i]));
  });

  it("clamps a delta beyond the escape range and heals on the next period instead of offsetting the rest of the chain", () => {
    // -30 → +10 is a +40 delta, beyond the escape payload's range (-32..31, signed 6-bit). The
    // encoder clamps that one delta but diffs later periods against its own reconstruction, so
    // only the swing period is off (by the clamped amount) and everything after it round-trips
    // exactly.
    for (const swing of [40, -40]) {
      const start = swing > 0 ? -30 : 30;
      const temps = [start, start + swing, start + swing + 2, start + swing + 1, start + swing + 3];
      const periods = [temps.map((t) => ({ ...PERIOD, temp_c: t }))];
      const decoded = roundTrip(msg({ vars_mask: 1 << VARS_BIT.temp, periods }, { hourly: true }));
      const out = decoded.periods[0].map((p) => p.temp_c!);
      expect(out[0]).toBe(temps[0]);
      expect(out[1]).toBe(start + Math.min(Math.max(swing, -32), 31)); // clamped
      for (let i = 2; i < temps.length; i++) expect(out[i]).toBe(temps[i]); // healed
    }
  });
});

describe("body decode desync detection", () => {
  it("throws when meaningful body bits remain past the last column read (e.g. context-store drift)", () => {
    // Vary the last-decoded column (700 hPa wind) so its bits are guaranteed non-zero — set bits
    // at the top of the body survive encodeBodyLE's high-order-zero trimming.
    const periods = [[
      { ...PERIOD, wind_700_dir: 2 },
      { ...PERIOD, wind_700_dir: 5 },
      { ...PERIOD, wind_700_dir: 7 },
    ]];
    const m = msg({ periods }, { hourly: true });
    const encoded = v1MessageToString(m);
    // Resolve with a vars_mask missing that final column: the decoder reads every earlier column
    // identically, then stops with the wind-700 bits unread — the shape of codebook or
    // request-store drift, which would otherwise return garbage values silently.
    const drifted = { ...ctxOf(m), vars_mask: m.vars_mask & ~(1 << VARS_BIT.w700) };
    expect(() => v1MessageFromString(encoded, () => drifted)).toThrow(/desynced/);
    // The same message with the true context still decodes.
    expect(() => v1MessageFromString(encoded, () => ctxOf(m))).not.toThrow();
  });
});

describe("sparse / empty precipitation encoding", () => {
  const vars_mask = 1 << VARS_BIT.snow;

  it("collapses an all-dry snow column (empty mode) and round-trips to zero", () => {
    const dry = Array.from({ length: 48 }, () => ({ ...PERIOD, snow_cm: 0 }));
    const decoded = roundTrip(msg({ vars_mask, periods: [dry] }, { hourly: true }));
    decoded.periods[0].forEach((p) => expect(p.snow_cm).toBe(0));
    // The empty column should be smaller than one with snow every period. Compare exact body
    // bits (not the base-85 encoded char length) since a few bits of savings can land on either
    // side of a char boundary and not move the visible string length.
    const snowy = Array.from({ length: 48 }, () => ({ ...PERIOD, snow_cm: 20 }));
    const dryBits = v1EncodeBreakdown(msg({ vars_mask, periods: [dry] }, { hourly: true })).bodyBits;
    const snowyBits = v1EncodeBreakdown(msg({ vars_mask, periods: [snowy] }, { hourly: true })).bodyBits;
    expect(dryBits).toBeLessThan(snowyBits);
  });

  it("round-trips a mostly-zero snow column exactly (sparse mode)", () => {
    const vals = Array.from({ length: 48 }, (_, i) => (i % 12 === 0 ? 10 : 0));
    const periods = [vals.map((s) => ({ ...PERIOD, snow_cm: s }))];
    const decoded = roundTrip(msg({ vars_mask, periods }, { hourly: true }));
    decoded.periods[0].forEach((p, i) => expect(p.snow_cm).toBeCloseTo(qSnow(vals[i]), 5));
    // Sparse beats a column where every cell is nonzero and widely spread (≈ raw cost).
    const dense = Array.from({ length: 48 }, (_, i) => ({ ...PERIOD, snow_cm: 3 * (i + 1) }));
    const sparseLen = v1MessageToString(msg({ vars_mask, periods }, { hourly: true })).length;
    const denseLen = v1MessageToString(msg({ vars_mask, periods: [dense] }, { hourly: true })).length;
    expect(sparseLen).toBeLessThan(denseLen);
  });
});
