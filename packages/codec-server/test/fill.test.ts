import { describe, expect, it } from "vitest";
import {
  wireCodec, WIRE_VERSION, layoutFor, maxFillSeq, fillProfile, effectiveMode, FILL_SLOTS,
  MODE_DETAIL, MODE_AUTO, MODE_RANGE,
  decodeMessage, DEFAULT_VARS, VAR, type Variable, MODEL_BIT, IPHONE_MAX_CHARS,
  WIRE_HEADER_CHARS, SMS_MAX_CHARS, ZOLEO_MAX_CHARS, maxCharsFor, reassembleReply,
  type RequestContext,
} from "@weather/protocol";
import {
  encodeFillSeq, fitFillToBudget, splitReplyFor, type ForecastParams, type HourlyData,
} from "../src/forecast.js";

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

const TEST_VARS: ReadonlySet<Variable> = new Set([...DEFAULT_VARS, VAR.temp, VAR.wind]);

function params(overrides: Partial<ForecastParams> = {}): ForecastParams {
  return {
    locationIdx: 0,
    lat: 63.135,
    lon: -150.989,
    mode: MODE_AUTO,
    utcOffsetHours: UTC_OFFSET,
    modelsMask: 0b010, // American (US): has freeze + pressure-level vars, so nothing is masked off
    vars: TEST_VARS,
    maxChars: 160,
    messages: 1,
    decoderVersion: WIRE_VERSION,
    code: 7,
    startEpochHour: REQ_UTC_HOUR,
    userToken: null,
    ...overrides,
  };
}

const codec = wireCodec;

function encodeSeq(p: ForecastParams, h = HOURLY, times = TIMES) {
  return (seq: number) =>
    encodeFillSeq(h, times, p, seq, p.lat!, p.lon!, 500, "US", codec);
}

