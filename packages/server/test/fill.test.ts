import { describe, expect, it } from "vitest";
import { CODECS, layoutFor, maxFillSeq, slotsFor, decodeMessage, DEFAULT_VARS_MASK, VARS_BIT, type RequestContext } from "@weather/protocol";
import { encodeFillSeq, fitFillToBudget, type ForecastParams, type HourlyData } from "../src/forecast.js";

// ── Synthetic hourly data ───────────────────────────────────────────────────
// 13 days of hourly samples starting a day before the request, mirroring the v2 fetch
// (past_days=1, forecast_days = D + 2). Values vary smoothly so delta columns get realistic
// (compressible) content, with enough movement that finer layouts cost more bits.

const UTC_OFFSET = -9;
const DURATION_DAYS = 10;
// A D-day request covers D + 1 day slots (the rest of the request day, then D whole days), and
// the fill ladder steps over slots — so seq milestones are multiples of SLOTS, not DURATION_DAYS.
const SLOTS = slotsFor(DURATION_DAYS);
// Request at 13:00 local on 2026-07-12.
const REQ_UTC_HOUR = Date.UTC(2026, 6, 12, 13) / 3600000 - UTC_OFFSET;

function isoHour(epochHour: number): string {
  return new Date(epochHour * 3600000).toISOString().slice(0, 16);
}

function syntheticHourly(startUtcHour: number, nHours: number): { h: HourlyData; times: string[] } {
  const times: string[] = [];
  const col = (fn: (i: number) => number | null): (number | null)[] =>
    Array.from({ length: nHours }, (_, i) => fn(i));
  for (let i = 0; i < nHours; i++) times.push(isoHour(startUtcHour + i));
  const h: HourlyData = {
    time: times,
    temperature_2m: col((i) => -5 + 8 * Math.sin((i / 24) * 2 * Math.PI) + i * 0.05),
    wind_speed_10m: col((i) => 10 + 6 * Math.sin(i / 5)),
    wind_direction_10m: col((i) => (180 + i * 3) % 360),
    precipitation_probability: col((i) => (i % 48 < 24 ? 10 : 60)),
    weather_code: col((i) => (i % 48 < 24 ? 2 : 71)),
    freezing_level_height: col((i) => 2500 + 400 * Math.sin(i / 30)),
    snowfall: col((i) => (i % 48 >= 24 ? 0.3 : 0)),
    rain: col(() => 0),
    showers: col(() => 0),
    cloud_cover: col((i) => (i * 7) % 101),
    cloud_cover_high: col((i) => (i * 5) % 101),
    cloud_cover_mid: col((i) => (i * 3) % 101),
    cloud_cover_low: col((i) => (i * 11) % 101),
    wind_speed_500hPa: col((i) => 40 + 10 * Math.sin(i / 8)),
    wind_direction_500hPa: col((i) => (270 + i) % 360),
    wind_speed_600hPa: col((i) => 30 + 8 * Math.sin(i / 9)),
    wind_direction_600hPa: col((i) => (250 + i) % 360),
    wind_speed_700hPa: col((i) => 20 + 6 * Math.sin(i / 10)),
    wind_direction_700hPa: col((i) => (230 + i) % 360),
  };
  return { h, times };
}

const DATA_START = Math.floor(REQ_UTC_HOUR / 24) * 24 - 24;
const { h: HOURLY, times: TIMES } = syntheticHourly(DATA_START, 13 * 24);

const TEST_VARS = DEFAULT_VARS_MASK | (1 << VARS_BIT.temp) | (1 << VARS_BIT.wind);

function params(overrides: Partial<ForecastParams> = {}): ForecastParams {
  return {
    locationIdx: 0,
    lat: 63.135,
    lon: -150.989,
    durationDays: DURATION_DAYS,
    utcOffsetHours: UTC_OFFSET,
    modelsMask: 0b010, // American (US): has freeze + pressure-level vars, so nothing is masked off
    varsMask: TEST_VARS,
    maxChars: 160,
    decoderVersion: 1,
    code: 7,
    startEpochHour: REQ_UTC_HOUR,
    userToken: null,
    ...overrides,
  };
}

const codec = CODECS[1];

function encodeSeq(p: ForecastParams) {
  return (seq: number) =>
    encodeFillSeq(HOURLY, TIMES, p, seq, p.lat!, p.lon!, 500, "US", codec);
}

// The context a client would store for this request (see BuilderTab), used to decode replies.
const ctx: RequestContext = {
  model: 1, // American (US)
  vars_mask: TEST_VARS,
  lat: 63.135,
  lon: -150.989,
  start: REQ_UTC_HOUR * 3600000,
  durationDays: DURATION_DAYS,
  utcOffsetHours: UTC_OFFSET,
};

