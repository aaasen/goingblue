import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { existsSync, readFileSync, writeFileSync } from "fs";
import { dirname, join } from "path";
import { fileURLToPath } from "url";
import { DEFAULT_VARS_MASK } from "@weather/protocol";
import {
  aggregateRows,
  toFullPeriod,
  type Row,
} from "../src/forecast.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURE_PATH = join(__dirname, "fixtures/openmeteo_hres_14k.json");

// 14k location, HRES model (ecmwf_ifs, no pressure-level vars)
const LAT = 63.063;
const LON = -151.081;
const TZ = "America/Anchorage";
const ELEV_M = 4267;
const N_DAYS = 2;

interface Fixture {
  hourly: {
    time: string[];
    snowfall: number[];
    [key: string]: unknown;
  };
  elevation: number;
}

let fixture: Fixture;

beforeAll(async () => {
  if (!existsSync(FIXTURE_PATH)) {
    // Fetch once from Open-Meteo and cache. Vars must match what fetchHourly
    // builds for HRES (MODEL_NO_PRESSURE excludes freezing_level_height).
    const vars = [
      "temperature_2m", "wind_speed_10m", "wind_direction_10m",
      "precipitation_probability", "weather_code", "snowfall",
      "cloud_cover", "cloud_cover_high", "cloud_cover_mid", "cloud_cover_low",
    ];
    const params = new URLSearchParams({
      latitude: String(LAT),
      longitude: String(LON),
      hourly: vars.join(","),
      timezone: TZ,
      forecast_days: String(N_DAYS),
      models: "ecmwf_ifs",
      elevation: String(ELEV_M),
    });
    const resp = await fetch(`https://api.open-meteo.com/v1/forecast?${params}`);
    if (!resp.ok) throw new Error(`fixture fetch failed: ${resp.status}`);
    fixture = await resp.json() as Fixture;
    writeFileSync(FIXTURE_PATH, JSON.stringify(fixture, null, 2));
  } else {
    fixture = JSON.parse(readFileSync(FIXTURE_PATH, "utf-8")) as Fixture;
  }

  vi.spyOn(globalThis, "fetch").mockResolvedValue({
    ok: true,
    json: async () => fixture,
    text: async () => "",
  } as unknown as Response);
});

afterAll(() => {
  vi.restoreAllMocks();
});

function row(snow_cm: number): Row {
  return {
    time: "2026-05-21T00:00",
    temp_max_c: -10,
    temp_min_c: -15,
    wind_speed_10m: 5,
    wind_direction_10m: 90,
    precip: 50,
    weathercode: 73,
    freezing_level_m: null,
    snow_cm,
    wind_speed_500hPa: null,
    wind_direction_500hPa: null,
    wind_speed_600hPa: null,
    wind_direction_600hPa: null,
    wind_speed_700hPa: null,
    wind_direction_700hPa: null,
    cloud_cover: 100,
    cloud_cover_high: 0,
    cloud_cover_mid: 90,
    cloud_cover_low: 100,
  };
}

// ─── toFullPeriod unit tests ──────────────────────────────────────────────────

describe("toFullPeriod — snow", () => {
  it("passes snow_cm through unchanged", () => {
    expect(toFullPeriod(row(0.28), DEFAULT_VARS_MASK, "HRES").snow_cm).toBe(0.28);
    expect(toFullPeriod(row(5.08), DEFAULT_VARS_MASK, "HRES").snow_cm).toBe(5.08);
    expect(toFullPeriod(row(100), DEFAULT_VARS_MASK, "HRES").snow_cm).toBe(100);
  });
});

// ─── aggregateRows integration tests ─────────────────────────────────────────

// aggregateRows now anchors to a client-supplied UTC start (hours since epoch), not "now". The
// mocked fixture's time labels are compared as plain strings, so we anchor at the fixture's first
// label ("2026-05-21T00:00") by passing the matching UTC epoch hour.
const hourFor = (iso: string) => Date.parse(iso) / 3600000;
const START_HOUR = hourFor("2026-05-21T00:00:00Z");

describe("aggregateRows — 1h resolution", () => {
  let rows: Awaited<ReturnType<typeof aggregateRows>>[0];

  beforeAll(async () => {
    [rows] = await aggregateRows("HRES", N_DAYS * 24, 4, LAT, LON, START_HOUR, ELEV_M);
  });

  it("produces one row per hour", () => {
    expect(rows).toHaveLength(N_DAYS * 24);
  });

  it("each row's snow_cm equals the fixture's hourly snowfall value", () => {
    fixture.hourly.snowfall.forEach((val, i) => {
      expect(rows[i].snow_cm).toBeCloseTo(val, 5);
    });
  });

  it("toFullPeriod passes snow_cm through from row", () => {
    const idx = fixture.hourly.snowfall.findIndex((v) => v === 0.28);
    expect(idx).toBeGreaterThanOrEqual(0);
    const p = toFullPeriod(rows[idx], DEFAULT_VARS_MASK, "HRES");
    expect(p.snow_cm).toBe(0.28);
  });
});

describe("aggregateRows — start anchoring", () => {
  it("starts at the requested hour and returns the full period count", async () => {
    // Anchor at hour 10; hours 00–09 are skipped. 24 hourly periods → fetches 2 days (fixture).
    const [rows] = await aggregateRows("HRES", 24, 4, LAT, LON, hourFor("2026-05-21T10:00:00Z"), ELEV_M);
    expect(rows).toHaveLength(24); // the full requested period count
    expect(rows[0].time).toBe("2026-05-21T10:00");
  });

  it("anchors a daily forecast to the day containing the (aligned) start", async () => {
    // The client aligns a daily start down to UTC midnight, so day 0 is included.
    const [rows] = await aggregateRows("HRES", N_DAYS, 0, LAT, LON, START_HOUR, ELEV_M);
    expect(rows).toHaveLength(N_DAYS);
    expect(rows[0].time).toBe("2026-05-21T00:00");
  });
});

describe("aggregateRows — daily resolution", () => {
  let rows: Awaited<ReturnType<typeof aggregateRows>>[0];

  beforeAll(async () => {
    [rows] = await aggregateRows("HRES", N_DAYS, 0, LAT, LON, START_HOUR, ELEV_M);
  });

  it("produces one row per day", () => {
    expect(rows).toHaveLength(N_DAYS);
  });

  it("daily snow_cm is the sum of all 24 hourly values", () => {
    const sf = fixture.hourly.snowfall;
    const day0 = sf.slice(0, 24).reduce((a, b) => a + b, 0);
    const day1 = sf.slice(24, 48).reduce((a, b) => a + b, 0);
    expect(rows[0].snow_cm).toBeCloseTo(day0, 5);
    expect(rows[1].snow_cm).toBeCloseTo(day1, 5);
  });

  it("toFullPeriod passes daily snow_cm through from row", () => {
    const p = toFullPeriod(rows[0], DEFAULT_VARS_MASK, "HRES");
    expect(p.snow_cm).toBe(rows[0].snow_cm);
  });
});
