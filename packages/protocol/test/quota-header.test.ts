import { readFileSync } from "node:fs";
import { gunzipSync } from "node:zlib";
import { describe, it, expect } from "vitest";
import {
  DEFAULT_VARS, MODE_AUTO, QUOTA_FREE_FORECASTS, WIRE_HEADER_CHARS, WIRE_VERSION,
  avalancheAnchor, encodeAvalancheMessage, headerFromString, layoutFor, loadModels, wireCodec,
  type AvalancheForecast, type ForecastMessage, type Period, type QuotaState, type RequestContext,
} from "../src/index.js";
import SEA_TO_SKY from "../../mobile/fixtures/avalanche/sea-to-sky-2026-03-01.json";

const PERIOD: Period = {
  weathercode: 3, precip: 57, snow_cm: 0, freeze_m: 3048,
  wind_aloft: [null, null, { kph: 48, dir: 4 }, { kph: 40, dir: 3 }, { kph: 24, dir: 2 }, null, null],
};
const REQ_UTC_HOUR = Date.UTC(2026, 5, 15) / 3600000;

function msgWith(quota: QuotaState | undefined): ForecastMessage {
  const layout = layoutFor(MODE_AUTO, REQ_UTC_HOUR, 0, 3);
  const first = new Date(layout.periodStartUtcHour[0] * 3600000);
  return {
    version: WIRE_VERSION, code: 42, days: layout.days, models_mask: 0b0001, vars: new Set(DEFAULT_VARS),
    month: first.getUTCMonth() + 1, day: first.getUTCDate(), hour: first.getUTCHours(),
    lat: 63.063, lon: -151.081, elevation: 4267,
    seq: 3, mode: MODE_AUTO, periodHours: layout.periodHours,
    periods: [layout.periodHours.map(() => ({ ...PERIOD }))],
    utcOffsetHours: 0,
    ...(quota ? { quota } : {}),
  };
}

const ctx = (m: ForecastMessage): RequestContext => ({
  model: 0, vars: m.vars, lat: m.lat, lon: m.lon, start: REQ_UTC_HOUR * 3600000, mode: m.mode, utcOffsetHours: 0,
});

const STATES: QuotaState[] = [
  { kind: "none" },
  ...Array.from({ length: QUOTA_FREE_FORECASTS + 1 }, (_, i) => ({ kind: "free" as const, remaining: QUOTA_FREE_FORECASTS - i })),
  { kind: "over" },
];

describe("quota header field", () => {
  it("round-trips every state without changing the header width", () => {
    for (const quota of STATES) {
      const m = msgWith(quota);
      const s = wireCodec.encode(m);
      expect(headerFromString(s.slice(0, WIRE_HEADER_CHARS)).quota).toEqual(quota);
      expect(wireCodec.decode(s, () => ctx(m)).quota).toEqual(quota);
    }
  });

  it("reads an absent quota as none", () => {
    expect(headerFromString(wireCodec.encode(msgWith(undefined))).quota).toEqual({ kind: "none" });
  });

  it("rejects a remaining count outside the field", () => {
    expect(() => wireCodec.encode(msgWith({ kind: "free", remaining: QUOTA_FREE_FORECASTS + 1 }))).toThrow(/remaining/);
    expect(() => wireCodec.encode(msgWith({ kind: "free", remaining: -1 }))).toThrow(/remaining/);
  });

  it("peeks an avalanche reply's code through the weather header and sees no quota", () => {
    const models = loadModels(gunzipSync(readFileSync(new URL("../assets/avcan-model.bin.gz", import.meta.url))));
    const anchor = avalancheAnchor("2026-03-01", 0);
    const s = encodeAvalancheMessage(models, 99, anchor, SEA_TO_SKY as AvalancheForecast);
    const h = headerFromString(s.slice(0, WIRE_HEADER_CHARS));
    expect(h.code).toBe(99);
    expect(h.quota).toEqual({ kind: "none" });
  });
});
