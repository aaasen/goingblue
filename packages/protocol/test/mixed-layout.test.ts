import { describe, it, expect } from "vitest";
import {
  v1MessageToString,
  v1MessageFromString,
  v1EncodeBreakdown,
  V1_VERSION,
  layoutFor,
  maxFillSeq,
  FILL_SLOTS,
  MODE_DETAIL,
  MODE_AUTO,
  MODE_RANGE,
  decodeMessage,
  type ForecastMessage,
  type Period,
  type RequestContext,
  type FillLayout,
} from "../src/index.js";

// Every variable (bit 12 is `rain`; bit 13, formerly tmin, is reserved).
const ALL_VARS = ((1 << 13) - 1) & ~(1 << 8); // bit 8 (formerly cloud_total) is reserved

// Request: 2026-07-12 at 13:00 local, UTC-9. Detail mode unless a test says otherwise — its
// path has the richest resolution mixes (1h/3h/6h/12h in one message).
const MODE = MODE_DETAIL;
const UTC_OFFSET = -9;
const REQ_UTC_HOUR = Date.UTC(2026, 6, 12, 13) / 3600000 - UTC_OFFSET;

// Deterministic per-period values, varied so delta columns get exercised.
function periodAt(i: number): Period {
  return {
    weathercode: [0, 3, 61, 71, 95][i % 5],
    precip: (i * 13) % 101,
    temp_c: -5 + (i % 7),
    snow_cm: i % 4 === 0 ? i % 11 : 0,
    rain_mm: i % 3 === 0 ? (i % 5) : 0,
    freeze_m: (2 + (i % 3)) * 304.8,
    wind_sfc_kph: ((i % 6) + 1) * 5 * 1.609344,
    wind_sfc_dir: i % 8,
    wind_500_kph: ((i % 4) + 4) * 5 * 1.609344,
    wind_500_dir: (i + 2) % 8,
    wind_600_kph: ((i % 5) + 3) * 5 * 1.609344,
    wind_600_dir: (i + 4) % 8,
    wind_700_kph: ((i % 3) + 2) * 5 * 1.609344,
    wind_700_dir: (i + 6) % 8,
    cloud_high: Math.round((i % 8) * 100 / 7),
    cloud_mid: Math.round(((i + 3) % 8) * 100 / 7),
    cloud_low: Math.round(((i + 5) % 8) * 100 / 7),
  };
}

function msgFor(layout: FillLayout, overrides: Partial<ForecastMessage> = {}): ForecastMessage {
  const first = new Date(layout.periodStartUtcHour[0] * 3600000);
  return {
    version: V1_VERSION,
    code: 42,
    days: layout.days,
    models_mask: 0b001,
    vars_mask: ALL_VARS,
    month: first.getUTCMonth() + 1,
    day: first.getUTCDate(),
    hour: first.getUTCHours(),
    lat: 63.135,
    lon: -150.989,
    elevation: 500,
    periods: [layout.periodHours.map((_, i) => periodAt(i))],
    seq: layout.seq,
    mode: layout.mode,
    periodHours: layout.periodHours,
    utcOffsetHours: UTC_OFFSET,
    ...overrides,
  };
}

const ctxFor = (mode: number): RequestContext => ({
  model: 0,
  vars_mask: ALL_VARS,
  lat: 63.135,
  lon: -150.989,
  start: REQ_UTC_HOUR * 3600000,
  mode,
  utcOffsetHours: UTC_OFFSET,
});
const ctx = ctxFor(MODE);

function roundTrip(seq: number, mode = MODE): { original: ForecastMessage; decoded: ForecastMessage } {
  const layout = layoutFor(mode, REQ_UTC_HOUR, UTC_OFFSET, seq);
  const original = msgFor(layout);
  const decoded = v1MessageFromString(v1MessageToString(original), () => ctxFor(mode));
  return { original, decoded };
}

