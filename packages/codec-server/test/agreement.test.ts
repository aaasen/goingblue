import { describe, it, expect } from "vitest";
import { layoutFor, MODE_RANGE, ALWAYS_VARS, VAR, type Variable } from "@weather/protocol";
import {
  agreementLevel, computeAgreementLevels, precipCategory,
  PRECIP_NONE, PRECIP_TRACE, PRECIP_LIGHT, PRECIP_HEAVY,
} from "../src/agreement.ts";
import {
  buildLayoutMessage, type AgreementHourly, type HourlyData, type ForecastParams, type Row,
} from "../src/forecast.ts";

// The level reads three fields; everything else on Row is irrelevant to it.
const row = (over: Partial<Row> = {}): Row => ({
  temp_c: -5, snow_cm: 0, rain_mm: 0,
  ...over,
} as Row);

describe("precipCategory", () => {
  it("is None only when rain and snow both quantize to 0", () => {
    expect(precipCategory(row(), 12)).toBe(PRECIP_NONE);
    expect(precipCategory(row({ rain_mm: 0.005 }), 12)).toBe(PRECIP_NONE);
    expect(precipCategory(row({ rain_mm: 0.02 }), 12)).toBe(PRECIP_TRACE);
    expect(precipCategory(row({ snow_cm: 0.02 }), 12)).toBe(PRECIP_TRACE);
  });

  it("cuts on the mean hourly rate, not the period total", () => {
    expect(precipCategory(row({ rain_mm: 1.1 }), 12)).toBe(PRECIP_TRACE);
    expect(precipCategory(row({ rain_mm: 1.1 }), 3)).toBe(PRECIP_LIGHT);
    expect(precipCategory(row({ rain_mm: 11 }), 12)).toBe(PRECIP_LIGHT);
    expect(precipCategory(row({ rain_mm: 12 }), 12)).toBe(PRECIP_HEAVY);
  });

  it("keeps Open-Meteo's smallest hourly amounts in Trace", () => {
    // Open-Meteo reports rain in 0.1 mm steps; the app shows these hours as <0.01 in.
    expect(precipCategory(row({ rain_mm: 0.1 }), 1)).toBe(PRECIP_TRACE);
    expect(precipCategory(row({ rain_mm: 0.2 }), 1)).toBe(PRECIP_TRACE);
    expect(precipCategory(row({ snow_cm: 0.07 }), 1)).toBe(PRECIP_TRACE);
    expect(precipCategory(row({ rain_mm: 0.3 }), 1)).toBe(PRECIP_LIGHT);
  });

  it("counts snow as liquid equivalent at 0.7 cm/mm", () => {
    // 8.4 cm of snow = 12 mm water over 12 h = 1 mm/h.
    expect(precipCategory(row({ snow_cm: 8.4 }), 12)).toBe(PRECIP_HEAVY);
    expect(precipCategory(row({ snow_cm: 8.3 }), 12)).toBe(PRECIP_LIGHT);
  });
});

describe("agreementLevel", () => {
  it("reads the matrix by both sides' categories", () => {
    const none = row();
    const trace = row({ rain_mm: 0.5 });
    const light = row({ rain_mm: 5 });
    const heavy = row({ rain_mm: 20 });
    const lv = (a: Row, b: Row) => agreementLevel(a, b, 12);
    expect(lv(none, none)).toBe(3);
    expect(lv(none, trace)).toBe(1);
    expect(lv(light, none)).toBe(0);
    expect(lv(none, heavy)).toBe(0);
    expect(lv(trace, light)).toBe(2);
    expect(lv(heavy, trace)).toBe(1);
    expect(lv(light, heavy)).toBe(2);
    expect(lv(heavy, heavy)).toBe(3);
  });

  it("ignores temperature, wind, and phase", () => {
    expect(agreementLevel(row({ temp_c: 0, rain_mm: 7 }),
      row({ temp_c: 20, snow_cm: 4.9 }), 12)).toBe(3);
  });

  it("returns null when either side has no data", () => {
    expect(agreementLevel(row({ temp_c: null }), row(), 12)).toBeNull();
    expect(agreementLevel(row(), row({ temp_c: null }), 12)).toBeNull();
  });
});

