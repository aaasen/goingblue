import { describe, it, expect } from "vitest";
import { layoutFor, MODE_RANGE, ALWAYS_VARS, VAR, type Variable } from "@weather/protocol";
import { agreementScore, computeAgreementLevels, forceContinuous } from "../src/agreement.ts";
import {
  buildLayoutMessage, type AgreementHourly, type HourlyData, type ForecastParams, type Row,
} from "../src/forecast.ts";

// The score reads seven fields; everything else on Row is irrelevant to it.
const row = (over: Partial<Row> = {}): Row => ({
  temp_c: -5, wind_speed_10m: 20, wind_direction_10m: 270, snow_cm: 0, rain_mm: 0,
  ...over,
} as Row);

describe("agreementScore", () => {
  it("scores identical periods as full agreement", () => {
    expect(agreementScore(row(), row(), 12)).toBeCloseTo(1, 5);
  });

  it("returns null when either side is missing an input", () => {
    expect(agreementScore(row({ temp_c: null }), row(), 12)).toBeNull();
    expect(agreementScore(row(), row({ wind_speed_10m: null }), 12)).toBeNull();
  });

  it("ignores wind deltas inside the half-force deadband", () => {
    // 20 vs 24 kph are both inside force 4 (20..29): well under half a force apart.
    expect(agreementScore(row(), row({ wind_speed_10m: 24 }), 12)).toBeCloseTo(1, 5);
  });

  it("zeroes the temp component at 5 degC apart", () => {
    const s = agreementScore(row({ temp_c: 0 }), row({ temp_c: 6 }), 12)!;
    // soft-min with one floored component: well into the bottom level.
    expect(s).toBeLessThan(0.2);
  });

  it("scores opposite wind directions as wind disagreement, gated on force 2", () => {
    const opposite = agreementScore(row(), row({ wind_direction_10m: 90 }), 12)!;
    expect(opposite).toBeLessThan(0.25);
    // Below the gate (force <= 1, under 6 kph) direction is dither and does not score.
    const calm = agreementScore(
      row({ wind_speed_10m: 4 }), row({ wind_speed_10m: 4, wind_direction_10m: 90 }), 12)!;
    expect(calm).toBeCloseTo(1, 5);
  });

  it("scores a split precip vote by the wet side's rate", () => {
    const drizzle = agreementScore(row(), row({ rain_mm: 1 }), 12)!;   // trace over 12h
    const storm = agreementScore(row(), row({ rain_mm: 30 }), 12)!;    // 2.5 mm/h: full split
    expect(drizzle).toBeGreaterThan(storm);
    expect(storm).toBeLessThan(0.15);
  });

  it("treats snow and rain as one total water equivalent", () => {
    // 7 mm of rain vs 4.9 cm of snow (= 7 mm water): same total, phase left to the temp term.
    const s = agreementScore(row({ rain_mm: 7 }), row({ snow_cm: 4.9 }), 12)!;
    expect(s).toBeCloseTo(1, 2);
  });

  it("ignores cloud cover entirely (removed from the metric 2026-09-01)", () => {
    expect(agreementScore(row({ cloud_cover: 0 } as Partial<Row>),
      row({ cloud_cover: 100 } as Partial<Row>), 12)!).toBeCloseTo(1, 5);
  });
});

describe("computeAgreementLevels", () => {
  it("maps scores to levels and missing data to null", () => {
    const served = [row(), row(), row({ temp_c: 0 })];
    const center = [row(), null as unknown as Row, row({ temp_c: 20 })];
    const levels = computeAgreementLevels(served, [center[0], center[1], center[2]], [12, 12, 12]);
    expect(levels[0]).toBe(3);
    expect(levels[1]).toBeNull();
    expect(levels[2]).toBe(0);
  });

  it("returns all nulls for an absent center", () => {
    expect(computeAgreementLevels([row(), row()], null, [12, 12])).toEqual([null, null]);
  });
});

describe("buildLayoutMessage agreement integration", () => {
  // Synthetic hourly data over the layout's window: flat fields, so every period aggregates to
  // the same row and the expected level is easy to state.
  const mkHourly = (startUtcHour: number, nHours: number, tempC: number): { h: HourlyData; times: string[] } => {
    const times = Array.from({ length: nHours }, (_, i) =>
      new Date((startUtcHour + i) * 3600_000).toISOString().slice(0, 16));
    const flat = (v: number | null) => times.map(() => v);
    const h = {
      time: times,
      temperature_2m: flat(tempC),
      wind_speed_10m: flat(20),
      wind_direction_10m: flat(270),
      wind_gusts_10m: flat(30),
      snowfall: flat(0),
      rain: flat(0),
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
    const served = mkHourly(first, span, -5);
    const params = {
      decoderVersion: 4, code: 0, mode: MODE_RANGE, startEpochHour, utcOffsetHours: 0,
      modelsMask: 0b0001, vars: new Set<Variable>([...ALWAYS_VARS, VAR.agreement]),
    } as unknown as ForecastParams;
    const agreement: AgreementHourly = [
      mkHourly(first, span, -5),   // US: identical → strong agreement
      mkHourly(first, span, -25),  // CA: 20 degC apart → strong disagreement
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
    const served = mkHourly(first, span, -5);
    const params = {
      decoderVersion: 4, code: 0, mode: MODE_RANGE, startEpochHour, utcOffsetHours: 0,
      modelsMask: 0b0001, vars: new Set<Variable>(ALWAYS_VARS),
    } as unknown as ForecastParams;
    const msg = buildLayoutMessage(
      served.h, served.times, params, layout, 63.1, -151.0, 500, "BEST",
      [mkHourly(first, span, -5), null, null])!;
    for (const p of msg.periods[0]) expect(p.agreement).toBeUndefined();
  });
});

describe("forceContinuous", () => {
  it("is continuous across band bounds and clamps at the top", () => {
    expect(forceContinuous(0)).toBe(0);
    expect(forceContinuous(6)).toBeCloseTo(2, 5);   // force 2 lower bound
    expect(forceContinuous(9)).toBeCloseTo(2.5, 5); // halfway through force 2 (6..12)
    expect(forceContinuous(999)).toBe(17);
  });
});