describe("mixed-layout round-trip encoding", () => {
  it("recovers the layout from seq alone — header, periodHours, and count", () => {
    // Detail seq 7 = |1h|6h|12h|: three resolutions in one message.
    const seq = 7;
    const { original, decoded } = roundTrip(seq);
    expect(decoded.version).toBe(V1_VERSION);
    expect(decoded.code).toBe(42);
    expect(decoded.seq).toBe(seq);
    expect(decoded.mode).toBe(MODE);
    expect(decoded.days).toBe(3);
    expect(decoded.periodHours).toEqual(original.periodHours);
    expect(decoded.periods[0]).toHaveLength(original.periods[0].length);
    expect(decoded.elevation).toBe(500);
    expect(decoded.models_mask).toBe(0b001);
    expect(decoded.vars_mask).toBe(ALL_VARS);
  });

  it("month/day/hour describe the first period's start, not the request time", () => {
    // Detail seq 12 = 1h×3: the first period is the request hour itself (13:00 local = 22:00 UTC).
    const hourly = roundTrip(12).decoded;
    expect([hourly.month, hourly.day, hourly.hour]).toEqual([7, 12, 22]);
    // All-12h layout: day 0's period starts at local noon (21:00 UTC).
    const all12h = roundTrip(3).decoded;
    expect([all12h.month, all12h.day, all12h.hour]).toEqual([7, 12, 21]);
  });

  it("round-trips period values across a four-resolution taper", () => {
    // Detail seq 24 = |1h×3|3h×2|6h×3|: every rung boundary in one column.
    const { original, decoded } = roundTrip(24);
    original.periods[0].forEach((p, i) => {
      const d = decoded.periods[0][i];
      expect(d.weathercode).toBe(p.weathercode);
      expect(d.temp_c).toBe(p.temp_c);
      expect(d.freeze_m).toBeCloseTo(p.freeze_m!, 5);
      expect(d.wind_sfc_kph).toBeCloseTo(p.wind_sfc_kph!, 5);
      expect(d.wind_sfc_dir).toBe(p.wind_sfc_dir);
      expect(d.cloud_high).toBe(p.cloud_high);
      expect(d.cloud_low).toBe(p.cloud_low);
    });
  });

  it("round-trips every seq of every mode's path", () => {
    for (const mode of [MODE_DETAIL, MODE_AUTO, MODE_RANGE]) {
      for (let seq = 1; seq <= maxFillSeq(mode); seq++) {
        const { original, decoded } = roundTrip(seq, mode);
        expect(decoded.periodHours).toEqual(original.periodHours);
        expect(decoded.periods[0]).toHaveLength(original.periods[0].length);
      }
    }
  });

  it("early-path layouts decode with partial coverage (days < FILL_SLOTS)", () => {
    const { decoded } = roundTrip(2);
    expect(decoded.days).toBe(2);
    expect(decoded.days).toBeLessThan(FILL_SLOTS);
    // At 13:00 local, slot 0 contributes one 12h period; day 1 two.
    expect(decoded.periodHours).toEqual(Array(3).fill(12));
  });

  it("dispatches through the version registry", () => {
    const layout = layoutFor(MODE, REQ_UTC_HOUR, UTC_OFFSET, 15);
    const encoded = v1MessageToString(msgFor(layout));
    const decoded = decodeMessage(encoded, () => ctx);
    expect(decoded.version).toBe(V1_VERSION);
    expect(decoded.seq).toBe(15);
  });

  it("rejects a context without mode fields (e.g. a stale store entry)", () => {
    const layout = layoutFor(MODE, REQ_UTC_HOUR, UTC_OFFSET, 10);
    const encoded = v1MessageToString(msgFor(layout));
    const staleCtx = { ...ctx, mode: undefined, utcOffsetHours: undefined } as unknown as RequestContext;
    expect(() => v1MessageFromString(encoded, () => staleCtx)).toThrow(/priority mode/);
  });

  it("rejects a message without a seq", () => {
    const layout = layoutFor(MODE, REQ_UTC_HOUR, UTC_OFFSET, 10);
    expect(() => v1MessageToString(msgFor(layout, { seq: undefined }))).toThrow(/seq/);
  });

  it("breakdown produces the identical encoding and accounts every column", () => {
    const layout = layoutFor(MODE, REQ_UTC_HOUR, UTC_OFFSET, 29); // the full-coverage taper
    const m = msgFor(layout);
    const b = v1EncodeBreakdown(m);
    expect(b.encoded).toBe(v1MessageToString(m));
    expect(b.chars).toBe(b.encoded.length);
    expect(b.bodyBits).toBeGreaterThan(0);
    const names = b.columns.map((c) => c.name);
    expect(names).toContain("weathercode");
    expect(names).toContain("temp");
  });
});