describe("computeAgreementLevels", () => {
  it("maps each period to a level and missing data to null", () => {
    const served = [row(), row(), row()];
    const center = [row(), null as unknown as Row, row({ rain_mm: 20 })];
    const levels = computeAgreementLevels(served, center, [12, 12, 12]);
    expect(levels).toEqual([3, null, 0]);
  });

  it("returns all nulls for an absent center", () => {
    expect(computeAgreementLevels([row(), row()], null, [12, 12])).toEqual([null, null]);
  });
});

describe("buildLayoutMessage agreement integration", () => {
  // Synthetic hourly data over the layout's window: flat fields, so every period aggregates to
  // the same row and the expected level is easy to state.
  const mkHourly = (startUtcHour: number, nHours: number, rainMm: number): { h: HourlyData; times: string[] } => {
    const times = Array.from({ length: nHours }, (_, i) =>
      new Date((startUtcHour + i) * 3600_000).toISOString().slice(0, 16));
    const flat = (v: number | null) => times.map(() => v);
    const h = {
      time: times,
      temperature_2m: flat(-5),
      wind_speed_10m: flat(20),
      wind_direction_10m: flat(270),
      wind_gusts_10m: flat(30),
      snowfall: flat(0),
      rain: flat(rainMm),
      showers: flat(0),
      cloud_cover: flat(10),
      weather_code: flat(3),
    } as unknown as HourlyData;
    return { h, times };
  };

  it("aggregates each center through the layout and attaches per-period levels", () => {
    const startEpochHour = Math.floor(Date.UTC(2026, 4, 20) / 3600_000);
    const layout = layoutFor(MODE_RANGE, startEpochHour, 0, 2); // 12h ramp, seq 2
    const first = layout.periodStartUtcHour[0];
    const span = layout.periodStartUtcHour.at(-1)! + layout.periodHours.at(-1)! - first;
    const served = mkHourly(first, span, 0);
    const params = {
      decoderVersion: 4, code: 0, mode: MODE_RANGE, startEpochHour, utcOffsetHours: 0,
      modelsMask: 0b0001, vars: new Set<Variable>([...ALWAYS_VARS, VAR.agreement]),
    } as unknown as ForecastParams;
    const agreement: AgreementHourly = [
      mkHourly(first, span, 0),   // US: identical → strong agreement
      mkHourly(first, span, 5),   // CA: heavy vs none → strong disagreement
      null,                        // EU: unavailable → null levels
    ];
    const msg = buildLayoutMessage(
      served.h, served.times, params, layout, 63.1, -151.0, 500, "BEST", agreement)!;
    expect(msg).not.toBeNull();
    for (const p of msg.periods[0]) expect(p.agreement).toEqual([3, 0, null]);
  });

  it("attaches nothing when the variable is not requested", () => {
    const startEpochHour = Math.floor(Date.UTC(2026, 4, 20) / 3600_000);
    const layout = layoutFor(MODE_RANGE, startEpochHour, 0, 2);
    const first = layout.periodStartUtcHour[0];
    const span = layout.periodStartUtcHour.at(-1)! + layout.periodHours.at(-1)! - first;
    const served = mkHourly(first, span, 0);
    const params = {
      decoderVersion: 4, code: 0, mode: MODE_RANGE, startEpochHour, utcOffsetHours: 0,
      modelsMask: 0b0001, vars: new Set<Variable>(ALWAYS_VARS),
    } as unknown as ForecastParams;
    const msg = buildLayoutMessage(
      served.h, served.times, params, layout, 63.1, -151.0, 500, "BEST",
      [mkHourly(first, span, 0), null, null])!;
    for (const p of msg.periods[0]) expect(p.agreement).toBeUndefined();
  });
});