// The context a client would store for this request (see HomeScreen), used to decode replies.
const ctxFor = (mode: number): RequestContext => ({
  model: 1, // American (US)
  vars: TEST_VARS,
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

  // The whole point of the wide alphabet: a reply an iPhone receives over satellite has to land
  // in ONE bubble, because Apple's relay splits anything larger and never reassembles it. The
  // bubble is min(70 UTF-16 code units, ~140 bytes of compressed UTF-8), measured in the field, so
  // this measures the encoded reply against BOTH, in the units each cap is actually expressed in.
  describe("an iPhone reply fits one satellite bubble", () => {
    const iphone = params({ alphabet: "base32768", device: "i", maxChars: IPHONE_MAX_CHARS });
    const reply = fitFillToBudget(
      encodeSeq(iphone), (e) => e.length, maxFillSeq(MODE_AUTO), iphone.maxChars)!;

    it("clears both of the relay's caps", () => {
      expect(reply.length).toBeLessThanOrEqual(70);                        // UTF-16 code units
      expect(Buffer.byteLength(reply, "utf8")).toBeLessThanOrEqual(140);   // UTF-8 bytes
    });

    it("spends the budget it was given", () => {
      expect(reply.length).toBeLessThanOrEqual(IPHONE_MAX_CHARS);
      expect(reply.length).toBeGreaterThan(IPHONE_MAX_CHARS - 4);
    });

    it("decodes to the same forecast the reader asked for", () => {
      const decoded = decodeMessage(reply, () => ctx);
      expect(decoded.periods[0].length).toBe(decoded.periodHours!.length);
      expect(decoded.mode).toBe(MODE_AUTO);
    });

    // The field bug of 2026-08-17: a real single-message fill lands at 44-45 body characters
    // (this suite's synthetic data stops at 43, which is why the fill tests alone never caught
    // it), and the splitter compared against the 43-character PART size — so every such reply
    // went out as a full labelled part plus a one-or-two-character tail. The whole-bubble cap is
    // the right test for staying unsplit.
    describe("goes out whole, not as parts", () => {
      const wide = (bodyChars: number) => "#abcd" + "㐀".repeat(bodyChars);

      it("keeps the single-message fill unlabelled", () => {
        expect(splitReplyFor(iphone, reply, WIRE_HEADER_CHARS)).toEqual([reply]);
      });

      it("keeps the full 45-character single-message body unlabelled", () => {
        const whole = wide(45);
        expect(splitReplyFor(iphone, whole, WIRE_HEADER_CHARS)).toEqual([whole]);
      });

      it("collapses a two-message request whose content ran short to one plain bubble", () => {
        const p = params({
          alphabet: "base32768",
          device: "i",
          messages: 2,
          maxChars: maxCharsFor("i", 2, WIRE_HEADER_CHARS),
        });
        const short = wide(45);
        expect(splitReplyFor(p, short, WIRE_HEADER_CHARS)).toEqual([short]);
      });

      it("still splits what one bubble cannot hold", () => {
        const parts = splitReplyFor(iphone, wide(46), WIRE_HEADER_CHARS);
        expect(parts).toHaveLength(2);
        expect(parts[0].startsWith("1/2 ")).toBe(true);
      });
    });

    // Two messages, each its own bubble. This is the mode the builder defaults to, because one
    // bubble is a real forecast but a thin one.
    describe("spread over two messages", () => {
      const p = params({
        alphabet: "base32768",
        device: "i",
        messages: 2,
        maxChars: maxCharsFor("i", 2, WIRE_HEADER_CHARS),
      });
      const encoded = fitFillToBudget(
        encodeSeq(p), (e) => e.length, maxFillSeq(MODE_AUTO), p.maxChars)!;
      const parts = splitReplyFor(p, encoded, WIRE_HEADER_CHARS);

      it("sends exactly two, each inside a bubble", () => {
        expect(parts).toHaveLength(2);
        for (const part of parts) {
          expect(Buffer.byteLength(part, "utf8")).toBeLessThanOrEqual(140);
          expect(part.length).toBeLessThanOrEqual(70);
        }
      });

      it("labels them and repeats the header", () => {
        expect(parts[0].startsWith("1/2 ")).toBe(true);
        expect(parts[1].startsWith("2/2 ")).toBe(true);
        const header = (s: string) => s.slice(4, 4 + WIRE_HEADER_CHARS);
        expect(header(parts[0])).toBe(header(parts[1]));
      });

      it("decodes to a fuller forecast than one message, in any paste order", () => {
        const whole = reassembleReply(parts.join("\n"), () => WIRE_HEADER_CHARS);
        expect(whole).toBe(encoded);
        const decoded = decodeMessage(whole, () => ctx);
        const reversed = reassembleReply([...parts].reverse().join(" "), () => WIRE_HEADER_CHARS);
        expect(decodeMessage(reversed, () => ctx)).toEqual(decoded);
        expect(decoded.periodHours!.length)
          .toBeGreaterThan(decodeMessage(reply, () => ctx).periodHours!.length);
      });
    });

    it("carries more of the forecast than base-85 would in the same bubble", () => {
      // Same cap in code units — the one an all-ASCII reply would hit first — so this is the
      // like-for-like comparison: 70 characters of base-85 against 70 of the wide encoding.
      const narrow = fitFillToBudget(
        encodeSeq(params({ maxChars: 70 })), (e) => e.length, maxFillSeq(MODE_AUTO), 70)!;
      const periods = (s: string) => decodeMessage(s, () => ctx).periodHours!.length;
      expect(periods(reply)).toBeGreaterThan(periods(narrow));
    });
  });

  // inReach splits the same way, at SMS size: a single reply is one 160-character message, and a
  // reader who asked for two gets two labelled parts, each a whole message with the header
  // repeated, so nothing depends on the device reassembling concatenated segments.
  describe("an inReach reply over several messages", () => {
    const one = params({ alphabet: "base85", device: "g", maxChars: SMS_MAX_CHARS });
    const single = fitFillToBudget(
      encodeSeq(one), (e) => e.length, maxFillSeq(MODE_AUTO), one.maxChars)!;

    it("keeps a single message unlabelled, right up to the full 160", () => {
      expect(single.length).toBeLessThanOrEqual(SMS_MAX_CHARS);
      expect(splitReplyFor(one, single, WIRE_HEADER_CHARS)).toEqual([single]);
      const full = single.slice(0, WIRE_HEADER_CHARS) + "A".repeat(SMS_MAX_CHARS - WIRE_HEADER_CHARS);
      expect(splitReplyFor(one, full, WIRE_HEADER_CHARS)).toEqual([full]);
    });

    it("never splits an SMS reply, whatever the count asked for", () => {
      const sms = params({ alphabet: "base124", device: "s", messages: 2, maxChars: maxCharsFor("s", 2, WIRE_HEADER_CHARS) });
      const long = single.slice(0, WIRE_HEADER_CHARS) + "A".repeat(300);
      expect(splitReplyFor(sms, long, WIRE_HEADER_CHARS)).toEqual([long]);
    });

    describe("spread over two messages", () => {
      const p = params({
        alphabet: "base85",
        device: "g",
        messages: 2,
        maxChars: maxCharsFor("g", 2, WIRE_HEADER_CHARS),
      });
      const encoded = fitFillToBudget(
        encodeSeq(p), (e) => e.length, maxFillSeq(MODE_AUTO), p.maxChars)!;
      const parts = splitReplyFor(p, encoded, WIRE_HEADER_CHARS);

      it("sends exactly two, each one whole SMS at most, labelled and sharing the header", () => {
        expect(encoded.length).toBeGreaterThan(SMS_MAX_CHARS);
        expect(parts).toHaveLength(2);
        for (const part of parts) expect(part.length).toBeLessThanOrEqual(SMS_MAX_CHARS);
        expect(parts[0].startsWith("1/2 ")).toBe(true);
        expect(parts[1].startsWith("2/2 ")).toBe(true);
        const header = (s: string) => s.slice(4, 4 + WIRE_HEADER_CHARS);
        expect(header(parts[0])).toBe(header(parts[1]));
      });

      it("decodes to a fuller forecast than one message, in any paste order", () => {
        const whole = reassembleReply(parts.join("\n"), () => WIRE_HEADER_CHARS);
        expect(whole).toBe(encoded);
        const decoded = decodeMessage(whole, () => ctx);
        const reversed = reassembleReply([...parts].reverse().join(" "), () => WIRE_HEADER_CHARS);
        expect(decodeMessage(reversed, () => ctx)).toEqual(decoded);
        expect(decoded.periodHours!.length)
          .toBeGreaterThan(decodeMessage(single, () => ctx).periodHours!.length);
      });
    });
  });

  // ZOLEO splits the same way at its own size. Its gateway reassembles concatenated segments
  // and then truncates at 240 bytes, so only separate messages can carry more than one.
  describe("a ZOLEO reply over several messages", () => {
    const p = params({
      alphabet: "base85",
      device: "z",
      messages: 2,
      maxChars: maxCharsFor("z", 2, WIRE_HEADER_CHARS),
    });
    const encoded = fitFillToBudget(
      encodeSeq(p), (e) => e.length, maxFillSeq(MODE_AUTO), p.maxChars)!;
    const parts = splitReplyFor(p, encoded, WIRE_HEADER_CHARS);

    it("sends exactly two, each inside the 240-byte cap on its own", () => {
      expect(encoded.length).toBeGreaterThan(ZOLEO_MAX_CHARS);
      expect(parts).toHaveLength(2);
      for (const part of parts) expect(Buffer.byteLength(part, "utf8")).toBeLessThanOrEqual(ZOLEO_MAX_CHARS);
      expect(parts[0].startsWith("1/2 ")).toBe(true);
    });

    it("reassembles and decodes", () => {
      const whole = reassembleReply(parts.join("\n"), () => WIRE_HEADER_CHARS);
      expect(whole).toBe(encoded);
      expect(decodeMessage(whole, () => ctx).seq).toBe(decodeMessage(encoded, () => ctx).seq);
    });
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

  // Why effectiveMode exists, end to end. GEM's data stops ~9 days out; Range's path covers the
  // whole window at 12h before refining anything, so its servable layouts were all 12h and the
  // search stopped with the budget mostly unspent.
  describe("a Canadian request that asked for Range", () => {
    // Nulls where GDPS's data stops: 240h from a run that can be 12h old and landed 7h after
    // init — the worst case a request is guaranteed.
    const lastHourWithData = REQ_UTC_HOUR + (240 - 12 - 7);
    const gemLike: HourlyData = {
      ...HOURLY,
      temperature_2m: HOURLY.temperature_2m.map(
        (v, i) => (DATA_START + i <= lastHourWithData ? v : null)),
    };
    // No freezing level: GEM has no such product, so toFullPeriod drops it anyway.
    const caVars = new Set([...TEST_VARS].filter((v) => v !== VAR.freeze));
    const caEncode = (mode: number) => {
      const p = params({ mode, modelsMask: 1 << MODEL_BIT.CA, vars: caVars });
      return (seq: number) =>
        encodeFillSeq(gemLike, TIMES, p, seq, p.lat!, p.lon!, 500, "CA", codec);
    };
    const caCtx = (mode: number): RequestContext => ({
      ...ctxFor(mode), model: MODEL_BIT.CA, vars: caVars,
    });

    it("would strand a third of the budget as Range", () => {
      // Measured on the encoded layouts rather than a decoded reply: with the substitution in
      // place a CA message encoded under Range is unreachable — parseRequest resolves the mode
      // before the encoder sees it, and the decoder resolves it the same way, so decoding one
      // would (correctly) desync. This is the state the substitution removes.
      const enc = caEncode(MODE_RANGE);
      let best = 1;
      for (let seq = 1; seq <= maxFillSeq(MODE_RANGE); seq++) {
        const encoded = enc(seq);
        if (encoded !== null && encoded.length <= 160) best = seq;
      }
      expect(fillProfile(MODE_RANGE, best).every((r) => r === 1)).toBe(true);
      expect(enc(best)!.length).toBeLessThan(120); // nowhere near the 160 it was allowed
    });

    it("refines and spends the budget once resolved to Auto", () => {
      const mode = effectiveMode(MODE_RANGE, MODEL_BIT.CA);
      expect(mode).toBe(MODE_AUTO);
      const encoded = fitFillToBudget(caEncode(mode), (e) => e.length, maxFillSeq(mode), 160)!;
      const decoded = decodeMessage(encoded, () => caCtx(MODE_RANGE)); // client stored Range
      expect(encoded.length).toBeLessThanOrEqual(160);
      expect(encoded.length).toBeGreaterThan(140);
      expect(decoded.periodHours!.some((ph) => ph < 12)).toBe(true);
      expect(decoded.mode).toBe(MODE_RANGE); // labelled as requested, laid out as Auto
    });
  });
});
