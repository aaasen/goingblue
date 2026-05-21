import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { existsSync, readFileSync, writeFileSync } from "fs";
import { dirname, join } from "path";
import { fileURLToPath } from "url";
import { DEFAULT_VARS_MASK } from "@weather/protocol";
import {
  aggregateRows,
  toFullPeriod,
  HOURS_PER_PERIOD,
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
      "cloud_cover", "cloud_cover_high", "cloud_cover_mid", "cloud_cover_low", "visibility",
    ];
    const params = new URLSearchParams({
      latitude: String(LAT),
      longitude: String(LON),
      hourly: vars.join(","),
      wind_speed_unit: "mph",
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
    visibility_m: 200,
  };
}

// ─── toFullPeriod unit tests ──────────────────────────────────────────────────

describe("toFullPeriod — 1h resolution (tenths of an inch)", () => {
  const hpp = HOURS_PER_PERIOD[4]; // 1

  it("0.00 cm → snow_in = 0", () => {
    expect(toFullPeriod(row(0.00), DEFAULT_VARS_MASK, "HRES", hpp).snow_in).toBe(0);
  });

  it("0.07 cm → snow_in = 0  (0.028 in, rounds down)", () => {
    expect(toFullPeriod(row(0.07), DEFAULT_VARS_MASK, "HRES", hpp).snow_in).toBe(0);
  });

  it("0.28 cm → snow_in = 1  (0.110 in → 0.1 in displayed)", () => {
    expect(toFullPeriod(row(0.28), DEFAULT_VARS_MASK, "HRES", hpp).snow_in).toBe(1);
  });

  it("0.56 cm → snow_in = 2  (0.220 in → 0.2 in displayed)", () => {
    expect(toFullPeriod(row(0.56), DEFAULT_VARS_MASK, "HRES", hpp).snow_in).toBe(2);
  });

  it("caps at 15 (= 1.5 in displayed)", () => {
    expect(toFullPeriod(row(100), DEFAULT_VARS_MASK, "HRES", hpp).snow_in).toBe(15);
  });
});

describe("toFullPeriod — daily resolution (whole inches)", () => {
  const hpp = HOURS_PER_PERIOD[0]; // 24

  it("0.00 cm → snow_in = 0", () => {
    expect(toFullPeriod(row(0.00), DEFAULT_VARS_MASK, "HRES", hpp).snow_in).toBe(0);
  });

  it("5.08 cm → snow_in = 2  (exactly 2.0 in)", () => {
    expect(toFullPeriod(row(5.08), DEFAULT_VARS_MASK, "HRES", hpp).snow_in).toBe(2);
  });

  it("1.27 cm → snow_in = 1  (0.5 in boundary rounds up)", () => {
    expect(toFullPeriod(row(1.27), DEFAULT_VARS_MASK, "HRES", hpp).snow_in).toBe(1);
  });

  it("caps at 15 in", () => {
    expect(toFullPeriod(row(1000), DEFAULT_VARS_MASK, "HRES", hpp).snow_in).toBe(15);
  });
});

// ─── aggregateRows integration tests ─────────────────────────────────────────

// Fixture times are in America/Anchorage (AKDT = UTC-8 in May).
// Midnight AKDT = 08:00 UTC. Pinning time here means no hours are filtered.
const FIXTURE_START_UTC = "2026-05-21T08:00:00Z";

describe("aggregateRows — 1h resolution", () => {
  let rows: Awaited<ReturnType<typeof aggregateRows>>[0];

  beforeAll(async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(FIXTURE_START_UTC));
    [rows] = await aggregateRows("HRES", N_DAYS, 4, LAT, LON, TZ, ELEV_M);
    vi.useRealTimers();
  });

  it("produces one row per hour", () => {
    expect(rows).toHaveLength(N_DAYS * 24);
  });

  it("each row's snow_cm equals the fixture's hourly snowfall value", () => {
    fixture.hourly.snowfall.forEach((val, i) => {
      expect(rows[i].snow_cm).toBeCloseTo(val, 5);
    });
  });

  it("0.28 cm hour produces snow_in = 1, not 0", () => {
    const idx = fixture.hourly.snowfall.findIndex((v) => v === 0.28);
    expect(idx).toBeGreaterThanOrEqual(0);
    const p = toFullPeriod(rows[idx], DEFAULT_VARS_MASK, "HRES", HOURS_PER_PERIOD[4]);
    expect(p.snow_in).toBe(1);
  });

  it("0.56 cm hour produces snow_in = 2", () => {
    const idx = fixture.hourly.snowfall.findIndex((v) => v === 0.56);
    expect(idx).toBeGreaterThanOrEqual(0);
    const p = toFullPeriod(rows[idx], DEFAULT_VARS_MASK, "HRES", HOURS_PER_PERIOD[4]);
    expect(p.snow_in).toBe(2);
  });

  it("hours with < 0.127 cm snowfall produce snow_in = 0", () => {
    const idx = fixture.hourly.snowfall.findIndex((v) => v > 0 && v < 0.127);
    expect(idx).toBeGreaterThanOrEqual(0);
    const p = toFullPeriod(rows[idx], DEFAULT_VARS_MASK, "HRES", HOURS_PER_PERIOD[4]);
    expect(p.snow_in).toBe(0);
  });
});

describe("aggregateRows — current time filtering", () => {
  // 10:00 AKDT = 18:00 UTC. Hours 00–09 should be excluded.
  const CURRENT_HOUR_AKDT = 10;
  const TIME_UTC = "2026-05-21T18:00:00Z";

  it("excludes past periods but always returns the full period count", async () => {
    // nDays=1 so fetching nDays+1=2 days fits within the 48-hour fixture.
    vi.useFakeTimers();
    vi.setSystemTime(new Date(TIME_UTC));
    const [rows] = await aggregateRows("HRES", 1, 4, LAT, LON, TZ, ELEV_M);
    vi.useRealTimers();

    expect(rows).toHaveLength(24); // always nDays * 24, not nDays * 24 - currentHour
    expect(rows[0].time).toBe(`2026-05-21T${String(CURRENT_HOUR_AKDT).padStart(2, "0")}:00`);
  });

  it("includes the current period (daily) even mid-day", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(TIME_UTC));
    const [rows] = await aggregateRows("HRES", N_DAYS, 0, LAT, LON, TZ, ELEV_M);
    vi.useRealTimers();

    expect(rows).toHaveLength(N_DAYS);
    expect(rows[0].time).toBe("2026-05-21T00:00");
  });
});

describe("aggregateRows — daily resolution", () => {
  let rows: Awaited<ReturnType<typeof aggregateRows>>[0];

  beforeAll(async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(FIXTURE_START_UTC));
    [rows] = await aggregateRows("HRES", N_DAYS, 0, LAT, LON, TZ, ELEV_M);
    vi.useRealTimers();
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

  it("daily snow_in is the summed total rounded to whole inches", () => {
    const sf = fixture.hourly.snowfall;
    const day0cm = sf.slice(0, 24).reduce((a, b) => a + b, 0);
    const expected = Math.min(Math.round(day0cm / 2.54), 15);
    const p = toFullPeriod(rows[0], DEFAULT_VARS_MASK, "HRES", HOURS_PER_PERIOD[0]);
    expect(p.snow_in).toBe(expected);
  });
});
