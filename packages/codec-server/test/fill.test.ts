import { describe, expect, it } from "vitest";
import {
  CODECS, layoutFor, maxFillSeq, FILL_SLOTS, MODE_DETAIL, MODE_AUTO, MODE_RANGE,
  decodeMessage, DEFAULT_VARS_MASK, VARS_BIT, type RequestContext,
} from "@weather/protocol";
import { encodeFillSeq, fitFillToBudget, type ForecastParams, type HourlyData } from "../src/forecast.js";

// ── Synthetic hourly data ───────────────────────────────────────────────────
// 15 days of hourly samples starting a day before the request, mirroring the fetch
// (past_days=1, forecast_days = FILL_SLOTS + 2). Values vary smoothly so delta columns get
// realistic (compressible) content, with enough movement that finer layouts cost more bits.

const UTC_OFFSET = -9;
const MODES = [MODE_DETAIL, MODE_AUTO, MODE_RANGE];
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
    wind_gusts_10m: col((i) => 18 + 9 * Math.sin(i / 5)),
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
const { h: HOURLY, times: TIMES } = syntheticHourly(DATA_START, (FILL_SLOTS + 2) * 24);

const TEST_VARS = DEFAULT_VARS_MASK | (1 << VARS_BIT.temp) | (1 << VARS_BIT.wind);

