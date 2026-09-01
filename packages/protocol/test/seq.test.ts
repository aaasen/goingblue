import { describe, it, expect } from "vitest";
import { wireCodec, WIRE_VERSION, WIRE_HEADER_CHARS } from "../src/wire.js";
import { layoutFor, maxFillSeq, fillSlotsFor, MODE_DETAIL, MODE_RANGE } from "../src/layout.js";
import { DEFAULT_VARS, MODEL_BIT } from "../src/constants.js";
import type { ForecastMessage, Period, RequestContext } from "../src/model.js";

const PERIOD: Period = {
  weathercode: 3, precip: 57, snow_cm: 0, freeze_m: 3048,
  wind_aloft: [null, null, { kph: 48, dir: 4 }, { kph: 40, dir: 3 }, { kph: 24, dir: 2 }, null, null],
};

// Requested at local midnight (UTC offset 0) so day 0 is a complete day.
const REQ_UTC_HOUR = Date.UTC(2026, 5, 15) / 3600000;

function msgFor(mode: number, seq: number, slots?: number): ForecastMessage {
  const layout = layoutFor(mode, REQ_UTC_HOUR, 0, seq, slots);
  // hour must be the layout's first-period start: the encoder keys the temp time-of-day
  // codebooks off it, and the decoder derives the same value from the layout.
  const first = new Date(layout.periodStartUtcHour[0] * 3600000);
  return {
    version: WIRE_VERSION,
    code: 0,
    days: layout.days,
    models_mask: 0b0001,
    vars: new Set(DEFAULT_VARS),
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
  vars: m.vars, lat: m.lat, lon: m.lon,
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

  // A short-horizon model's ladder is truncated (see fillSlotsFor). The cap isn't on the wire —
  // the decoder recomputes it from the stored model and request time — so the server-built
  // capped layout and the decoder-derived one must be the same path.
  it("decodes a Canadian request against the capped path", () => {
    const slots = fillSlotsFor(MODEL_BIT.CA, REQ_UTC_HOUR, 0);
    expect(slots).toBe(9); // a local-midnight request: 221h ends inside slot 9
    const seq = maxFillSeq(MODE_RANGE, slots);
    const built = msgFor(MODE_RANGE, seq, slots); // what the server produced
    const stored: RequestContext = { ...ctxOf(built), model: MODEL_BIT.CA };
    const decoded = wireCodec.decode(wireCodec.encode(built), () => stored);
    expect(decoded.periodHours).toEqual(built.periodHours);
    expect(decoded.periods[0]).toHaveLength(built.periods[0].length);
    // The capped top is refined — the budget refines within the days Canada has, instead of
    // stranding against slots it can't serve.
    expect(decoded.periodHours).toContain(1);
  });

  it("leaves a full-window model's path uncapped", () => {
    const m = msgFor(MODE_RANGE, 20);
    const usCtx: RequestContext = { ...ctxOf(m), model: MODEL_BIT.US, mode: MODE_RANGE };
    const decoded = wireCodec.decode(wireCodec.encode(m), () => usCtx);
    expect(decoded.mode).toBe(MODE_RANGE);
    expect(decoded.periodHours).toEqual(m.periodHours);
  });

  it("rejects a seq past the capped fill sequence", () => {
    // Encoded at Range's uncapped top but resolved against a Canadian context: the capped path
    // is shorter, so the seq can't be one the server produced.
    const slots = fillSlotsFor(MODEL_BIT.CA, REQ_UTC_HOUR, 0);
    expect(maxFillSeq(MODE_RANGE)).toBeGreaterThan(maxFillSeq(MODE_RANGE, slots));
    const m = msgFor(MODE_RANGE, maxFillSeq(MODE_RANGE));
    const caCtx = { ...ctxOf(m), model: MODEL_BIT.CA };
    expect(() => wireCodec.decode(wireCodec.encode(m), () => caCtx)).toThrow(/fill sequence/);
  });

  it("rejects a decoded seq beyond the context mode's fill sequence", () => {
    // Encoded at Detail's top but resolved against a Range context: Detail's path is longer.
    const m = msgFor(MODE_DETAIL, maxFillSeq(MODE_DETAIL));
    expect(maxFillSeq(MODE_DETAIL)).toBeGreaterThan(maxFillSeq(MODE_RANGE));
    const rangeCtx = { ...ctxOf(m), mode: MODE_RANGE };
    expect(() => wireCodec.decode(wireCodec.encode(m), () => rangeCtx)).toThrow(/fill sequence/);
  });
});
