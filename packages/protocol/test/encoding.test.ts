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
  MODE_DETAIL,
  MODE_RANGE,
  compandSqrt,
  expandSqrt,
  ACCUM_BITS,
  SNOW_K,
  RAIN_K,
  beaufortMidKph,
} from "../src/index.js";

// Wind speeds quantize to extended Beaufort forces; tests express speeds as forces and expect
// the decoded band midpoint. A midpoint input round-trips exactly.
const bmid = beaufortMidKph;

// Reproduce what the codec stores for a sqrt-companded accumulation, so round-trip
// expectations track the quantization exactly rather than the raw input.
const qSnow = (cm: number) => expandSqrt(compandSqrt(cm, SNOW_K, ACCUM_BITS), SNOW_K);
const qRain = (mm: number) => expandSqrt(compandSqrt(mm, RAIN_K, ACCUM_BITS), RAIN_K);

// Every v1 variable (bit 12 is `rain`, 6-bit liquid precip; bit 13, formerly tmin, is reserved).
const ALL_VARS =
  (1 << 0) | (1 << 1) | (1 << 2) | (1 << 3) | (1 << 4) | (1 << 5) | (1 << 6) | (1 << 7) |
  (1 << 8) | (1 << 9) | (1 << 10) | (1 << 11) | (1 << 12);