function params(overrides: Partial<ForecastParams> = {}): ForecastParams {
  return {
    locationIdx: 0,
    lat: 63.135,
    lon: -150.989,
    mode: MODE_AUTO,
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

function encodeSeq(p: ForecastParams, h = HOURLY, times = TIMES) {
  return (seq: number) =>
    encodeFillSeq(h, times, p, seq, p.lat!, p.lon!, 500, "US", codec);
}

// The context a client would store for this request (see BuilderTab), used to decode replies.
const ctxFor = (mode: number): RequestContext => ({
  model: 1, // American (US)
  vars_mask: TEST_VARS,
  lat: 63.135,
  lon: -150.989,
  start: REQ_UTC_HOUR * 3600000,
  mode,
  utcOffsetHours: UTC_OFFSET,
});
const ctx = ctxFor(MODE_AUTO);

describe("encodeFillSeq", () => {
  it("encodes a decodable message for every seq of every mode", () => {
    for (const mode of MODES) {
      const enc = encodeSeq(params({ mode }));
      for (let seq = 1; seq <= maxFillSeq(mode); seq++) {
        const encoded = enc(seq);
        expect(encoded, `mode ${mode} seq ${seq}`).not.toBeNull();
        const decoded = decodeMessage(encoded!, () => ctxFor(mode));
        expect(decoded.seq).toBe(seq);
        const layout = layoutFor(mode, REQ_UTC_HOUR, UTC_OFFSET, seq);
        expect(decoded.periodHours).toEqual(layout.periodHours);
        expect(decoded.periods[0]).toHaveLength(layout.periodHours.length);
      }
    }
  });

  it("encoded size grows along the path (sampled at Range's uniform waypoints)", () => {
    const enc = encodeSeq(params({ mode: MODE_RANGE }));
    const sizes = [1, FILL_SLOTS, 2 * FILL_SLOTS, 3 * FILL_SLOTS, maxFillSeq(MODE_RANGE)]
      .map((s) => enc(s)!.length);
    for (let i = 1; i < sizes.length; i++) {
      expect(sizes[i]).toBeGreaterThan(sizes[i - 1]);
    }
  });

  it("returns null when the upstream data doesn't cover the window", () => {
    // Data ending after 5 days can't serve the full-coverage 12h layout.
    const short = syntheticHourly(DATA_START, 5 * 24);
    const p = params({ mode: MODE_RANGE });
    const encoded = encodeFillSeq(short.h, short.times, p, FILL_SLOTS, p.lat!, p.lon!, 500, "US", codec);
    expect(encoded).toBeNull();
  });

  it("treats all-null periods as unservable (a model's horizon ending early)", () => {
    // Times exist for the whole window but temperature goes null past day 10 — what Open-Meteo
    // returns for GEM beyond its 240h horizon.
    const gemLike: HourlyData = {
      ...HOURLY,
      temperature_2m: HOURLY.temperature_2m.map((v, i) => (i < 11 * 24 ? v : null)),
    };
    const p = params({ mode: MODE_RANGE });
    const enc = encodeSeq(p, gemLike, TIMES);
    expect(enc(FILL_SLOTS)).toBeNull(); // full coverage reaches past the data
    expect(enc(10)).not.toBeNull();     // 10 slots stay inside it
  });

  it("aggregates day 0's 12h period from local noon, including the hour before the request", () => {
    const enc = encodeSeq(params({ mode: MODE_RANGE }));
    const decoded = decodeMessage(enc(FILL_SLOTS)!, () => ctxFor(MODE_RANGE));
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
  it("fills a 160-char budget past the coverage baseline and stays within it", () => {
    const encoded = fitFillToBudget(encodeSeq(params()), (e) => e.length, maxFillSeq(MODE_AUTO), 160)!;
    expect(encoded.length).toBeLessThanOrEqual(160);
    const decoded = decodeMessage(encoded, () => ctx);
    expect(decoded.periodHours!.some((ph) => ph < 12)).toBe(true); // refined something
    expect(decoded.days).toBeGreaterThanOrEqual(7);                // Auto keeps coverage too
  });

  it("a larger budget never yields a smaller seq", () => {
    const enc = encodeSeq(params());
    let prevSeq = 0;
    for (const budget of [80, 160, 320, 640, 1280]) {
      const encoded = fitFillToBudget(enc, (e) => e.length, maxFillSeq(MODE_AUTO), budget)!;
      const seq = decodeMessage(encoded, () => ctx).seq!;
      expect(seq).toBeGreaterThanOrEqual(prevSeq);
      prevSeq = seq;
    }
  });

  it("a huge budget reaches every mode's path top", () => {
    for (const mode of MODES) {
      const encoded = fitFillToBudget(
        encodeSeq(params({ mode })), (e) => e.length, maxFillSeq(mode), 100000)!;
      expect(decodeMessage(encoded, () => ctxFor(mode)).seq).toBe(maxFillSeq(mode));
    }
  });

  it("truncates to fewer 12h days when even the coverage baseline doesn't fit", () => {
    const encoded = fitFillToBudget(
      encodeSeq(params({ mode: MODE_RANGE })), (e) => e.length, maxFillSeq(MODE_RANGE), 40)!;
    const decoded = decodeMessage(encoded, () => ctxFor(MODE_RANGE));
    expect(decoded.seq!).toBeLessThan(FILL_SLOTS);
    expect(decoded.days).toBe(decoded.seq);
    expect(decoded.periodHours!.every((ph) => ph === 12)).toBe(true);
  });

  it("clamps the fill to the model's data horizon", () => {
    // GEM-like nulls past day 10: even an unlimited budget must stop at layouts the data
    // covers (coverage only grows along the path, so servability is a clean upper bound).
    const gemLike: HourlyData = {
      ...HOURLY,
      temperature_2m: HOURLY.temperature_2m.map((v, i) => (i < 11 * 24 ? v : null)),
    };
    const p = params({ mode: MODE_RANGE });
    const encoded = fitFillToBudget(
      encodeSeq(p, gemLike, TIMES), (e) => e.length, maxFillSeq(MODE_RANGE), 100000)!;
    const decoded = decodeMessage(encoded, () => ctxFor(MODE_RANGE));
    expect(decoded.days).toBeLessThanOrEqual(10);
  });

  it("returns the seq=1 layout even when it exceeds the budget", () => {
    const encoded = fitFillToBudget(encodeSeq(params()), (e) => e.length, maxFillSeq(MODE_AUTO), 1)!;
    expect(decodeMessage(encoded, () => ctx).seq).toBe(1);
  });
});