describe("encodeFillSeq", () => {
  it("encodes a decodable message for every seq", () => {
    const enc = encodeSeq(params());
    for (let seq = 1; seq <= maxFillSeq(DURATION_DAYS); seq++) {
      const encoded = enc(seq);
      expect(encoded, `seq ${seq}`).not.toBeNull();
      const decoded = decodeMessage(encoded!, () => ctx);
      expect(decoded.seq).toBe(seq);
      const layout = layoutFor(DURATION_DAYS, REQ_UTC_HOUR, UTC_OFFSET, seq);
      expect(decoded.periodHours).toEqual(layout.periodHours);
      expect(decoded.periods[0]).toHaveLength(layout.periodHours.length);
    }
  });

  it("encoded size grows along the sequence (sampled at stage boundaries)", () => {
    const enc = encodeSeq(params());
    const sizes = [1, SLOTS, 2 * SLOTS, 3 * SLOTS, 4 * SLOTS]
      .map((s) => enc(s)!.length);
    for (let i = 1; i < sizes.length; i++) {
      expect(sizes[i]).toBeGreaterThan(sizes[i - 1]);
    }
  });

  it("returns null when the upstream data doesn't cover the window", () => {
    // Data ending after 5 days can't serve the full 10-day layout.
    const short = syntheticHourly(DATA_START, 5 * 24);
    const p = params();
    const encoded = encodeFillSeq(short.h, short.times, p, DURATION_DAYS, p.lat!, p.lon!, 500, "US", codec);
    expect(encoded).toBeNull();
  });

  it("aggregates day 0's 12h period from local noon, including the hour before the request", () => {
    const enc = encodeSeq(params());
    const decoded = decodeMessage(enc(SLOTS)!, () => ctx);
    // Day 0's first period spans local 12:00–24:00 and is that local day's only window, so the
    // representative sample is the window max — computed over the complete period, including
    // the hour before the 13:00 request.
    const day0Local = Math.floor((REQ_UTC_HOUR + UTC_OFFSET) / 24) * 24;
    const dayTemps = HOURLY.temperature_2m.slice(
      day0Local + 12 - UTC_OFFSET - DATA_START, day0Local - UTC_OFFSET - DATA_START + 24) as number[];
    expect(decoded.periods[0][0].temp_c).toBe(Math.round(Math.max(...dayTemps)));
  });
});

describe("fitFillToBudget", () => {
  it("fills a 160-char budget past the all-12h layout and stays within it", () => {
    const encoded = fitFillToBudget(encodeSeq(params()), (e) => e.length, maxFillSeq(DURATION_DAYS), 160)!;
    expect(encoded.length).toBeLessThanOrEqual(160);
    const decoded = decodeMessage(encoded, () => ctx);
    expect(decoded.seq!).toBeGreaterThan(SLOTS); // refined at least one day
    expect(decoded.days).toBe(SLOTS);            // full duration covered
  });

  it("a larger budget never yields a smaller seq", () => {
    const enc = encodeSeq(params());
    let prevSeq = 0;
    for (const budget of [80, 160, 320, 640, 1280]) {
      const encoded = fitFillToBudget(enc, (e) => e.length, maxFillSeq(DURATION_DAYS), budget)!;
      const seq = decodeMessage(encoded, () => ctx).seq!;
      expect(seq).toBeGreaterThanOrEqual(prevSeq);
      prevSeq = seq;
    }
  });

  it("a huge budget reaches the all-1h layout", () => {
    const encoded = fitFillToBudget(encodeSeq(params()), (e) => e.length, maxFillSeq(DURATION_DAYS), 100000)!;
    expect(decodeMessage(encoded, () => ctx).seq).toBe(maxFillSeq(DURATION_DAYS));
  });

  it("truncates to fewer 12h days when even the full duration doesn't fit", () => {
    const encoded = fitFillToBudget(encodeSeq(params()), (e) => e.length, maxFillSeq(DURATION_DAYS), 40)!;
    const decoded = decodeMessage(encoded, () => ctx);
    expect(decoded.seq!).toBeLessThan(SLOTS);
    expect(decoded.days).toBe(decoded.seq);
    expect(decoded.periodHours!.every((ph) => ph === 12)).toBe(true);
  });

  it("returns the seq=1 layout even when it exceeds the budget", () => {
    const encoded = fitFillToBudget(encodeSeq(params()), (e) => e.length, maxFillSeq(DURATION_DAYS), 1)!;
    expect(decodeMessage(encoded, () => ctx).seq).toBe(1);
  });
});
