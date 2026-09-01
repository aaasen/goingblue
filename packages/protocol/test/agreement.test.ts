import { describe, it, expect } from "vitest";
import {
  messageToString, messageFromString, encodeBreakdown,
  WIRE_VERSION, MODE_RANGE, VAR, ALWAYS_VARS,
  AGREEMENT_CENTERS, agreementPairIdxs, agreementPeriodCount,
  quantAgreement, AGREEMENT_CUTS, agreementLeadBucket,
  type ForecastMessage, type Period, type RequestContext, type Variable,
} from "../src/index.js";

const PERIOD: Period = {
  weathercode: 3, temp_c: -5, snow_cm: 0, rain_mm: 0,
  wind_sfc_kph: 20, wind_sfc_dir: 2, wind_gust_kph: 33,
};

const VARS: ReadonlySet<Variable> = new Set([...ALWAYS_VARS, VAR.agreement]);

// 12h Range-ramp layouts (see encoding.test.ts uniformLayout): n periods at seq = ceil(n/2),
// requested at hour 24*seq − 12n.
function msg(nPeriods: number, modelsMask: number, agreement: (number | null)[][]): ForecastMessage {
  const seq = Math.ceil(nPeriods / 2);
  const periods = Array.from({ length: nPeriods }, (_, p) =>
    ({ ...PERIOD, agreement: agreement[p] }));
  return {
    version: WIRE_VERSION, code: 0, days: seq, models_mask: modelsMask, vars: VARS,
    month: 5, day: 20, hour: 24 * seq - 12 * nPeriods, lat: 63.1, lon: -151.0, elevation: 500,
    periods: [periods], seq, mode: MODE_RANGE,
    periodHours: Array(nPeriods).fill(12), utcOffsetHours: 0,
  };
}

const ctxOf = (m: ForecastMessage): RequestContext => ({
  model: 31 - Math.clz32(m.models_mask & -m.models_mask),
  vars: m.vars, lat: m.lat, lon: m.lon,
  start: Date.UTC(new Date().getUTCFullYear(), m.month - 1, m.day, m.hour),
  mode: m.mode, utcOffsetHours: 0,
});
const roundTrip = (m: ForecastMessage) => messageFromString(messageToString(m), () => ctxOf(m));

describe("model agreement column", () => {
  it("round-trips all three pair levels under best_match", () => {
    const levels = [[0, 1, 2], [3, 2, 1], [2, 2, 0]];
    const decoded = roundTrip(msg(3, 0b0001, levels));
    decoded.periods[0].forEach((p, i) => expect(p.agreement).toEqual(levels[i]));
  });

  it("never carries the served center's own pair", () => {
    // Served US (bit 1): the US slot decodes null whatever the encoder was handed.
    const decoded = roundTrip(msg(3, 0b0010, [[3, 1, 2], [3, 2, 1], [3, 0, 0]]));
    decoded.periods[0].forEach((p) => expect(p.agreement![0]).toBeNull());
    expect(decoded.periods[0][0].agreement).toEqual([null, 1, 2]);
  });

  it("codes a null level inside the horizon as no-data and restores it", () => {
    const decoded = roundTrip(msg(3, 0b0001, [[2, null, 3], [2, null, 3], [2, null, 3]]));
    decoded.periods[0].forEach((p) => expect(p.agreement).toEqual([2, null, 3]));
  });

  it("clamps each pair at its center's horizon with zero wire bits", () => {
    // 26 × 12h = 312h: CA (240h) covers the first 20 periods, US/EU the whole window.
    const n = 26;
    const levels = Array.from({ length: n }, () => [1, 2, 3]);
    const decoded = roundTrip(msg(n, 0b0001, levels));
    decoded.periods[0].forEach((p, i) => {
      expect(p.agreement).toEqual(i < 20 ? [1, 2, 3] : [1, null, 3]);
    });
    // The clamp is derived, not sent: the CA series simply stops.
    expect(agreementPeriodCount(Array(n).fill(12), AGREEMENT_CENTERS[1].horizonHours)).toBe(20);
  });

  it("omits the column entirely when the variable is not requested", () => {
    const m = msg(3, 0b0001, [[0, 0, 0], [0, 0, 0], [0, 0, 0]]);
    const without = { ...m, vars: new Set(ALWAYS_VARS) as ReadonlySet<Variable> };
    const decoded = messageFromString(messageToString(without), () => ctxOf(without));
    decoded.periods[0].forEach((p) => expect(p.agreement).toBeUndefined());
    // And it costs body bits when present.
    const withBits = encodeBreakdown(m).columns.find((c) => c.name === VAR.agreement);
    expect(withBits).toBeDefined();
    expect(withBits!.bits).toBeGreaterThan(0);
  });

  it("derives pairs and buckets identically to the constants", () => {
    expect(agreementPairIdxs(0b0001)).toEqual([0, 1, 2]); // best_match: all three
    expect(agreementPairIdxs(0b1000)).toEqual([0, 1]);    // EU served: US + CA
    expect(agreementLeadBucket(0)).toBe(0);
    expect(agreementLeadBucket(47)).toBe(0);
    expect(agreementLeadBucket(48)).toBe(1);
    expect(agreementLeadBucket(240)).toBe(3);
    expect(quantAgreement(0)).toBe(0);
    expect(quantAgreement(AGREEMENT_CUTS[0])).toBe(1);
    expect(quantAgreement(1)).toBe(3);
  });
});
