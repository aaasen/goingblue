import { describe, it, expect } from "vitest";
import { v1Codec, V1_HEADER_CHARS } from "../src/versions/v1.js";
import { layoutFor, maxFillSeq } from "../src/layout.js";
import { DEFAULT_VARS_MASK } from "../src/constants.js";
import type { ForecastMessage, Period, RequestContext } from "../src/model.js";

const PERIOD: Period = {
  weathercode: 3, precip: 57, snow_cm: 0, freeze_m: 3048,
  wind_500_kph: 48, wind_500_dir: 4, wind_600_kph: 40, wind_600_dir: 3,
  wind_700_kph: 24, wind_700_dir: 2,
};

// Requested at local midnight (UTC offset 0) so day 0 is a complete day.
const REQ_UTC_HOUR = Date.UTC(2026, 5, 15) / 3600000;

function msgFor(durationDays: number, seq: number): ForecastMessage {
  const layout = layoutFor(durationDays, REQ_UTC_HOUR, 0, seq);
  // hour must be the layout's first-period start: the encoder keys the temp time-of-day
  // codebooks off it, and the decoder derives the same value from the layout.
  const first = new Date(layout.periodStartUtcHour[0] * 3600000);
  return {
    version: 1,
    code: 0,
    days: layout.days,
    models_mask: 0b0001,
    vars_mask: DEFAULT_VARS_MASK,
    month: first.getUTCMonth() + 1, day: first.getUTCDate(), hour: first.getUTCHours(),
    lat: 63.063, lon: -151.081, elevation: 4267,
    seq,
    durationDays,
    periodHours: layout.periodHours,
    periods: [layout.periodHours.map(() => ({ ...PERIOD }))],
    utcOffsetHours: 0,
  };
}

const ctxOf = (m: ForecastMessage): RequestContext => ({
  model: 0,
  vars_mask: m.vars_mask, lat: m.lat, lon: m.lon,
  start: REQ_UTC_HOUR * 3600000,
  durationDays: m.durationDays,
  utcOffsetHours: 0,
});

function dec(m: ForecastMessage): ForecastMessage {
  return v1Codec.decode(v1Codec.encode(m), () => ctxOf(m));
}

describe("v1 seq header", () => {
  it("uses a 5-char header", () => {
    expect(V1_HEADER_CHARS).toBe(5);
    expect(v1Codec.encode(msgFor(1, 1)).length).toBeGreaterThanOrEqual(V1_HEADER_CHARS);
  });

  it("round-trips the smallest layout (seq 1: two 12h periods)", () => {
    const decoded = dec(msgFor(3, 1));
    expect(decoded.seq).toBe(1);
    expect(decoded.periods[0]).toHaveLength(2);
    expect(decoded.periodHours).toEqual([12, 12]);
  });

  it("round-trips the largest encodable seq (256, the 8-bit field's ceiling)", () => {
    // A 63-day duration covers 64 slots and so reaches seq 256 (4 × 64) — far beyond what the
    // server offers, but the header field must round-trip its full range.
    expect(maxFillSeq(63)).toBe(256);
    const m = msgFor(63, 256);
    const decoded = dec(m);
    expect(decoded.seq).toBe(256);
    expect(decoded.periods[0]).toHaveLength(m.periods[0].length);
  });

  it("rejects an out-of-range or missing seq at encode time", () => {
    const m = msgFor(3, 2);
    expect(() => v1Codec.encode({ ...m, seq: 0 })).toThrow(/seq/);
    expect(() => v1Codec.encode({ ...m, seq: 257 })).toThrow(/seq/);
    expect(() => v1Codec.encode({ ...m, seq: undefined as unknown as number })).toThrow(/seq/);
  });

  it("rejects a decoded seq beyond the context's fill sequence", () => {
    // Encoded for a 10-day request but resolved against a 3-day context: seq 40 > maxFillSeq(3).
    const m = msgFor(10, 40);
    expect(40).toBeGreaterThan(maxFillSeq(3));
    const shortCtx = { ...ctxOf(m), durationDays: 3 };
    expect(() => v1Codec.decode(v1Codec.encode(m), () => shortCtx)).toThrow(/fill sequence/);
  });
});
