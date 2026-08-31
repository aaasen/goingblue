import { describe, it, expect } from "vitest";
import { wireCodec, WIRE_VERSION, WIRE_HEADER_CHARS } from "../src/wire.js";
import { layoutFor, maxFillSeq, MODE_AUTO, MODE_DETAIL, MODE_RANGE } from "../src/layout.js";
import { DEFAULT_VARS_MASK, MODEL_BIT } from "../src/constants.js";
import type { ForecastMessage, Period, RequestContext } from "../src/model.js";

const PERIOD: Period = {
  weathercode: 3, precip: 57, snow_cm: 0, freeze_m: 3048,
  wind_aloft: [null, null, { kph: 48, dir: 4 }, { kph: 40, dir: 3 }, { kph: 24, dir: 2 }, null, null],
};

// Requested at local midnight (UTC offset 0) so day 0 is a complete day.
const REQ_UTC_HOUR = Date.UTC(2026, 5, 15) / 3600000;

function msgFor(mode: number, seq: number): ForecastMessage {
  const layout = layoutFor(mode, REQ_UTC_HOUR, 0, seq);
  // hour must be the layout's first-period start: the encoder keys the temp time-of-day
  // codebooks off it, and the decoder derives the same value from the layout.
  const first = new Date(layout.periodStartUtcHour[0] * 3600000);
  return {
    version: WIRE_VERSION,
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
  return wireCodec.decode(wireCodec.encode(m), () => ctxOf(m));
}

describe("seq header", () => {
  it("uses a 5-char header", () => {
    expect(WIRE_HEADER_CHARS).toBe(5);
    expect(wireCodec.encode(msgFor(MODE_RANGE, 1)).length).toBeGreaterThanOrEqual(WIRE_HEADER_CHARS);
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
    expect(() => wireCodec.encode({ ...m, seq: 0 })).toThrow(/seq/);
    expect(() => wireCodec.encode({ ...m, seq: 257 })).toThrow(/seq/);
    expect(() => wireCodec.encode({ ...m, seq: undefined as unknown as number })).toThrow(/seq/);
  });

  // The server encodes a Canadian Range request under Auto (see effectiveMode). The mode isn't
  // on the wire and the client stores what it asked for, so the decoder has to redo the
  // substitution — otherwise it would lay an Auto message out along Range's path.
  it("decodes a Canadian Range request against Auto's layout", () => {
    const built = msgFor(MODE_AUTO, 20); // what the server produced
    const stored: RequestContext = {
      ...ctxOf(built), model: MODEL_BIT.CA, mode: MODE_RANGE, // what the client asked for
    };
    const decoded = wireCodec.decode(wireCodec.encode(built), () => stored);
    expect(decoded.periodHours).toEqual(built.periodHours); // laid out along Auto's path
    expect(decoded.periods[0]).toHaveLength(built.periods[0].length);
    expect(decoded.mode).toBe(MODE_RANGE); // but still labelled as what was asked for

    // And a context that happens to hold the substituted mode already lands in the same place,
    // so the rule is safe to apply anywhere on the read path.
    const storedEffective = { ...stored, mode: MODE_AUTO };
    expect(wireCodec.decode(wireCodec.encode(built), () => storedEffective).periodHours)
      .toEqual(decoded.periodHours);
  });

  it("leaves a Range request on an unsubstituted model alone", () => {
    const m = msgFor(MODE_RANGE, 20);
    const usCtx: RequestContext = { ...ctxOf(m), model: MODEL_BIT.US, mode: MODE_RANGE };
    const decoded = wireCodec.decode(wireCodec.encode(m), () => usCtx);
    expect(decoded.mode).toBe(MODE_RANGE);
    expect(decoded.periodHours).toEqual(m.periodHours); // Range's own layout, not Auto's
    expect(decoded.periodHours).not.toEqual(
      layoutFor(MODE_AUTO, REQ_UTC_HOUR, 0, 20).periodHours);
  });

  it("rejects a decoded seq beyond the context mode's fill sequence", () => {
    // Encoded at Detail's top but resolved against a Range context: Detail's path is longer.
    const m = msgFor(MODE_DETAIL, maxFillSeq(MODE_DETAIL));
    expect(maxFillSeq(MODE_DETAIL)).toBeGreaterThan(maxFillSeq(MODE_RANGE));
    const rangeCtx = { ...ctxOf(m), mode: MODE_RANGE };
    expect(() => wireCodec.decode(wireCodec.encode(m), () => rangeCtx)).toThrow(/fill sequence/);
  });
});
