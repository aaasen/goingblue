import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { existsSync, readFileSync, writeFileSync } from "fs";
import { dirname, join } from "path";
import { fileURLToPath } from "url";
import { DEFAULT_VARS_MASK, VARS_BIT } from "@weather/protocol";
import { Variable } from "@openmeteo/sdk/variable.js";
import {
  aggregateRows,
  toFullPeriod,
  type Row,
} from "../src/forecast.js";

// The production fetch path now decodes the Open-Meteo SDK (FlatBuffers) rather than JSON, so we
// mock the SDK and reconstruct a FlatBuffers-shaped WeatherApiResponse from the committed JSON
// fixture. This keeps the fixture human-readable and pinned (same values, same dates) while
// exercising the real decodeResponse path. State is populated in beforeAll; fetchWeatherApi only
// reads it when a test calls aggregateRows.
const mockState = vi.hoisted(() => ({ fixture: null as any, Variable: null as any }));

vi.mock("openmeteo", () => {
  // Invert an Open-Meteo request name into the SDK's (enum, altitude, pressureLevel) identity.
  const nameToTuple = (name: string): { base: string; altitude: number; pressureLevel: number } => {
    let m = name.match(/^(.*)_(\d+)hPa$/);
    if (m) return { base: m[1], altitude: 0, pressureLevel: Number(m[2]) };
    m = name.match(/^(.*)_(\d+)m$/);
    if (m) return { base: m[1], altitude: Number(m[2]), pressureLevel: 0 };
    return { base: name, altitude: 0, pressureLevel: 0 };
  };
  const fetchWeatherApi = async () => {
    const { fixture, Variable: V } = mockState;
    const times: string[] = fixture.hourly.time;
    const startSec = Date.parse(times[0] + ":00Z") / 1000;
    const interval = 3600;
    const vars = Object.keys(fixture.hourly)
      .filter((k) => k !== "time")
      .map((name) => {
        const { base, altitude, pressureLevel } = nameToTuple(name);
        const values = Float32Array.from(
          (fixture.hourly[name] as (number | null)[]).map((v) => (v == null ? NaN : v)),
        );
        return {
          variable: () => V[base],
          altitude: () => altitude,
          pressureLevel: () => pressureLevel,
          valuesArray: () => values,
        };
      });
    const hourly = {
      time: () => BigInt(startSec),
      timeEnd: () => BigInt(startSec + times.length * interval),
      interval: () => interval,
      variablesLength: () => vars.length,
      variables: (i: number) => vars[i],
    };
    return [{ hourly: () => hourly, elevation: () => fixture.elevation, utcOffsetSeconds: () => 0 }];
  };
  return { fetchWeatherApi };
});

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURE_PATH = join(__dirname, "fixtures/openmeteo_hres_14k.json");

// 14k location, European center's surface source (ecmwf_ifs / HRES 9 km — no freeze, no
// pressure-level vars; the split-source EU path merges pressure levels from ecmwf_ifs025)
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
    // Fetch once from Open-Meteo and cache. Vars must match what fetchHourly builds for the
    // European surface source (ecmwf_ifs has no freezing_level_height or pressure-level vars).
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
    // The fixture is stored as JSON for readability; regenerate it via the JSON endpoint (the
    // SDK mock doesn't intercept a raw fetch). Runtime decoding of this data goes through the
    // mocked SDK below.
    const resp = await fetch(`https://api.open-meteo.com/v1/forecast?${params}`);
    if (!resp.ok) throw new Error(`fixture fetch failed: ${resp.status}`);
    fixture = await resp.json() as Fixture;
    writeFileSync(FIXTURE_PATH, JSON.stringify(fixture, null, 2));
  } else {
    fixture = JSON.parse(readFileSync(FIXTURE_PATH, "utf-8")) as Fixture;
  }

  // Feed the fixture to the mocked SDK; fetchWeatherApi rebuilds a FlatBuffers-shaped response
  // from it on every call, so aggregateRows decodes the pinned data through the production path.
  mockState.fixture = fixture;
  mockState.Variable = Variable;
});

afterAll(() => {
  vi.restoreAllMocks();
});

function row(snow_cm: number): Row {
  return {
    time: "2026-05-21T00:00",
    temp_c: -10,
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
    expect(toFullPeriod(row(0.28), DEFAULT_VARS_MASK, "EU").snow_cm).toBe(0.28);
    expect(toFullPeriod(row(5.08), DEFAULT_VARS_MASK, "EU").snow_cm).toBe(5.08);
    expect(toFullPeriod(row(100), DEFAULT_VARS_MASK, "EU").snow_cm).toBe(100);
  });
});

describe("toFullPeriod — temp", () => {
  const maskWithTemp = DEFAULT_VARS_MASK | (1 << VARS_BIT.temp);

  it("passes the representative temp through when the temp bit is set", () => {
    const p = toFullPeriod(row(0), maskWithTemp, "EU");
    expect(p.temp_c).toBe(-10);
  });

  it("omits temp when the bit is unset", () => {
    expect(toFullPeriod(row(0), DEFAULT_VARS_MASK, "EU").temp_c).toBeUndefined();
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
    [rows] = await aggregateRows("EU", N_DAYS * 24, 4, LAT, LON, START_HOUR, ELEV_M);
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
    const p = toFullPeriod(rows[idx], DEFAULT_VARS_MASK, "EU");
    expect(p.snow_cm).toBe(0.28);
  });
});

describe("aggregateRows — start anchoring", () => {
  it("starts at the requested hour and returns the full period count", async () => {
    // Anchor at hour 10; hours 00–09 are skipped. 24 hourly periods → fetches 2 days (fixture).
    const [rows] = await aggregateRows("EU", 24, 4, LAT, LON, hourFor("2026-05-21T10:00:00Z"), ELEV_M);
    expect(rows).toHaveLength(24); // the full requested period count
    expect(rows[0].time).toBe("2026-05-21T10:00");
  });

  it("anchors a daily forecast to the day containing the (aligned) start", async () => {
    // The client aligns a daily start down to UTC midnight, so day 0 is included.
    const [rows] = await aggregateRows("EU", N_DAYS, 0, LAT, LON, START_HOUR, ELEV_M);
    expect(rows).toHaveLength(N_DAYS);
    expect(rows[0].time).toBe("2026-05-21T00:00");
  });
});

describe("aggregateRows — daily resolution", () => {
  let rows: Awaited<ReturnType<typeof aggregateRows>>[0];

  beforeAll(async () => {
    [rows] = await aggregateRows("EU", N_DAYS, 0, LAT, LON, START_HOUR, ELEV_M);
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
    const p = toFullPeriod(rows[0], DEFAULT_VARS_MASK, "EU");
    expect(p.snow_cm).toBe(rows[0].snow_cm);
  });
});
