import { describe, it, expect } from "vitest";
import {
  v3MessageToString,
  v3MessageFromString,
  v3EncodeBreakdown,
  V3_VERSION,
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
  beaufortMidKph,
  aqiMid,
  aqPeriodCount,
  AQI_US_LOWER,
  AQI_EU_LOWER,
} from "../src/index.js";

// Every variable (bit 8 is `gust`; bit 12 is `rain`; bits 13..17 are air quality — bits 18..21
// are reserved for European sub-indices with no corpus yet, so nothing encodes them).
// periodAt sets no gust value, so the always-on gust column encodes as calm — harmless here.
const ALL_VARS = (1 << 18) - 1;

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
    // Wind speeds are Beaufort band midpoints (they round-trip exactly); surface forces stay
    // above the calm gate (force ≤ 1) so directions round-trip too.
    wind_sfc_kph: beaufortMidKph((i % 6) + 2),
    wind_sfc_dir: i % 8,
    wind_500_kph: beaufortMidKph((i % 4) + 4),
    wind_500_dir: (i + 2) % 8,
    wind_600_kph: beaufortMidKph((i % 5) + 3),
    wind_600_dir: (i + 4) % 8,
    wind_700_kph: beaufortMidKph((i % 3) + 2),
    wind_700_dir: (i + 6) % 8,
    // Step-aligned so the 3-bit quantization round-trips exactly, one moving value per level.
    cloud_band: Array.from({ length: 8 }, (_, li) => Math.round(((i + li) % 8) * 100 / 7)),
    // Air quality, as ladder band representatives so they round-trip exactly. Each headline stays
    // at or above every sub-index on its own scale, the relationship its residual coding assumes.
    aqi: aqiMid(9 + (i % 6), AQI_US_LOWER),
    aqi_pm25: aqiMid(4 + (i % 5), AQI_US_LOWER),
    aqi_o3: aqiMid(3 + (i % 4), AQI_US_LOWER),
    aqi_pm10: aqiMid(3 + (i % 5), AQI_US_LOWER),
    aqi_no2: aqiMid(2 + (i % 3), AQI_US_LOWER),
    aqi_so2: aqiMid(1 + (i % 3), AQI_US_LOWER),
    aqi_eu: aqiMid(5 + (i % 7), AQI_EU_LOWER),
    aqi_eu_pm25: aqiMid(2 + (i % 5), AQI_EU_LOWER),
    aqi_eu_o3: aqiMid(3 + (i % 4), AQI_EU_LOWER),
    aqi_eu_pm10: aqiMid(2 + (i % 4), AQI_EU_LOWER),
    aqi_eu_no2: aqiMid(1 + (i % 3), AQI_EU_LOWER),
    aqi_eu_so2: aqiMid(1 + (i % 2), AQI_EU_LOWER),
    aqi_dominant: i % 6,
    aqi_eu_dominant: i % 5,
  };
}

function msgFor(layout: FillLayout, overrides: Partial<ForecastMessage> = {}): ForecastMessage {
  const first = new Date(layout.periodStartUtcHour[0] * 3600000);
  return {
    version: V3_VERSION,
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
  const decoded = v3MessageFromString(v3MessageToString(original), () => ctxFor(mode));
  return { original, decoded };
}

describe("mixed-layout round-trip encoding", () => {
  it("recovers the layout from seq alone — header, periodHours, and count", () => {
    // Detail seq 7 = |1h|6h|12h|: three resolutions in one message.
    const seq = 7;
    const { original, decoded } = roundTrip(seq);
    expect(decoded.version).toBe(V3_VERSION);
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
      expect(d.cloud_band).toEqual(p.cloud_band);
    });
  });

  it("clamps air quality to the CAMS horizon on every mode's longest layout", () => {
    // The clamp counts periods, not days, so a message whose spans change mid-column is where a
    // period-count mismatch between the two sides would show up. Both sides derive it from
    // periodHours alone; this asserts the decoded shape against that same derivation.
    for (const mode of [MODE_DETAIL, MODE_AUTO, MODE_RANGE]) {
      const { original, decoded } = roundTrip(maxFillSeq(mode), mode);
      const nAq = aqPeriodCount(original.periodHours);
      let start = 0;
      original.periods[0].forEach((p, i) => {
        const d = decoded.periods[0][i];
        if (i < nAq) {
          expect(start, `${mode}/${i} inside the horizon`).toBeLessThan(96);
          expect(d.aqi, `${mode}/${i}`).toBe(p.aqi);
          expect(d.aqi_eu, `${mode}/${i}`).toBe(p.aqi_eu);
        } else {
          expect(start, `${mode}/${i} past the horizon`).toBeGreaterThanOrEqual(96);
          expect(d.aqi, `${mode}/${i}`).toBeUndefined();
          expect(d.aqi_eu, `${mode}/${i}`).toBeUndefined();
        }
        start += original.periodHours[i];
      });
    }
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
    const encoded = v3MessageToString(msgFor(layout));
    const decoded = decodeMessage(encoded, () => ctx);
    expect(decoded.version).toBe(V3_VERSION);
    expect(decoded.seq).toBe(15);
  });

  it("rejects a context without mode fields (e.g. a stale store entry)", () => {
    const layout = layoutFor(MODE, REQ_UTC_HOUR, UTC_OFFSET, 10);
    const encoded = v3MessageToString(msgFor(layout));
    const staleCtx = { ...ctx, mode: undefined, utcOffsetHours: undefined } as unknown as RequestContext;
    expect(() => v3MessageFromString(encoded, () => staleCtx)).toThrow(/priority mode/);
  });

  it("rejects a message without a seq", () => {
    const layout = layoutFor(MODE, REQ_UTC_HOUR, UTC_OFFSET, 10);
    expect(() => v3MessageToString(msgFor(layout, { seq: undefined }))).toThrow(/seq/);
  });

  it("breakdown produces the identical encoding and accounts every column", () => {
    const layout = layoutFor(MODE, REQ_UTC_HOUR, UTC_OFFSET, 29); // the full-coverage taper
    const m = msgFor(layout);
    const b = v3EncodeBreakdown(m);
    expect(b.encoded).toBe(v3MessageToString(m));
    expect(b.chars).toBe(b.encoded.length);
    expect(b.bodyBits).toBeGreaterThan(0);
    const names = b.columns.map((c) => c.name);
    expect(names).toContain("weathercode");
    expect(names).toContain("temp");
  });
});