const PERIOD: Period = {
  weathercode: 73,
  precip: 75,
  temp_c: 0,
  snow_cm: 4 * 2.54,       // ~10cm — sqrt-companded, compared via qSnow()
  rain_mm: 6.5,            // sqrt-companded, compared via qRain()
  freeze_m: 6 * 304.8,     // 6000 ft in m — round-trips exactly
  wind_sfc_kph: 16,        // force 3 midpoint — all wind speeds round-trip as band midpoints
  wind_sfc_dir: 2,
  wind_gust_kph: 34,       // force 5
  wind_500_kph: 44.5,      // force 6
  wind_500_dir: 4,
  wind_600_kph: 34,        // force 5
  wind_600_dir: 3,
  wind_700_kph: 24.5,      // force 4
  wind_700_dir: 2,
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
// message must sit on a mode's fill path. Two uniform shapes cover every column test, both
// anchored so the request time equals the FIRST period's start (which lets ctxOf rebuild the
// request from the message's own month/day/hour):
//   12-hour: n ≤ 26, on Range's pure-12h ramp: s = ceil(n/2) slots at seq = s, requested at
//            hour 24s − 12n ∈ {0, 12}, so the request slot's tail plus the whole days is
//            exactly n periods.
//   hourly:  49 ≤ n ≤ 72 only — the sole all-1h layout on any path is Detail seq 12 (1h×3):
//            n periods requested at hour 72 − n.
// The context's UTC offset is 0 throughout, so local time == UTC.
function uniformLayout(n: number, hourly: boolean): { mode: number; days: number; seq: number; hourOfDay: number; stepHours: number } {
  if (hourly) {
    if (n < 49 || n > 72)
      throw new Error(`no canonical all-1h layout has ${n} periods (Detail 1h×3 spans 49..72)`);
    return { mode: MODE_DETAIL, days: 3, seq: 12, hourOfDay: 72 - n, stepHours: 1 };
  }
  const s = Math.ceil(n / 2);
  if (s > 13) throw new Error(`no pure-12h layout has ${n} periods (the ramp tops at 13 slots)`);
  return { mode: MODE_RANGE, days: s, seq: s, hourOfDay: 24 * s - 12 * n, stepHours: 12 };
}

function msg(overrides: Partial<ForecastMessage> = {}, opts: { hourly?: boolean } = {}): ForecastMessage {
  const models_mask = overrides.models_mask ?? 0b001;
  const nModels = popcount(models_mask);
  const periods = overrides.periods ?? Array.from({ length: nModels }, () => Array(3).fill(PERIOD));
  const n = periods[0].length;
  // Overrides that pin their own seq bring the whole layout with them (mode/days/hour/
  // periodHours) — don't derive one from the period count.
  const { mode, days, seq, hourOfDay, stepHours } = overrides.seq != null
    ? { mode: MODE_RANGE, days: 1, seq: overrides.seq, hourOfDay: 0, stepHours: 12 }
    : uniformLayout(n, opts.hourly ?? false);
  return {
    version: V1_VERSION,
    code: 0,
    days,
    models_mask,
    vars_mask: ALL_VARS,
    month: 5,
    day: 20,
    hour: hourOfDay,
    lat: 63.135,
    lon: -150.989,
    elevation: 500,
    seq,
    mode,
    periodHours: Array(n).fill(stepHours),
    utcOffsetHours: 0,
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
  mode: m.mode,
  utcOffsetHours: 0,
});
const noCtx = (): RequestContext | undefined => undefined;

function roundTrip(m: ForecastMessage): ForecastMessage {
  return v1MessageFromString(v1MessageToString(m), () => ctxOf(m));
}

describe("v1 round-trip encoding", () => {
  it("preserves header fields", () => {
    // Three 12h periods → two slots of Range's ramp at seq 2; single model
    const original = msg({ models_mask: 0b001, month: 1, day: 31 });
    const decoded = roundTrip(original);
    expect(decoded.version).toBe(V1_VERSION);
    expect(decoded.days).toBe(2);
    expect(decoded.seq).toBe(2);
    expect(decoded.mode).toBe(MODE_RANGE);
    expect(decoded.periodHours).toEqual([12, 12, 12]);
    expect(decoded.models_mask).toBe(0b001);
    expect(decoded.vars_mask).toBe(ALL_VARS);
    expect(decoded.month).toBe(1);
    expect(decoded.day).toBe(31);
    expect(decoded.hour).toBe(12);
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
    expect(p.snow_cm).toBeCloseTo(qSnow(PERIOD.snow_cm!), 5);
    expect(p.rain_mm).toBeCloseTo(qRain(PERIOD.rain_mm!), 5);
    expect(p.freeze_m).toBeCloseTo(PERIOD.freeze_m!, 5);
    expect(p.wind_sfc_kph).toBeCloseTo(PERIOD.wind_sfc_kph!, 3);
    expect(p.wind_sfc_dir).toBe(PERIOD.wind_sfc_dir);
    expect(p.wind_gust_kph).toBeCloseTo(PERIOD.wind_gust_kph!, 3);
    expect(p.wind_500_kph).toBeCloseTo(PERIOD.wind_500_kph!, 3);
    expect(p.wind_500_dir).toBe(PERIOD.wind_500_dir);
    expect(p.wind_600_kph).toBeCloseTo(PERIOD.wind_600_kph!, 3);
    expect(p.wind_600_dir).toBe(PERIOD.wind_600_dir);
    expect(p.wind_700_kph).toBeCloseTo(PERIOD.wind_700_kph!, 3);
    expect(p.wind_700_dir).toBe(PERIOD.wind_700_dir);
    // cloud cover is quantized to 3 bits (0–7 steps), decoded back to nearest %
    expect(p.cloud_high).toBe(Math.round(Math.round((PERIOD.cloud_high   ?? 0) * 7 / 100) * 100 / 7));
    expect(p.cloud_mid).toBe(Math.round(Math.round((PERIOD.cloud_mid     ?? 0) * 7 / 100) * 100 / 7));
    expect(p.cloud_low).toBe(Math.round(Math.round((PERIOD.cloud_low     ?? 0) * 7 / 100) * 100 / 7));
  });

  it("omits all optional fields when vars_mask=0", () => {
    const decoded = roundTrip(msg({ vars_mask: 0 }));
    const p = decoded.periods[0][0];
    expect(p.precip).toBeUndefined();
    expect(p.temp_c).toBeUndefined();
    expect(p.snow_cm).toBeUndefined();
    expect(p.rain_mm).toBeUndefined();
    expect(p.freeze_m).toBeUndefined();
    expect(p.wind_sfc_kph).toBeUndefined();
    expect(p.wind_gust_kph).toBeUndefined();
    expect(p.wind_500_kph).toBeUndefined();
    expect(p.cloud_high).toBeUndefined();
  });

  it("only includes selected vars", () => {
    const varsMask = (1 << VARS_BIT.precip) | (1 << VARS_BIT.freeze);
    const decoded = roundTrip(msg({ vars_mask: varsMask }));
    const p = decoded.periods[0][0];
    expect(p.precip).toBe(Math.round(Math.round(75 * 7 / 100) * 100 / 7));
    expect(p.freeze_m).toBeCloseTo(6 * 304.8, 5);
    expect(p.temp_c).toBeUndefined();
    expect(p.snow_cm).toBeUndefined();
    expect(p.wind_500_kph).toBeUndefined();
  });

  it("temp round-trips on its own bit", () => {
    const tempOnly = roundTrip(msg({ vars_mask: 1 << VARS_BIT.temp }));
    expect(tempOnly.periods[0][0].temp_c).toBe(PERIOD.temp_c);
    expect(tempOnly.periods[0][0].precip).toBeUndefined();
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

  it("handles every uniform resolution the paths reach", () => {
    // Requested at midnight so slot 0 is a whole day. Range's breadth-first path passes
    // through the full horizon at 12h/6h/3h (seq 13/26/39 over 13 slots); Detail seq 12 is
    // the all-1h waypoint (1h×3).
    const uniform: { mode: number; seq: number; days: number; stepHours: number }[] = [
      { mode: MODE_RANGE, seq: 13, days: 13, stepHours: 12 },
      { mode: MODE_RANGE, seq: 26, days: 13, stepHours: 6 },
      { mode: MODE_RANGE, seq: 39, days: 13, stepHours: 3 },
      { mode: MODE_DETAIL, seq: 12, days: 3, stepHours: 1 },
    ];
    for (const { mode, seq, days, stepHours } of uniform) {
      const n = days * (24 / stepHours);
      const decoded = roundTrip(msg({
        mode, seq, days, hour: 0,
        periodHours: Array(n).fill(stepHours),
        periods: [Array(n).fill(PERIOD)],
      }));
      expect(decoded.seq).toBe(seq);
      expect(decoded.days).toBe(days);
      expect(decoded.periodHours).toEqual(Array(n).fill(stepHours));
      expect(decoded.periods[0]).toHaveLength(n);
    }
  });

  it("round-trips a partial FIRST day (hourly layout anchored mid-day)", () => {
    // 58 hourly periods → Detail's 1h×3 waypoint requested at 14:00: 14:00–24:00 today, then
    // two whole days.
    const decoded = roundTrip(msg({ periods: [Array(58).fill(PERIOD)] }, { hourly: true }));
    expect(decoded.periods[0]).toHaveLength(58);
    expect(decoded.mode).toBe(MODE_DETAIL);
    expect(decoded.days).toBe(3);
    expect(decoded.hour).toBe(14);
    expect(decoded.periodHours).toEqual(Array(58).fill(1));
  });

  it("round-trips each of the four model indices (single model per response)", () => {
    for (let idx = 0; idx < 4; idx++) {
      const decoded = roundTrip(msg({ models_mask: 1 << idx, periods: [Array(5).fill(PERIOD)] }));
      expect(decoded.models_mask).toBe(1 << idx);
      expect(decoded.periods).toHaveLength(1);
      expect(decoded.periods[0]).toHaveLength(5);
      expect(decoded.days).toBe(3);
    }
  });

  it("quantizes wind speed to Beaufort band midpoints", () => {
    const decoded = roundTrip(msg({ periods: [[{ ...PERIOD, wind_700_kph: 43.4 }]] }));
    expect(decoded.periods[0][0].wind_700_kph).toBeCloseTo(bmid(6), 3); // 39-49 kph band
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

  it("clamps freeze level to 31,000 ft max (9448.8 m)", () => {
    const decoded = roundTrip(msg({ periods: [[{ ...PERIOD, freeze_m: 40000 * 0.3048 }]] }));
    expect(decoded.periods[0][0].freeze_m).toBeCloseTo(31 * 304.8, 5);
  });

  it("carries a tropical freeze level above 15,000 ft without clipping", () => {
    // The corpus tops out near 21,000 ft (the Andes in summer); nothing there may saturate.
    const decoded = roundTrip(msg({ periods: [[{ ...PERIOD, freeze_m: 21 * 304.8 }]] }));
    expect(decoded.periods[0][0].freeze_m).toBeCloseTo(21 * 304.8, 5);
  });

  it("encodes a near-constant freeze-level column smaller than a wide-swinging one (Huffman-coded deltas)", () => {
    const vars_mask = 1 << VARS_BIT.freeze;
    const flat = Array.from({ length: 64 }, () => ({ ...PERIOD, freeze_m: 6 * 304.8 }));
    const swings = Array.from({ length: 64 }, (_, i) => ({ ...PERIOD, freeze_m: (i % 2 === 0 ? 2 : 13) * 304.8 }));
    const flatLen = v1MessageToString(msg({ vars_mask, periods: [flat] }, { hourly: true })).length;
    const swingsLen = v1MessageToString(msg({ vars_mask, periods: [swings] }, { hourly: true })).length;
    expect(flatLen).toBeLessThan(swingsLen);
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

  it("rounds precip to nearest 3-bit step", () => {
    const decoded = roundTrip(msg({ periods: [[{ ...PERIOD, precip: 73 }]] }));
    expect(decoded.periods[0][0].precip).toBe(Math.round(Math.round(73 * 7 / 100) * 100 / 7));
  });

  it("preserves negative temp", () => {
    const decoded = roundTrip(msg({ periods: [[{ ...PERIOD, temp_c: -35 }]] }));
    expect(decoded.periods[0][0].temp_c).toBe(-35);
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

  // Surface wind speed is an anchor + entropy-coded period-over-period delta (like temp);
  // direction is entropy-coded under (resolution, prev, upper-level) context, with calm periods
  // carrying no direction symbol at all.
  // Speeds below are given as bmid(force) — exact band midpoints, which round-trip unchanged.
  // 12h periods: these columns are shorter than the 49 periods any all-1h layout must have (see
  // uniformLayout). The 1h wind path is covered separately below.
  const windMsg = (periods: Period[], opts: { hourly?: boolean } = {}) =>
    msg({ vars_mask: 1 << VARS_BIT.wind, periods: [periods] }, opts);

  it("round-trips varied surface wind speeds (entropy-coded deltas) and directions", () => {
    const forces = [3, 5, 4, 6, 7, 4, 5, 3, 6, 5];
    const dirs = [0, 1, 2, 3, 4, 5, 6, 7, 0, 1];
    const periods = forces.map((f, i) => ({ weathercode: 0, wind_sfc_kph: bmid(f), wind_sfc_dir: dirs[i] }));
    const decoded = roundTrip(windMsg(periods));
    decoded.periods[0].forEach((p, i) => {
      expect(p.wind_sfc_kph).toBeCloseTo(bmid(forces[i]), 3);
      expect(p.wind_sfc_dir).toBe(dirs[i]);
    });
  });

  it("round-trips calm surface wind (all-zero speed)", () => {
    const periods = Array.from({ length: 24 }, () => ({ weathercode: 0, wind_sfc_kph: 0, wind_sfc_dir: 0 }));
    const decoded = roundTrip(windMsg(periods));
    decoded.periods[0].forEach((p) => { expect(p.wind_sfc_kph).toBe(0); expect(p.wind_sfc_dir).toBe(0); });
  });

  it("encodes a near-constant surface wind speed column smaller than a wide-swinging one", () => {
    const flat = Array.from({ length: 64 }, () => ({ weathercode: 0, wind_sfc_kph: bmid(7), wind_sfc_dir: 0 }));
    const swings = Array.from({ length: 64 }, (_, i) => ({ weathercode: 0, wind_sfc_kph: bmid(i % 2 === 0 ? 2 : 13), wind_sfc_dir: 0 }));
    expect(v1MessageToString(windMsg(flat, { hourly: true })).length)
      .toBeLessThan(v1MessageToString(windMsg(swings, { hourly: true })).length);
  });

  it("round-trips surface wind at 1h resolution (the resolution-keyed direction codebook)", () => {
    // Direction is coded under a (resolution, prev, upper-level) context, so the finest
    // resolution needs its own round-trip — 49 periods is the shortest all-1h layout.
    const periods = Array.from({ length: 49 }, (_, i) => ({
      weathercode: 0,
      wind_sfc_kph: bmid(4 + (i % 5)),
      wind_sfc_dir: i % 8,
    }));
    const decoded = roundTrip(
      msg({ vars_mask: 1 << VARS_BIT.wind, periods: [periods] }, { hourly: true }));
    expect(decoded.periodHours).toEqual(Array(49).fill(1));
    decoded.periods[0].forEach((p, i) => {
      expect(p.wind_sfc_kph).toBeCloseTo(bmid(4 + (i % 5)), 3);
      expect(p.wind_sfc_dir).toBe(i % 8);
    });
  });

  it("round-trips hurricane-force jet winds (extended Beaufort, forces 13..17)", () => {
    const periods = [[
      { ...PERIOD, wind_500_kph: bmid(13) },
      { ...PERIOD, wind_500_kph: bmid(15) },
      { ...PERIOD, wind_500_kph: bmid(17) }, // open-ended top band (≥202 kph)
    ]];
    const decoded = roundTrip(msg({ periods }));
    expect(decoded.periods[0][0].wind_500_kph).toBeCloseTo(bmid(13), 3);
    expect(decoded.periods[0][1].wind_500_kph).toBeCloseTo(bmid(15), 3);
    expect(decoded.periods[0][2].wind_500_kph).toBeCloseTo(bmid(17), 3);
  });

  it("clamps wind speed into the top Beaufort band", () => {
    const decoded = roundTrip(msg({ periods: [[{ ...PERIOD, wind_700_kph: 400 }]] }));
    expect(decoded.periods[0][0].wind_700_kph).toBeCloseTo(bmid(17), 3);
  });

  it("calm periods carry no direction bits: direction values during calm can't change the encoding", () => {
    const dirsA = [3, 0, 0, 0, 5];
    const dirsB = [3, 7, 1, 4, 5]; // differs only where the wind is calm
    const forces = [4, 1, 0, 1, 6]; // force ≤ 1 (< 6 kph) is calm for direction purposes
    const build = (dirs: number[]) =>
      windMsg(forces.map((f, i) => ({ weathercode: 0, wind_sfc_kph: bmid(f), wind_sfc_dir: dirs[i] })));
    expect(v1MessageToString(build(dirsA))).toBe(v1MessageToString(build(dirsB)));
  });

  it("calm periods display the last decoded direction (0 before any)", () => {
    const forces = [1, 4, 0, 0, 6, 1]; // forces 0 and 1 are both calm
    const dirs = [7, 3, 7, 7, 5, 7]; // calm-period values are noise the encoder must ignore
    const decoded = roundTrip(windMsg(forces.map((f, i) => ({ weathercode: 0, wind_sfc_kph: bmid(f), wind_sfc_dir: dirs[i] }))));
    expect(decoded.periods[0].map((p) => p.wind_sfc_dir)).toEqual([0, 3, 3, 3, 5, 5]);
    expect(decoded.periods[0].map((p) => p.wind_sfc_kph)).toEqual(forces.map(bmid));
  });

  it("round-trips w600 without w500 present (no upper-level context available)", () => {
    const vars_mask = 1 << VARS_BIT.w600;
    const forces = [10, 12, 11, 13, 12];
    const dirs = [2, 2, 3, 3, 4];
    const periods = [forces.map((f, i) => ({ weathercode: 0, wind_600_kph: bmid(f), wind_600_dir: dirs[i] }))];
    const decoded = roundTrip(msg({ vars_mask, periods }));
    decoded.periods[0].forEach((p, i) => {
      expect(p.wind_600_kph).toBeCloseTo(bmid(forces[i]), 3);
      expect(p.wind_600_dir).toBe(dirs[i]);
    });
  });

  it("an upper level that agrees makes the lower direction column cheaper (cross-level context)", () => {
    // w500+w600 both steady W vs w600 alone steady W: with the upper column present, the joint
    // message's w600 model cost must undercut the standalone one. Encode-only (never decoded),
    // so the 64 × 6h periodHours don't need to sit on a fill path — the encoder reads
    // periodHours directly.
    const n = 64;
    const sixHourly: Partial<ForecastMessage> = {
      seq: 48, mode: MODE_RANGE, hour: 0, periodHours: Array(n).fill(6),
    };
    const both = msg({ ...sixHourly, vars_mask: (1 << VARS_BIT.w500) | (1 << VARS_BIT.w600),
      periods: [Array.from({ length: n }, () => ({ weathercode: 0, wind_500_kph: bmid(8), wind_500_dir: 6, wind_600_kph: bmid(6), wind_600_dir: 6 }))] });
    const alone = msg({ ...sixHourly, vars_mask: 1 << VARS_BIT.w600,
      periods: [Array.from({ length: n }, () => ({ weathercode: 0, wind_600_kph: bmid(6), wind_600_dir: 6 }))] });
    const w600Bits = (m: ForecastMessage) =>
      v1EncodeBreakdown(m).columns.find((c) => c.name === "w600")!.bits;
    expect(w600Bits(both)).toBeLessThan(w600Bits(alone));
  });

  // Gusts are a speed-only wind column (no direction stream). Gust decodes FIRST and lends its
  // same-period delta to the surface column when both are in vars_mask.
  it("round-trips gust speeds (speed-only column, no direction symbols)", () => {
    const gustForces = [8, 10, 9, 12, 14, 11, 10, 8, 13, 12];
    const periods = gustForces.map((g, i) => ({
      weathercode: 0,
      wind_sfc_kph: bmid(i % 4), // includes calm periods
      wind_sfc_dir: i % 8,
      wind_gust_kph: bmid(g),
    }));
    const decoded = roundTrip(msg({
      vars_mask: (1 << VARS_BIT.wind) | (1 << VARS_BIT.gust), periods: [periods],
    }));
    decoded.periods[0].forEach((p, i) => {
      expect(p.wind_gust_kph).toBeCloseTo(bmid(gustForces[i]), 3);
      expect(p.wind_sfc_kph).toBeCloseTo(bmid(i % 4), 3);
    });
  });

  it("round-trips surface wind without gust present (res-keyed fallback books)", () => {
    const forces = [3, 5, 4, 6, 5];
    const dirs = [2, 2, 3, 3, 4];
    const periods = forces.map((f, i) => ({ weathercode: 0, wind_sfc_kph: bmid(f), wind_sfc_dir: dirs[i] }));
    const decoded = roundTrip(msg({ vars_mask: 1 << VARS_BIT.wind, periods: [periods] }));
    decoded.periods[0].forEach((p, i) => {
      expect(p.wind_sfc_kph).toBeCloseTo(bmid(forces[i]), 3);
      expect(p.wind_gust_kph).toBeUndefined();
    });
  });

  it("round-trips gusts alone (surface wind absent from the mask)", () => {
    const gustForces = [8, 10, 9, 12, 14];
    const periods = gustForces.map((g) => ({ weathercode: 0, wind_gust_kph: bmid(g) }));
    const decoded = roundTrip(msg({ vars_mask: 1 << VARS_BIT.gust, periods: [periods] }));
    decoded.periods[0].forEach((p, i) => {
      expect(p.wind_gust_kph).toBeCloseTo(bmid(gustForces[i]), 3);
      expect(p.wind_sfc_kph).toBeUndefined();
    });
  });

  it("a gust column that moves with the surface wind makes the surface column cheaper (cross-column context)", () => {
    // Mirrors the w500/w600 test above: surface rising in step with the gusts, encoded with vs
    // without the gust column present in the mask. Encode-only (seq-pinned 6h).
    const n = 12;
    const sixHourly: Partial<ForecastMessage> = {
      seq: 48, mode: MODE_RANGE, hour: 0, periodHours: Array(n).fill(6),
    };
    const rising = (i: number) => i; // force deltas of +1, matching the gust column's
    const both = msg({ ...sixHourly, vars_mask: (1 << VARS_BIT.wind) | (1 << VARS_BIT.gust),
      periods: [Array.from({ length: n }, (_, i) => ({ weathercode: 0,
        wind_sfc_kph: bmid(rising(i) + 2), wind_sfc_dir: 6,
        wind_gust_kph: bmid(rising(i) + 4) }))] });
    const alone = msg({ ...sixHourly, vars_mask: 1 << VARS_BIT.wind,
      periods: [Array.from({ length: n }, (_, i) => ({ weathercode: 0,
        wind_sfc_kph: bmid(rising(i) + 2), wind_sfc_dir: 6 }))] });
    const windBits = (m: ForecastMessage) =>
      v1EncodeBreakdown(m).columns.find((c) => c.name === "wind")!.bits;
    expect(windBits(both)).toBeLessThan(windBits(alone));
  });

  it("round-trips hurricane-force storm gusts (extended Beaufort top bands)", () => {
    // Corpus gust max is 225 kph (force 17's open band); values above clamp into force 17.
    const gustForces = [12, 14, 16, 17];
    const periods = gustForces.map((g) => ({ weathercode: 0, wind_gust_kph: bmid(g) }));
    periods.push({ weathercode: 0, wind_gust_kph: 400 }); // clamps into the top band
    const decoded = roundTrip(msg({ vars_mask: 1 << VARS_BIT.gust, periods: [periods] }));
    gustForces.forEach((g, i) =>
      expect(decoded.periods[0][i].wind_gust_kph).toBeCloseTo(bmid(g), 3));
    expect(decoded.periods[0][4].wind_gust_kph).toBeCloseTo(bmid(17), 3);
  });
});

describe("delta temperature encoding", () => {
  it("round-trips a clustered temperature column exactly", () => {
    const temps = [-5, -4, -3, 0, 2, 5, 3, 1, -2, 4];
    const periods = [temps.map((t) => ({ ...PERIOD, temp_c: t }))];
    const decoded = roundTrip(msg({ vars_mask: 1 << VARS_BIT.temp, periods }));
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

  it("round-trips a >31°C period-over-period swing at the escape field's edge exactly", () => {
    // ±31 is the largest delta the escape payload can carry — no clamping yet.
    const temps = [-15, 16, 14, 15, -16, -14];
    const periods = [temps.map((t) => ({ ...PERIOD, temp_c: t }))];
    const decoded = roundTrip(msg({ vars_mask: 1 << VARS_BIT.temp, periods }));
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
      const decoded = roundTrip(msg({ vars_mask: 1 << VARS_BIT.temp, periods }));
      const out = decoded.periods[0].map((p) => p.temp_c!);
      expect(out[0]).toBe(temps[0]);
      expect(out[1]).toBe(start + Math.min(Math.max(swing, -32), 31)); // clamped
      for (let i = 2; i < temps.length; i++) expect(out[i]).toBe(temps[i]); // healed
    }
  });

  it("clamp-heals under conditioning: contexts after the clamp derive from the CLAMPED chain", () => {
    // The delta codebooks are keyed by (resolution, time-of-day, previous decoded delta). An
    // encoder that chained the raw +40 jump instead of its clamped reconstruction would desync
    // from the decoder's context. 49 hourly periods cross every 3h time-of-day bucket, with the
    // clamped jump mid-column so every later delta is coded under post-clamp context.
    const temps: number[] = [];
    for (let i = 0; i < 12; i++) temps.push(-30 + i);          // steady +1 °C/h ramp
    temps.push(temps[11] + 40);                                 // +40 jump → clamped to +31
    for (let i = 13; i < 49; i++) temps.push(temps[i - 1] - 1); // post-jump decline
    const periods = [temps.map((t) => ({ ...PERIOD, temp_c: t }))];
    const decoded = roundTrip(msg({ vars_mask: 1 << VARS_BIT.temp, periods }, { hourly: true }));
    const out = decoded.periods[0].map((p) => p.temp_c!);
    expect(out[12]).toBe(temps[11] + 31); // clamped
    for (let i = 13; i < 49; i++) expect(out[i]).toBe(temps[i]); // healed, contexts in sync
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
    const m = msg({ periods });
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

describe("order-1 precipitation encoding", () => {
  const vars_mask = 1 << VARS_BIT.snow;
  // The snow codebooks key on the same period's weathercode class, so a period must carry a
  // weathercode consistent with its snowfall — "snowing hard, zero accumulation" is a
  // contradiction the tables (rightly) charge for, and it isn't what these tests are about.
  const snowPeriod = (cm: number): Period => ({ ...PERIOD, weathercode: cm > 0 ? 71 : 0, snow_cm: cm });

  it("collapses an all-dry snow column to almost nothing and round-trips to zero", () => {
    const dry = Array.from({ length: 72 }, () => snowPeriod(0));
    const decoded = roundTrip(msg({ vars_mask, periods: [dry] }, { hourly: true }));
    decoded.periods[0].forEach((p) => expect(p.snow_cm).toBe(0));
    // A dry run is the order-1 tables' cheapest input (P(0 | prev=0, clear) is near 1), so the
    // all-dry column must undercut one with snow every period. Compare exact body bits (not the
    // base-85 encoded char length) since a few bits of savings can land on either side of a char
    // boundary and not move the visible string length.
    const snowy = Array.from({ length: 72 }, () => snowPeriod(20));
    const dryBits = v1EncodeBreakdown(msg({ vars_mask, periods: [dry] }, { hourly: true })).bodyBits;
    const snowyBits = v1EncodeBreakdown(msg({ vars_mask, periods: [snowy] }, { hourly: true })).bodyBits;
    expect(dryBits).toBeLessThan(snowyBits);
  });

  it("round-trips a mostly-zero snow column exactly", () => {
    const vals = Array.from({ length: 72 }, (_, i) => (i % 12 === 0 ? 10 : 0));
    const periods = [vals.map(snowPeriod)];
    const decoded = roundTrip(msg({ vars_mask, periods }, { hourly: true }));
    decoded.periods[0].forEach((p, i) => expect(p.snow_cm).toBeCloseTo(qSnow(vals[i]), 5));
    // Mostly-dry beats a column where every cell is nonzero and widely spread.
    const dense = Array.from({ length: 72 }, (_, i) => snowPeriod(3 * (i + 1)));
    const sparseBits = v1EncodeBreakdown(msg({ vars_mask, periods }, { hourly: true })).bodyBits;
    const denseBits = v1EncodeBreakdown(msg({ vars_mask, periods: [dense] }, { hourly: true })).bodyBits;
    expect(sparseBits).toBeLessThan(denseBits);
  });

  it("a snowing weathercode makes the same snow column cheaper (cross-variable context)", () => {
    // The wet columns key their codebooks on the SAME period's weathercode class, which is free
    // context (weathercode decodes first, always present). Identical snowfall under code 71
    // (snow) vs code 0 (clear) must cost fewer bits in the SNOW column — the weathercode column's
    // own cost differs between the two messages, so bodyBits would conflate the two effects.
    const snowing = Array.from({ length: 72 }, () => ({ ...PERIOD, weathercode: 71, snow_cm: 6 }));
    const clear = snowing.map((p) => ({ ...p, weathercode: 0 }));
    const snowBits = (periods: Period[]) =>
      v1EncodeBreakdown(msg({ vars_mask, periods: [periods] }, { hourly: true }))
        .columns.find((c) => c.name === "snow")!.bits;
    expect(snowBits(snowing)).toBeLessThan(snowBits(clear));
  });
});
