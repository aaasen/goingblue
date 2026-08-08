import { describe, it, expect } from "vitest";
import { v2Codec, V2_VERSION, V2_HEADER_CHARS } from "../src/versions/v2.js";
import { layoutFor, maxFillSeq, MODE_DETAIL, MODE_RANGE } from "../src/layout.js";
import { DEFAULT_VARS_MASK } from "../src/constants.js";
import type { ForecastMessage, Period, RequestContext } from "../src/model.js";

const PERIOD: Period = {
  weathercode: 3, precip: 57, snow_cm: 0, freeze_m: 3048,
  wind_500_kph: 48, wind_500_dir: 4, wind_600_kph: 40, wind_600_dir: 3,
  wind_700_kph: 24, wind_700_dir: 2,
};

// Requested at local midnight (UTC offset 0) so day 0 is a complete day.
const REQ_UTC_HOUR = Date.UTC(2026, 5, 15) / 3600000;

function msgFor(mode: number, seq: number): ForecastMessage {
  const layout = layoutFor(mode, REQ_UTC_HOUR, 0, seq);
  // hour must be the layout's first-period start: the encoder keys the temp time-of-day
  // codebooks off it, and the decoder derives the same value from the layout.
  const first = new Date(layout.periodStartUtcHour[0] * 3600000);
  return {
    version: V2_VERSION,
    code: 0,
    days: layout.days,
    models_mask: 0b0001,
    vars_mask: DEFAULT_VARS_MASK,
    month: first.getUTCMonth() + 1, day: first.getUTCDate(), hour: first.getUTCHours(),
    lat: 63.063, lon: -151.081, elevation: 4267,
    seq,
    mode,
    periodHours: layout.periodHours,
    periods: [layout.periodHours.map(() => ({ ...PERIOD }))],
    utcOffsetHours: 0,
  };
}

const ctxOf = (m: ForecastMessage): RequestContext => ({
  model: 0,
  vars_mask: m.vars_mask, lat: m.lat, lon: m.lon,
  start: REQ_UTC_HOUR * 3600000,
  mode: m.mode,
  utcOffsetHours: 0,
});

function dec(m: ForecastMessage): ForecastMessage {
  return v2Codec.decode(v2Codec.encode(m), () => ctxOf(m));
}

describe("v2 seq header", () => {
  it("uses a 5-char header", () => {
    expect(V2_HEADER_CHARS).toBe(5);
    expect(v2Codec.encode(msgFor(MODE_RANGE, 1)).length).toBeGreaterThanOrEqual(V2_HEADER_CHARS);
  });

  it("round-trips the smallest layout (seq 1: one 12h day, two periods)", () => {
    const decoded = dec(msgFor(MODE_RANGE, 1));
    expect(decoded.seq).toBe(1);
    expect(decoded.periods[0]).toHaveLength(2);
    expect(decoded.periodHours).toEqual([12, 12]);
  });

  it("round-trips every mode's largest seq (the path tops)", () => {
    for (const mode of [MODE_DETAIL, 1, MODE_RANGE]) {
      const m = msgFor(mode, maxFillSeq(mode));
      const decoded = dec(m);
      expect(decoded.seq).toBe(maxFillSeq(mode));
      expect(decoded.periods[0]).toHaveLength(m.periods[0].length);
    }
  });

  it("rejects an out-of-range or missing seq at encode time", () => {
    // The header field is 8 bits (1..256); encode enforces only the field range — the
    // path-length check belongs to decode, where the mode is known.
    const m = msgFor(MODE_RANGE, 2);
    expect(() => v2Codec.encode({ ...m, seq: 0 })).toThrow(/seq/);
    expect(() => v2Codec.encode({ ...m, seq: 257 })).toThrow(/seq/);
    expect(() => v2Codec.encode({ ...m, seq: undefined as unknown as number })).toThrow(/seq/);
  });

  it("rejects a decoded seq beyond the context mode's fill sequence", () => {
    // Encoded at Detail's top but resolved against a Range context: Detail's path is longer.
    const m = msgFor(MODE_DETAIL, maxFillSeq(MODE_DETAIL));
    expect(maxFillSeq(MODE_DETAIL)).toBeGreaterThan(maxFillSeq(MODE_RANGE));
    const rangeCtx = { ...ctxOf(m), mode: MODE_RANGE };
    expect(() => v2Codec.decode(v2Codec.encode(m), () => rangeCtx)).toThrow(/fill sequence/);
  });
});
