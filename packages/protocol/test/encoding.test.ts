import { describe, it, expect } from "vitest";
import {
  messageToString,
  messageFromString,
  encodeBreakdown,
  WIRE_VERSION,
  encodeVersion,
  decodeMessage,
  type ForecastMessage,
  type Period,
  type WindAloft,
  WIND_LEVELS_HPA,
  WIND_LEVEL_VARS,
  cloudBandLevelRange,
  type RequestContext,
  CARDINALS,
  DEFAULT_VARS,
  VAR,
  VARIABLES,
  type Variable,
  AQI_US_RESIDUAL_MASKS,
  AQI_EU_RESIDUAL_MASKS,
  MODE_DETAIL,
  MODE_RANGE,
  compandSqrt,
  expandSqrt,
  ACCUM_BITS,
  SNOW_K,
  RAIN_K,
  beaufortMidKph,
  quantAqi,
  aqiMid,
  AQI_US_LOWER,
  AQI_EU_LOWER,
  ALPHABET,
  WIRE_HEADER_CHARS,
} from "../src/index.js";

// Wind speeds quantize to extended Beaufort forces; tests express speeds as forces and expect
// the decoded band midpoint. A midpoint input round-trips exactly.
const bmid = beaufortMidKph;

// Reproduce what the codec stores for a sqrt-companded accumulation, so round-trip
// expectations track the quantization exactly rather than the raw input.
const qSnow = (cm: number) => expandSqrt(compandSqrt(cm, SNOW_K, ACCUM_BITS), SNOW_K);
const qRain = (mm: number) => expandSqrt(compandSqrt(mm, RAIN_K, ACCUM_BITS), RAIN_K);

// Every variable, weather and both air-quality indices in full.
const ALL_VARS: ReadonlySet<Variable> = new Set(VARIABLES);
// Shorthand for a request's selection.
const varSet = (...vs: Variable[]): Set<Variable> => new Set(vs);
// WIND_LEVELS_HPA ladder indices used below, and helpers to build wind_aloft stacks.
const L500 = WIND_LEVELS_HPA.indexOf(500), L600 = WIND_LEVELS_HPA.indexOf(600);
const L700 = WIND_LEVELS_HPA.indexOf(700), L925 = WIND_LEVELS_HPA.indexOf(925);
const withAloft = (li: number, w: WindAloft): (WindAloft | null)[] =>
  PERIOD.wind_aloft!.map((v, i) => (i === li ? w : v));
const aloftOnly = (li: number, w: WindAloft): (WindAloft | null)[] =>
  WIND_LEVELS_HPA.map((_, i) => (i === li ? w : null));
// Every air-quality column: its variable, its Period field, and which ladder it decodes on.
const AQ_CASES: [variable: Variable, field: keyof Period, scale: "us" | "eu"][] = [
  [VAR.aq_pm25, "aqi_pm25", "us"],
  [VAR.aq_o3, "aqi_o3", "us"],
  [VAR.aq_pm10, "aqi_pm10", "us"],
  [VAR.aq_no2, "aqi_no2", "us"],
  [VAR.aq_so2, "aqi_so2", "us"],
  [VAR.aqi, "aqi", "us"],
  [VAR.aqi_eu_pm25, "aqi_eu_pm25", "eu"],
  [VAR.aqi_eu_o3, "aqi_eu_o3", "eu"],
  [VAR.aqi_eu_pm10, "aqi_eu_pm10", "eu"],
  [VAR.aqi_eu_no2, "aqi_eu_no2", "eu"],
  [VAR.aqi_eu_so2, "aqi_eu_so2", "eu"],
  [VAR.aqi_eu, "aqi_eu", "eu"],
];
const AQ_VARS: ReadonlySet<Variable> = new Set(AQ_CASES.map(([v]) => v));

const PERIOD: Period = {
  weathercode: 73,
  precip: 75,
  temp_c: 0,
  snow_cm: 4 * 2.54,       // ~10cm — sqrt-companded, compared via qSnow()
  rain_mm: 6.5,            // sqrt-companded, compared via qRain()
  freeze_m: 6 * 304.8,     // 6000 ft in m — round-trips exactly
  wind_sfc_kph: 16,        // force 3 midpoint — all wind speeds round-trip as band midpoints
  wind_sfc_dir: 2,
  wind_gust_kph: 34,       // force 5
  // One entry per WIND_LEVELS_HPA level (300 hPa first), forces 9 down to 2.
  wind_aloft: [9, 8, 6, 5, 4, 3, 2].map((force, li) => ({ kph: beaufortMidKph(force), dir: [5, 5, 4, 3, 2, 2, 1][li] })),
  cloud_band: [70, 65, 60, 55, 40, 35, 30, 20, 15, 10],
  // Air quality. Each headline sits at or above every one of its own scale's sub-index bands,
  // which is what the wire assumes when it codes the headline as a residual against their max.
  aqi: 118,
  aqi_pm25: 96,
  aqi_o3: 42,
  aqi_pm10: 60,
  aqi_no2: 18,
  aqi_so2: 9,
  aqi_eu: 55,
  aqi_eu_pm25: 31,
  aqi_eu_o3: 48,
  aqi_eu_pm10: 22,
  aqi_eu_no2: 14,
  aqi_eu_so2: 6,
  // PM2.5 (96) leads the US constituents; ozone (48) leads the European ones — indices into
  // AQ_DOMINANT_US / AQ_DOMINANT_EU.
  aqi_dominant: 0,
  aqi_eu_dominant: 1,
};

// Air-quality values decode to their ladder band's representative, so expectations go through
// the same quantization rather than the raw input (as with qSnow/qRain above).
const qUs = (v: number) => aqiMid(quantAqi(v, AQI_US_LOWER), AQI_US_LOWER);
const qEu = (v: number) => aqiMid(quantAqi(v, AQI_EU_LOWER), AQI_EU_LOWER);

function popcount(n: number): number {
  let c = 0;
  while (n) { c += n & 1; n >>>= 1; }
  return c;
}

// The decoder derives the period layout from (context, seq) — see layout.ts — so a test
// message must sit on a mode's fill path. Two uniform shapes cover every column test, both
// anchored so the request time equals the FIRST period's start (which lets ctxOf rebuild the
// request from the message's own month/day/hour):
//   12-hour: n ≤ 26, on Range's pure-12h ramp: s = ceil(n/2) slots at seq = s, requested at
//            hour 24s − 12n ∈ {0, 12}, so the request slot's tail plus the whole days is
//            exactly n periods.
//   hourly:  49 ≤ n ≤ 72 only — the sole all-1h layout on any path is Detail seq 12 (1h×3):
//            n periods requested at hour 72 − n.
// The context's UTC offset is 0 throughout, so local time == UTC.
function uniformLayout(n: number, hourly: boolean): { mode: number; days: number; seq: number; hourOfDay: number; stepHours: number } {
  if (hourly) {
    if (n < 49 || n > 72)
      throw new Error(`no canonical all-1h layout has ${n} periods (Detail 1h×3 spans 49..72)`);
    return { mode: MODE_DETAIL, days: 3, seq: 12, hourOfDay: 72 - n, stepHours: 1 };
  }
  const s = Math.ceil(n / 2);
  if (s > 13) throw new Error(`no pure-12h layout has ${n} periods (the ramp tops at 13 slots)`);
  return { mode: MODE_RANGE, days: s, seq: s, hourOfDay: 24 * s - 12 * n, stepHours: 12 };
}

function msg(overrides: Partial<ForecastMessage> = {}, opts: { hourly?: boolean } = {}): ForecastMessage {
  const models_mask = overrides.models_mask ?? 0b001;
  const nModels = popcount(models_mask);
  const periods = overrides.periods ?? Array.from({ length: nModels }, () => Array(3).fill(PERIOD));
  const n = periods[0].length;
  // Overrides that pin their own seq bring the whole layout with them (mode/days/hour/
  // periodHours) — don't derive one from the period count.
  const { mode, days, seq, hourOfDay, stepHours } = overrides.seq != null
    ? { mode: MODE_RANGE, days: 1, seq: overrides.seq, hourOfDay: 0, stepHours: 12 }
    : uniformLayout(n, opts.hourly ?? false);
  return {
    version: WIRE_VERSION,
    code: 0,
    days,
    models_mask,
    vars: ALL_VARS,
    month: 5,
    day: 20,
    hour: hourOfDay,
    lat: 63.135,
    lon: -150.989,
    elevation: 500,
    seq,
    mode,
    periodHours: Array(n).fill(stepHours),
    utcOffsetHours: 0,
    ...overrides,
    periods,
  };
}

// The slim response omits lat/lon/model/vars/duration and the request datetime; the decoder
// recovers them by code. The model is the lowest set bit of models_mask; the request time is
// built (UTC) from m/d/h — valid because msg() anchors the request at the first period's start.
const ctxOf = (m: ForecastMessage): RequestContext => ({
  model: 31 - Math.clz32(m.models_mask & -m.models_mask),
  vars: m.vars,
  lat: m.lat,
  lon: m.lon,
  start: Date.UTC(new Date().getUTCFullYear(), m.month - 1, m.day, m.hour),
  mode: m.mode,
  utcOffsetHours: 0,
});
const noCtx = (): RequestContext | undefined => undefined;

function roundTrip(m: ForecastMessage): ForecastMessage {
  return messageFromString(messageToString(m), () => ctxOf(m));
}

describe("round-trip encoding", () => {
  it("preserves header fields", () => {
    // Three 12h periods → two slots of Range's ramp at seq 2; single model
    const original = msg({ models_mask: 0b001, month: 1, day: 31 });
    const decoded = roundTrip(original);
    expect(decoded.version).toBe(WIRE_VERSION);
    expect(decoded.days).toBe(2);
    expect(decoded.seq).toBe(2);
    expect(decoded.mode).toBe(MODE_RANGE);
    expect(decoded.periodHours).toEqual([12, 12, 12]);
    expect(decoded.models_mask).toBe(0b001);
    expect(decoded.vars).toEqual(ALL_VARS);
    expect(decoded.month).toBe(1);
    expect(decoded.day).toBe(31);
    expect(decoded.hour).toBe(12);
  });

  it("preserves lat/lon within 1km", () => {
    const decoded = roundTrip(msg({ lat: 63.135, lon: -150.989 }));
    expect(decoded.lat).toBeCloseTo(63.135, 2);
    expect(decoded.lon).toBeCloseTo(-150.989, 2);
    // negative lat/lon
    const s = roundTrip(msg({ lat: -33.868, lon: 151.209 }));
    expect(s.lat).toBeCloseTo(-33.868, 2);
    expect(s.lon).toBeCloseTo(151.209, 2);
  });

  it("preserves elevation", () => {
    const decoded = roundTrip(msg({ elevation: 2200 }));
    expect(decoded.elevation).toBe(2200);
    // clamps negative to 0
    const clamped = roundTrip(msg({ elevation: -50 }));
    expect(clamped.elevation).toBe(0);
  });

  it("preserves all period fields", () => {
    const decoded = roundTrip(msg());
    const p = decoded.periods[0][0];
    expect(p.weathercode).toBe(PERIOD.weathercode);
    expect(p.precip).toBe(Math.round(Math.round((PERIOD.precip ?? 0) * 7 / 100) * 100 / 7));
    expect(p.temp_c).toBe(PERIOD.temp_c);
    expect(p.snow_cm).toBeCloseTo(qSnow(PERIOD.snow_cm!), 5);
    expect(p.rain_mm).toBeCloseTo(qRain(PERIOD.rain_mm!), 5);
    expect(p.freeze_m).toBeCloseTo(PERIOD.freeze_m!, 5);
    expect(p.wind_sfc_kph).toBeCloseTo(PERIOD.wind_sfc_kph!, 3);
    expect(p.wind_sfc_dir).toBe(PERIOD.wind_sfc_dir);
    expect(p.wind_gust_kph).toBeCloseTo(PERIOD.wind_gust_kph!, 3);
    // At 500 m every level sits above the point, so all seven come back.
    expect(p.wind_aloft).toHaveLength(WIND_LEVELS_HPA.length);
    p.wind_aloft!.forEach((w, li) => {
      expect(w!.kph).toBeCloseTo(PERIOD.wind_aloft![li]!.kph, 3);
      expect(w!.dir).toBe(PERIOD.wind_aloft![li]!.dir);
    });
    // The default layout here is 12h periods, which the band's resolution clamp strips —
    // "not forecast", never "clear". The fine-layout round-trip lives in its own test below.
    expect(p.cloud_band).toBeUndefined();
  });

  it("keys the band's level run off the header elevation", () => {
    // The run derives from the header on both sides, so it costs no wire bits: capped at
    // 300 hPa, two levels below the ground, a 6-level minimum met by extending the top toward
    // 200 — with the two-below rule winning where even the full top can't reach 6.
    expect(cloudBandLevelRange(0)).toEqual({ start: 2, count: 8 });     // low country: [300..1000]
    expect(cloudBandLevelRange(4267)).toEqual({ start: 1, count: 6 });  // 14k camp: [250..700]
    expect(cloudBandLevelRange(6200)).toEqual({ start: 0, count: 6 });  // Denali summit: [200..600]
    expect(cloudBandLevelRange(8850)).toEqual({ start: 0, count: 5 });  // Everest: [200..500]
    expect(cloudBandLevelRange(12700)).toEqual({ start: 0, count: 2 }); // bogus header maximum
  });

  it("round-trips the cloud band only on fine-resolution periods", () => {
    const hourly = roundTrip(msg({ periods: [Array(49).fill(PERIOD)] }, { hourly: true }));
    // quantized to 3 bits per level (0–7 steps), decoded back to nearest %. The wire's
    // cloud_band is the elevation-keyed run: at 500 m that is the capped 8-level [300..1000],
    // read positionally off the input's leading entries.
    expect(hourly.periods[0][0].cloud_band).toEqual(
      PERIOD.cloud_band!.slice(0, 8).map((v) => Math.round(Math.round(v * 7 / 100) * 100 / 7)));
  });

  it("carries the elevation-keyed run of levels at altitude", () => {
    // 4267 m quantizes to 4300 m — ground ≈ 593 hPa, so 600 and 700 are the two carried below
    // the point, and the 6-level minimum pulls the top past the 300 cap to 250: the run is
    // [250..700], six entries read positionally off the input.
    const p = roundTrip(msg({ elevation: 4267, periods: [Array(49).fill(PERIOD)] }, { hourly: true }))
      .periods[0][0];
    expect(p.cloud_band).toEqual(
      PERIOD.cloud_band!.slice(0, 6).map((v) => Math.round(Math.round(v * 7 / 100) * 100 / 7)));
  });

  it("spends fewer body bits at altitude (dropped band levels are not encoded)", () => {
    // A slim period, so the codebook-class selector answers to the band alone — with the full
    // PERIOD the weathercode column can swing the class choice between the two encodings and
    // the per-column costs stop being comparable.
    const slim = { weathercode: PERIOD.weathercode, cloud_band: PERIOD.cloud_band };
    const bits = (elevation: number) => encodeBreakdown(msg(
      { vars: varSet(VAR.clouds), elevation, periods: [Array(49).fill(slim)] },
      { hourly: true })).bodyBits;
    // 4267 m carries six levels to sea level's eight: two anchors and their whole delta chains
    // go with them.
    expect(bits(4267)).toBeLessThan(bits(0) * 0.95);
  });

  it("round-trips every air-quality column on its own scale", () => {
    const p = roundTrip(msg({ vars: AQ_VARS })).periods[0][0];
    // The European values go through the EU ladder — a scale with different band edges, so a
    // value quantized against the US ladder here would come back a different number.
    for (const [, field, scale] of AQ_CASES)
      expect(p[field], field).toBe((scale === "eu" ? qEu : qUs)(PERIOD[field] as number));
  });

  it("round-trips each air-quality variable selected alone", () => {
    const cases: [Variable, keyof Period, (v: number) => number | undefined][] =
      AQ_CASES.map(([variable, field, scale]) => [variable, field, scale === "eu" ? qEu : qUs]);
    for (const [variable, field, q] of cases) {
      const p = roundTrip(msg({ vars: varSet(variable) })).periods[0][0];
      expect(p[field], `${field} alone`).toBe(q(PERIOD[field] as number));
      // Nothing else in the air-quality block rides along on one bit.
      for (const [, other] of cases) if (other !== field) expect(p[other]).toBeUndefined();
    }
  });

  it("codes a headline as a residual only under the masks where that is cheaper", () => {
    // A headline exactly equals its worst sub-index here — the case the residual coding is for.
    // (PERIOD itself sits one band above, so the round-trip tests cover a nonzero residual.)
    const led: Period = { ...PERIOD, aqi: PERIOD.aqi_pm25, aqi_eu: PERIOD.aqi_eu_o3 };
    const colBits = (name: string, vars: ReadonlySet<Variable>) =>
      encodeBreakdown(msg({ vars, periods: [[led, led, led]] }))
        .columns.find((c) => c.name === name)!.bits;

    // Only PM2.5, ozone and PM10 key the residual; the other constituents are never context, so
    // adding them can't move the headline's cost. Each scale's mode set is measured, not assumed
    // — see AQI_US_RESIDUAL_MASKS in entropy.ts for the held-out ladder behind these.
    for (const [head, base, residualMasks] of [
      [VAR.aqi, [VAR.aq_pm25, VAR.aq_o3, VAR.aq_pm10], AQI_US_RESIDUAL_MASKS],
      [VAR.aqi_eu, [VAR.aqi_eu_pm25, VAR.aqi_eu_o3, VAR.aqi_eu_pm10], AQI_EU_RESIDUAL_MASKS],
    ] as const) {
      const alone = colBits(head, varSet(head));
      for (let mask = 1; mask < 8; mask++) {
        const vars = varSet(head, ...base.filter((_, i) => mask & (1 << i)));
        const bits = colBits(head, vars);
        if (residualMasks.has(mask)) {
          // The headline is the max of the carried constituents plus a residual of zero — far
          // cheaper than carrying its own anchor and deltas.
          expect(bits, `${head} mask ${mask} should be a residual`).toBeLessThan(alone);
        } else {
          // Too little of the leadership mass to take a max against, so the column falls back to
          // its own deltas and costs exactly what it does alone.
          expect(bits, `${head} mask ${mask} should fall back`).toBeCloseTo(alone, 6);
        }
      }
    }
  });

  it("names the dominant pollutant for every period a headline reports", () => {
    // The identity rides the headline's own bit — asking for AQI alone is enough to get it.
    for (const [variable, field, expected] of [
      [VAR.aqi, "aqi_dominant", PERIOD.aqi_dominant],
      [VAR.aqi_eu, "aqi_eu_dominant", PERIOD.aqi_eu_dominant],
    ] as const) {
      const decoded = roundTrip(msg({ vars: varSet(variable) }));
      for (let p = 0; p < decoded.periods[0].length; p++)
        expect(decoded.periods[0][p][field], `${field} period ${p}`).toBe(expected);
    }
  });

  it("carries the dominant pollutant independently of the headline's coding mode", () => {
    // Whether the headline codes as a residual or as its own deltas is a function of the
    // selection; the pollutant it names must not change with it.
    const withAll = varSet(VAR.aqi, VAR.aq_pm25, VAR.aq_o3, VAR.aq_pm10);
    for (const vars of [varSet(VAR.aqi), withAll]) {
      const d = roundTrip(msg({ vars })).periods[0][0];
      expect(d.aqi_dominant, `vars ${[...vars].join(",")}`).toBe(PERIOD.aqi_dominant);
    }
  });

  it("names no pollutant for a period whose headline has no reading", () => {
    // A no-data headline has nothing to attribute, so no symbol is emitted — and the decoder
    // knows which periods those are because it reads the headline first.
    const gap: Period = { ...PERIOD, aqi: undefined };
    const periods = [[PERIOD, gap, PERIOD]];
    const decoded = roundTrip(msg({ vars: varSet(VAR.aqi), periods }));
    expect(decoded.periods[0][0].aqi_dominant).toBe(PERIOD.aqi_dominant);
    expect(decoded.periods[0][1].aqi).toBeUndefined();
    expect(decoded.periods[0][1].aqi_dominant).toBeUndefined();
    expect(decoded.periods[0][2].aqi_dominant).toBe(PERIOD.aqi_dominant);
  });

  it("ignores the constituents that never lead an index as headline context", () => {
    // NO2 and SO2 measured bit-for-bit identical in the US baseline whether present or not, so
    // they are deliberately not part of the residual key.
    const led: Period = { ...PERIOD, aqi: PERIOD.aqi_pm25 };
    const aqiBits = (vars: ReadonlySet<Variable>) =>
      encodeBreakdown(msg({ vars, periods: [[led, led, led]] }))
        .columns.find((c) => c.name === "aqi")!.bits;
    const keyed = varSet(VAR.aqi, VAR.aq_pm25, VAR.aq_o3);
    const plusUnkeyed = varSet(...keyed, VAR.aq_no2, VAR.aq_so2);
    expect(aqiBits(plusUnkeyed)).toBeCloseTo(aqiBits(keyed), 6);
  });

  it("decodes a missing headline as the worst sub-index rather than as clean air", () => {
    // Upstream can return a headline of nothing for an hour where a sub-index has a value. The
    // residual is non-negative by construction, so that clamps to "equal to the worst sub-index"
    // — the best estimate available, and never a fabricated 0.
    const gap: Period = { ...PERIOD, aqi: undefined };
    const vars = varSet(VAR.aqi, VAR.aq_pm25, VAR.aq_o3);
    const p = roundTrip(msg({ vars, periods: [[gap, gap, gap]] })).periods[0][0];
    expect(p.aqi).toBe(qUs(PERIOD.aqi_pm25!)); // pm25 (96) outranks o3 (42)
  });

  it("leaves a column's missing values absent rather than reading them as zero", () => {
    // A column with no residual context carries the ladder's no-data symbol, which decodes to an
    // absent field — "not forecast", not "the cleanest air there is".
    const gap: Period = { ...PERIOD, aqi_eu: undefined };
    const periods = [[PERIOD, gap, PERIOD]];
    const decoded = roundTrip(msg({ vars: varSet(VAR.aqi_eu), periods }));
    expect(decoded.periods[0][0].aqi_eu).toBe(qEu(PERIOD.aqi_eu!));
    expect(decoded.periods[0][1].aqi_eu).toBeUndefined();
    expect(decoded.periods[0][2].aqi_eu).toBe(qEu(PERIOD.aqi_eu!));
  });

  it("stops the air-quality columns at the 4-day CAMS horizon", () => {
    // 26 twelve-hour periods = 13 days. CAMS reaches ~4.5 days, so the columns cover the first
    // 96 hours — eight periods — and the rest carry no air-quality symbols at all.
    const periods = [Array(26).fill(PERIOD)];
    // Temp rides along so the last period can show the clamp is per-column, not per-message.
    const decoded = roundTrip(msg({ vars: varSet(...AQ_VARS, VAR.temp), periods }));
    const row = decoded.periods[0];
    expect(row).toHaveLength(26);
    for (let p = 0; p < 8; p++) expect(row[p].aqi_pm25, `period ${p}`).toBe(qUs(PERIOD.aqi_pm25!));
    for (let p = 8; p < 26; p++) {
      expect(row[p].aqi, `period ${p}`).toBeUndefined();
      expect(row[p].aqi_pm25, `period ${p}`).toBeUndefined();
      expect(row[p].aqi_eu, `period ${p}`).toBeUndefined();
    }
    // The weather columns are unaffected — the clamp is per-column, not per-message.
    expect(row[25].temp_c).toBe(PERIOD.temp_c);
  });

  it("charges nothing for the periods past the air-quality horizon", () => {
    // The clamp is derived from the layout on both sides, so it costs no header bits and emits
    // no symbols: a 13-day message pays for the same eight periods a 4-day one does.
    const short = encodeBreakdown(msg({ vars: AQ_VARS, periods: [Array(8).fill(PERIOD)] }));
    const long = encodeBreakdown(msg({ vars: AQ_VARS, periods: [Array(26).fill(PERIOD)] }));
    const aqBits = (b: typeof short) =>
      b.columns.filter((c) => c.name.startsWith("aq")).reduce((s, c) => s + c.bits, 0);
    expect(aqBits(long)).toBeCloseTo(aqBits(short), 6);
  });

  it("omits all optional fields when no vars are selected", () => {
    const decoded = roundTrip(msg({ vars: varSet() }));
    const p = decoded.periods[0][0];
    expect(p.aqi).toBeUndefined();
    expect(p.aqi_eu).toBeUndefined();
    expect(p.precip).toBeUndefined();
    expect(p.temp_c).toBeUndefined();
    expect(p.snow_cm).toBeUndefined();
    expect(p.rain_mm).toBeUndefined();
    expect(p.freeze_m).toBeUndefined();
    expect(p.wind_sfc_kph).toBeUndefined();
    expect(p.wind_gust_kph).toBeUndefined();
    expect(p.wind_aloft).toBeUndefined();
    expect(p.cloud_band).toBeUndefined();
  });

  it("only includes selected vars", () => {
    const decoded = roundTrip(msg({ vars: varSet(VAR.precip, VAR.freeze) }));
    const p = decoded.periods[0][0];
    expect(p.precip).toBe(Math.round(Math.round(75 * 7 / 100) * 100 / 7));
    expect(p.freeze_m).toBeCloseTo(6 * 304.8, 5);
    expect(p.temp_c).toBeUndefined();
    expect(p.snow_cm).toBeUndefined();
    expect(p.wind_aloft).toBeUndefined();
  });

  it("temp round-trips selected alone", () => {
    const tempOnly = roundTrip(msg({ vars: varSet(VAR.temp) }));
    expect(tempOnly.periods[0][0].temp_c).toBe(PERIOD.temp_c);
    expect(tempOnly.periods[0][0].precip).toBeUndefined();
  });

  it("default vars include expected vars", () => {
    const defaults = new Set(DEFAULT_VARS);
    expect(defaults.has(VAR.precip)).toBe(true);
    expect(defaults.has(VAR.snow)).toBe(true);
    expect(defaults.has(VAR.freeze)).toBe(true);
    // Pressure-level wind is opt-in, level by level (`w:` token) — none on by default.
    expect(WIND_LEVEL_VARS.some((v) => defaults.has(v))).toBe(false);
    expect(defaults.has(VAR.temp)).toBe(false);
    expect(defaults.has(VAR.wind)).toBe(false);
  });

  it("handles all 8 wind directions", () => {
    for (let dir = 0; dir < 8; dir++) {
      const period = { ...PERIOD, wind_aloft: withAloft(L700, { kph: 24.5, dir }) };
      const decoded = roundTrip(msg({ periods: [[period]] }));
      expect(decoded.periods[0][0].wind_aloft![L700]!.dir).toBe(dir);
      expect(CARDINALS[decoded.periods[0][0].wind_aloft![L700]!.dir]).toBe(CARDINALS[dir]);
    }
  });

  it("handles every uniform resolution the paths reach", () => {
    // Requested at midnight so slot 0 is a whole day. Range's breadth-first path passes
    // through the full horizon at 12h/6h/3h (seq 13/26/39 over 13 slots); Detail seq 12 is
    // the all-1h waypoint (1h×3).
    const uniform: { mode: number; seq: number; days: number; stepHours: number }[] = [
      { mode: MODE_RANGE, seq: 13, days: 13, stepHours: 12 },
      { mode: MODE_RANGE, seq: 26, days: 13, stepHours: 6 },
      { mode: MODE_RANGE, seq: 39, days: 13, stepHours: 3 },
      { mode: MODE_DETAIL, seq: 12, days: 3, stepHours: 1 },
    ];
    for (const { mode, seq, days, stepHours } of uniform) {
      const n = days * (24 / stepHours);
      const decoded = roundTrip(msg({
        mode, seq, days, hour: 0,
        periodHours: Array(n).fill(stepHours),
        periods: [Array(n).fill(PERIOD)],
      }));
      expect(decoded.seq).toBe(seq);
      expect(decoded.days).toBe(days);
      expect(decoded.periodHours).toEqual(Array(n).fill(stepHours));
      expect(decoded.periods[0]).toHaveLength(n);
    }
  });

  it("round-trips a partial FIRST day (hourly layout anchored mid-day)", () => {
    // 58 hourly periods → Detail's 1h×3 waypoint requested at 14:00: 14:00–24:00 today, then
    // two whole days.
    const decoded = roundTrip(msg({ periods: [Array(58).fill(PERIOD)] }, { hourly: true }));
    expect(decoded.periods[0]).toHaveLength(58);
    expect(decoded.mode).toBe(MODE_DETAIL);
    expect(decoded.days).toBe(3);
    expect(decoded.hour).toBe(14);
    expect(decoded.periodHours).toEqual(Array(58).fill(1));
  });

  it("round-trips each of the four model indices (single model per response)", () => {
    for (let idx = 0; idx < 4; idx++) {
      const decoded = roundTrip(msg({ models_mask: 1 << idx, periods: [Array(5).fill(PERIOD)] }));
      expect(decoded.models_mask).toBe(1 << idx);
      expect(decoded.periods).toHaveLength(1);
      expect(decoded.periods[0]).toHaveLength(5);
      expect(decoded.days).toBe(3);
    }
  });

  it("quantizes wind speed to Beaufort band midpoints", () => {
    const decoded = roundTrip(msg({ periods: [[{ ...PERIOD, wind_aloft: withAloft(L700, { kph: 43.4, dir: 2 }) }]] }));
    expect(decoded.periods[0][0].wind_aloft![L700]!.kph).toBeCloseTo(bmid(6), 3); // 39-49 kph band
  });

  it("clamps snow to 200 cm max", () => {
    const decoded = roundTrip(msg({ periods: [[{ ...PERIOD, snow_cm: 300 }]] }));
    expect(decoded.periods[0][0].snow_cm).toBeCloseTo(200, 3);
  });

  it("keeps fine resolution for light snow (sqrt companding)", () => {
    // a 1 cm dusting round-trips to well within half a cm
    const decoded = roundTrip(msg({ periods: [[{ ...PERIOD, snow_cm: 1 }]] }));
    expect(decoded.periods[0][0].snow_cm).toBeCloseTo(1, 0);
  });

  it("clamps rain to 144 mm max", () => {
    const decoded = roundTrip(msg({ periods: [[{ ...PERIOD, rain_mm: 200 }]] }));
    expect(decoded.periods[0][0].rain_mm).toBeCloseTo(144, 3);
  });

  it("keeps fine resolution for light rain (sqrt companding)", () => {
    // light drizzle near 1 mm round-trips to well within half a mm
    const decoded = roundTrip(msg({ periods: [[{ ...PERIOD, rain_mm: 1 }]] }));
    expect(decoded.periods[0][0].rain_mm).toBeCloseTo(1, 0);
  });

  it("clamps freeze level to 31,000 ft max (9448.8 m)", () => {
    const decoded = roundTrip(msg({ periods: [[{ ...PERIOD, freeze_m: 40000 * 0.3048 }]] }));
    expect(decoded.periods[0][0].freeze_m).toBeCloseTo(31 * 304.8, 5);
  });

  it("carries a tropical freeze level above 15,000 ft without clipping", () => {
    // The corpus tops out near 21,000 ft (the Andes in summer); nothing there may saturate.
    const decoded = roundTrip(msg({ periods: [[{ ...PERIOD, freeze_m: 21 * 304.8 }]] }));
    expect(decoded.periods[0][0].freeze_m).toBeCloseTo(21 * 304.8, 5);
  });

  it("encodes a near-constant freeze-level column smaller than a wide-swinging one (Huffman-coded deltas)", () => {
    const vars = varSet(VAR.freeze);
    const flat = Array.from({ length: 64 }, () => ({ ...PERIOD, freeze_m: 6 * 304.8 }));
    const swings = Array.from({ length: 64 }, (_, i) => ({ ...PERIOD, freeze_m: (i % 2 === 0 ? 2 : 13) * 304.8 }));
    const flatLen = messageToString(msg({ vars, periods: [flat] }, { hourly: true })).length;
    const swingsLen = messageToString(msg({ vars, periods: [swings] }, { hourly: true })).length;
    expect(flatLen).toBeLessThan(swingsLen);
  });

  it("encodes a near-constant cloud band smaller than a wide-swinging one (Huffman-coded deltas)", () => {
    const vars = varSet(VAR.clouds);
    const flat = Array.from({ length: 64 }, () => ({ ...PERIOD, cloud_band: Array.from({ length: 10 }, () => 40) }));
    const swings = Array.from({ length: 64 }, (_, i) => ({
      ...PERIOD, cloud_band: Array.from({ length: 10 }, () => (i % 2 === 0 ? 0 : 100)),
    }));
    const flatLen = messageToString(msg({ vars, periods: [flat] }, { hourly: true })).length;
    const swingsLen = messageToString(msg({ vars, periods: [swings] }, { hourly: true })).length;
    expect(flatLen).toBeLessThan(swingsLen);
  });

  it("rounds precip to nearest 3-bit step", () => {
    const decoded = roundTrip(msg({ periods: [[{ ...PERIOD, precip: 73 }]] }));
    expect(decoded.periods[0][0].precip).toBe(Math.round(Math.round(73 * 7 / 100) * 100 / 7));
  });

  it("preserves negative temp", () => {
    const decoded = roundTrip(msg({ periods: [[{ ...PERIOD, temp_c: -35 }]] }));
    expect(decoded.periods[0][0].temp_c).toBe(-35);
  });

  it("throws when decoding a different version's tag", () => {
    // Swap the self-describing version prefix to the next version; the codec must reject it.
    const encoded = messageToString(msg());
    const reTagged = encodeVersion(WIRE_VERSION + 1) + encoded.slice(1);
    expect(() => messageFromString(reTagged, noCtx))
      .toThrow(new RegExp(`Version mismatch.*v${WIRE_VERSION + 1}`));
  });

  it("dispatches an unknown version to a clear error", () => {
    const encoded = messageToString(msg());
    const reTagged = encodeVersion(WIRE_VERSION + 3) + encoded.slice(1);
    expect(() => decodeMessage(reTagged, noCtx))
      .toThrow(new RegExp(`Unsupported protocol version: v${WIRE_VERSION + 3}`));
  });

  it("throws on short message", () => {
    // A valid version tag but no room for the header.
    expect(() => messageFromString(encodeVersion(WIRE_VERSION) + "abc", noCtx)).toThrow("Unexpected message length");
  });

  it("throws when the message code can't be resolved", () => {
    const encoded = messageToString(msg({ code: 5 }));
    expect(() => messageFromString(encoded, () => undefined)).toThrow(/Unknown forecast code 5/);
  });

  it("round-trips the message code", () => {
    const decoded = roundTrip(msg({ code: 99 }));
    expect(decoded.code).toBe(99);
  });

  it("round-trips a minimal weathercode-only, all-clear message (self-delimiting body)", () => {
    // An empty selection leaves only the weathercode column; all-clear may pack to a near-empty
    // body, exercising the little-endian self-terminating path (trailing zero bits dropped).
    const clear = Array.from({ length: 8 }, () => ({ weathercode: 0 }));
    const decoded = roundTrip(msg({ vars: varSet(), periods: [clear] }));
    expect(decoded.periods[0]).toHaveLength(8);
    decoded.periods[0].forEach((p) => expect(p.weathercode).toBe(0));
  });

  // Surface wind speed is an anchor + entropy-coded period-over-period delta (like temp);
  // direction is entropy-coded under (resolution, prev, upper-level) context, with calm periods
  // carrying no direction symbol at all.
  // Speeds below are given as bmid(force) — exact band midpoints, which round-trip unchanged.
  // 12h periods: these columns are shorter than the 49 periods any all-1h layout must have (see
  // uniformLayout). The 1h wind path is covered separately below.
  const windMsg = (periods: Period[], opts: { hourly?: boolean } = {}) =>
    msg({ vars: varSet(VAR.wind), periods: [periods] }, opts);

  it("round-trips varied surface wind speeds (entropy-coded deltas) and directions", () => {
    const forces = [3, 5, 4, 6, 7, 4, 5, 3, 6, 5];
    const dirs = [0, 1, 2, 3, 4, 5, 6, 7, 0, 1];
    const periods = forces.map((f, i) => ({ weathercode: 0, wind_sfc_kph: bmid(f), wind_sfc_dir: dirs[i] }));
    const decoded = roundTrip(windMsg(periods));
    decoded.periods[0].forEach((p, i) => {
      expect(p.wind_sfc_kph).toBeCloseTo(bmid(forces[i]), 3);
      expect(p.wind_sfc_dir).toBe(dirs[i]);
    });
  });

  it("round-trips calm surface wind (all-zero speed)", () => {
    const periods = Array.from({ length: 24 }, () => ({ weathercode: 0, wind_sfc_kph: 0, wind_sfc_dir: 0 }));
    const decoded = roundTrip(windMsg(periods));
    decoded.periods[0].forEach((p) => { expect(p.wind_sfc_kph).toBe(0); expect(p.wind_sfc_dir).toBe(0); });
  });

  it("encodes a near-constant surface wind speed column smaller than a wide-swinging one", () => {
    const flat = Array.from({ length: 64 }, () => ({ weathercode: 0, wind_sfc_kph: bmid(7), wind_sfc_dir: 0 }));
    const swings = Array.from({ length: 64 }, (_, i) => ({ weathercode: 0, wind_sfc_kph: bmid(i % 2 === 0 ? 2 : 13), wind_sfc_dir: 0 }));
    expect(messageToString(windMsg(flat, { hourly: true })).length)
      .toBeLessThan(messageToString(windMsg(swings, { hourly: true })).length);
  });

  it("round-trips surface wind at 1h resolution (the resolution-keyed direction codebook)", () => {
    // Direction is coded under a (resolution, prev, upper-level) context, so the finest
    // resolution needs its own round-trip — 49 periods is the shortest all-1h layout.
    const periods = Array.from({ length: 49 }, (_, i) => ({
      weathercode: 0,
      wind_sfc_kph: bmid(4 + (i % 5)),
      wind_sfc_dir: i % 8,
    }));
    const decoded = roundTrip(
      msg({ vars: varSet(VAR.wind), periods: [periods] }, { hourly: true }));
    expect(decoded.periodHours).toEqual(Array(49).fill(1));
    decoded.periods[0].forEach((p, i) => {
      expect(p.wind_sfc_kph).toBeCloseTo(bmid(4 + (i % 5)), 3);
      expect(p.wind_sfc_dir).toBe(i % 8);
    });
  });

  it("round-trips hurricane-force jet winds (extended Beaufort, forces 13..17)", () => {
    const periods = [[
      { ...PERIOD, wind_aloft: withAloft(L500, { kph: bmid(13), dir: 4 }) },
      { ...PERIOD, wind_aloft: withAloft(L500, { kph: bmid(15), dir: 4 }) },
      { ...PERIOD, wind_aloft: withAloft(L500, { kph: bmid(17), dir: 4 }) }, // open-ended top band (≥202 kph)
    ]];
    const decoded = roundTrip(msg({ periods }));
    expect(decoded.periods[0][0].wind_aloft![L500]!.kph).toBeCloseTo(bmid(13), 3);
    expect(decoded.periods[0][1].wind_aloft![L500]!.kph).toBeCloseTo(bmid(15), 3);
    expect(decoded.periods[0][2].wind_aloft![L500]!.kph).toBeCloseTo(bmid(17), 3);
  });

  it("clamps wind speed into the top Beaufort band", () => {
    const decoded = roundTrip(msg({ periods: [[{ ...PERIOD, wind_aloft: withAloft(L700, { kph: 400, dir: 2 }) }]] }));
    expect(decoded.periods[0][0].wind_aloft![L700]!.kph).toBeCloseTo(bmid(17), 3);
  });

  it("calm periods carry no direction bits: direction values during calm can't change the encoding", () => {
    const dirsA = [3, 0, 0, 0, 5];
    const dirsB = [3, 7, 1, 4, 5]; // differs only where the wind is calm
    const forces = [4, 1, 0, 1, 6]; // force ≤ 1 (< 6 kph) is calm for direction purposes
    const build = (dirs: number[]) =>
      windMsg(forces.map((f, i) => ({ weathercode: 0, wind_sfc_kph: bmid(f), wind_sfc_dir: dirs[i] })));
    expect(messageToString(build(dirsA))).toBe(messageToString(build(dirsB)));
  });

  it("calm periods display the last decoded direction (0 before any)", () => {
    const forces = [1, 4, 0, 0, 6, 1]; // forces 0 and 1 are both calm
    const dirs = [7, 3, 7, 7, 5, 7]; // calm-period values are noise the encoder must ignore
    const decoded = roundTrip(windMsg(forces.map((f, i) => ({ weathercode: 0, wind_sfc_kph: bmid(f), wind_sfc_dir: dirs[i] }))));
    expect(decoded.periods[0].map((p) => p.wind_sfc_dir)).toEqual([0, 3, 3, 3, 5, 5]);
    expect(decoded.periods[0].map((p) => p.wind_sfc_kph)).toEqual(forces.map(bmid));
  });

  it("round-trips w600 alone (no upper-level context available)", () => {
    const vars = varSet(VAR.w600);
    const forces = [10, 12, 11, 13, 12];
    const dirs = [2, 2, 3, 3, 4];
    const periods = [forces.map((f, i) => ({ weathercode: 0, wind_aloft: aloftOnly(L600, { kph: bmid(f), dir: dirs[i] }) }))];
    const decoded = roundTrip(msg({ vars, periods }));
    decoded.periods[0].forEach((p, i) => {
      expect(p.wind_aloft![L600]!.kph).toBeCloseTo(bmid(forces[i]), 3);
      expect(p.wind_aloft![L600]!.dir).toBe(dirs[i]);
      // Unrequested levels decode as null, never as a value.
      expect(p.wind_aloft!.filter((w) => w !== null)).toHaveLength(1);
    });
  });

  it("round-trips a non-adjacent selection (500 + 700 hPa, conditioning across a skipped rung)", () => {
    const vars = varSet(VAR.w500, VAR.w700);
    const forces = [10, 12, 11, 13, 12];
    const periods = [forces.map((f, i) => ({ weathercode: 0, wind_aloft: WIND_LEVELS_HPA.map((_, li) =>
      li === L500 ? { kph: bmid(f + 2), dir: i % 8 } : li === L700 ? { kph: bmid(f), dir: (i + 1) % 8 } : null) }))];
    const decoded = roundTrip(msg({ vars, periods }));
    decoded.periods[0].forEach((p, i) => {
      expect(p.wind_aloft![L500]!.kph).toBeCloseTo(bmid(forces[i] + 2), 3);
      expect(p.wind_aloft![L700]!.kph).toBeCloseTo(bmid(forces[i]), 3);
      expect(p.wind_aloft![L700]!.dir).toBe((i + 1) % 8);
      expect(p.wind_aloft![L600]).toBeNull();
    });
  });

  it("carries every requested level whatever the elevation (no clamp, unlike the cloud band)", () => {
    // 4267 m → ground ≈ 593 hPa, so 700 hPa and below sit under the terrain — the reader asked
    // for them, so they ride the wire regardless.
    const p = roundTrip(msg({ elevation: 4267, periods: [[PERIOD, PERIOD, PERIOD]] })).periods[0][1];
    expect(p.wind_aloft!.every((w) => w !== null)).toBe(true);
    p.wind_aloft!.forEach((w, li) => expect(w!.kph).toBeCloseTo(PERIOD.wind_aloft![li]!.kph, 3));
  });

  it("an upper level that agrees makes the lower direction column cheaper (cross-level context)", () => {
    // w500+w600 both steady W vs w600 alone steady W: with the upper column present, the joint
    // message's w600 model cost must undercut the standalone one. Encode-only (never decoded),
    // so the 64 × 6h periodHours don't need to sit on a fill path — the encoder reads
    // periodHours directly.
    const n = 64;
    const sixHourly: Partial<ForecastMessage> = {
      seq: 48, mode: MODE_RANGE, hour: 0, periodHours: Array(n).fill(6),
    };
    const both = msg({ ...sixHourly, vars: varSet(VAR.w500, VAR.w600),
      periods: [Array.from({ length: n }, () => ({ weathercode: 0, wind_aloft: WIND_LEVELS_HPA.map((_, li) =>
        li === L500 ? { kph: bmid(8), dir: 6 } : li === L600 ? { kph: bmid(6), dir: 6 } : null) }))] });
    const alone = msg({ ...sixHourly, vars: varSet(VAR.w600),
      periods: [Array.from({ length: n }, () => ({ weathercode: 0, wind_aloft: aloftOnly(L600, { kph: bmid(6), dir: 6 }) }))] });
    const w600Bits = (m: ForecastMessage) =>
      encodeBreakdown(m).columns.find((c) => c.name === "w600")!.bits;
    expect(w600Bits(both)).toBeLessThan(w600Bits(alone));
  });

  // Gusts are a speed-only wind column (no direction stream). Gust decodes FIRST and lends its
  // same-period delta to the surface column when both are requested.
  it("round-trips gust speeds (speed-only column, no direction symbols)", () => {
    const gustForces = [8, 10, 9, 12, 14, 11, 10, 8, 13, 12];
    const periods = gustForces.map((g, i) => ({
      weathercode: 0,
      wind_sfc_kph: bmid(i % 4), // includes calm periods
      wind_sfc_dir: i % 8,
      wind_gust_kph: bmid(g),
    }));
    const decoded = roundTrip(msg({
      vars: varSet(VAR.wind, VAR.gust), periods: [periods],
    }));
    decoded.periods[0].forEach((p, i) => {
      expect(p.wind_gust_kph).toBeCloseTo(bmid(gustForces[i]), 3);
      expect(p.wind_sfc_kph).toBeCloseTo(bmid(i % 4), 3);
    });
  });

  it("round-trips surface wind without gust present (res-keyed fallback books)", () => {
    const forces = [3, 5, 4, 6, 5];
    const dirs = [2, 2, 3, 3, 4];
    const periods = forces.map((f, i) => ({ weathercode: 0, wind_sfc_kph: bmid(f), wind_sfc_dir: dirs[i] }));
    const decoded = roundTrip(msg({ vars: varSet(VAR.wind), periods: [periods] }));
    decoded.periods[0].forEach((p, i) => {
      expect(p.wind_sfc_kph).toBeCloseTo(bmid(forces[i]), 3);
      expect(p.wind_gust_kph).toBeUndefined();
    });
  });

  it("round-trips gusts alone (surface wind absent from the selection)", () => {
    const gustForces = [8, 10, 9, 12, 14];
    const periods = gustForces.map((g) => ({ weathercode: 0, wind_gust_kph: bmid(g) }));
    const decoded = roundTrip(msg({ vars: varSet(VAR.gust), periods: [periods] }));
    decoded.periods[0].forEach((p, i) => {
      expect(p.wind_gust_kph).toBeCloseTo(bmid(gustForces[i]), 3);
      expect(p.wind_sfc_kph).toBeUndefined();
    });
  });

  it("a gust column that moves with the surface wind makes the surface column cheaper (cross-column context)", () => {
    // Mirrors the w500/w600 test above: surface rising in step with the gusts, encoded with vs
    // without the gust column present in the selection. Encode-only (seq-pinned 6h).
    const n = 12;
    const sixHourly: Partial<ForecastMessage> = {
      seq: 48, mode: MODE_RANGE, hour: 0, periodHours: Array(n).fill(6),
    };
    const rising = (i: number) => i; // force deltas of +1, matching the gust column's
    const both = msg({ ...sixHourly, vars: varSet(VAR.wind, VAR.gust),
      periods: [Array.from({ length: n }, (_, i) => ({ weathercode: 0,
        wind_sfc_kph: bmid(rising(i) + 2), wind_sfc_dir: 6,
        wind_gust_kph: bmid(rising(i) + 4) }))] });
    const alone = msg({ ...sixHourly, vars: varSet(VAR.wind),
      periods: [Array.from({ length: n }, (_, i) => ({ weathercode: 0,
        wind_sfc_kph: bmid(rising(i) + 2), wind_sfc_dir: 6 }))] });
    const windBits = (m: ForecastMessage) =>
      encodeBreakdown(m).columns.find((c) => c.name === "wind")!.bits;
    expect(windBits(both)).toBeLessThan(windBits(alone));
  });

  it("round-trips hurricane-force storm gusts (extended Beaufort top bands)", () => {
    // Corpus gust max is 225 kph (force 17's open band); values above clamp into force 17.
    const gustForces = [12, 14, 16, 17];
    const periods = gustForces.map((g) => ({ weathercode: 0, wind_gust_kph: bmid(g) }));
    periods.push({ weathercode: 0, wind_gust_kph: 400 }); // clamps into the top band
    const decoded = roundTrip(msg({ vars: varSet(VAR.gust), periods: [periods] }));
    gustForces.forEach((g, i) =>
      expect(decoded.periods[0][i].wind_gust_kph).toBeCloseTo(bmid(g), 3));
    expect(decoded.periods[0][4].wind_gust_kph).toBeCloseTo(bmid(17), 3);
  });
});

describe("delta temperature encoding", () => {
  it("round-trips a clustered temperature column exactly", () => {
    const temps = [-5, -4, -3, 0, 2, 5, 3, 1, -2, 4];
    const periods = [temps.map((t) => ({ ...PERIOD, temp_c: t }))];
    const decoded = roundTrip(msg({ vars: varSet(VAR.temp), periods }));
    decoded.periods[0].forEach((p, i) => expect(p.temp_c).toBe(temps[i]));
  });

  it("encodes a constant column smaller than a wide-spread one (FOR offset width)", () => {
    const vars = varSet(VAR.temp);
    const flat = Array.from({ length: 64 }, () => ({ ...PERIOD, temp_c: 5 }));
    const spread = Array.from({ length: 64 }, (_, i) => ({ ...PERIOD, temp_c: i - 20 }));
    const flatLen = messageToString(msg({ vars, periods: [flat] }, { hourly: true })).length;
    const spreadLen = messageToString(msg({ vars, periods: [spread] }, { hourly: true })).length;
    expect(flatLen).toBeLessThan(spreadLen);
  });

  it("round-trips a >31°C period-over-period swing at the escape field's edge exactly", () => {
    // ±31 is the largest delta the escape payload can carry — no clamping yet.
    const temps = [-15, 16, 14, 15, -16, -14];
    const periods = [temps.map((t) => ({ ...PERIOD, temp_c: t }))];
    const decoded = roundTrip(msg({ vars: varSet(VAR.temp), periods }));
    decoded.periods[0].forEach((p, i) => expect(p.temp_c).toBe(temps[i]));
  });

  it("clamps a delta beyond the escape range and heals on the next period instead of offsetting the rest of the chain", () => {
    // -30 → +10 is a +40 delta, beyond the escape payload's range (-32..31, signed 6-bit). The
    // encoder clamps that one delta but diffs later periods against its own reconstruction, so
    // only the swing period is off (by the clamped amount) and everything after it round-trips
    // exactly.
    for (const swing of [40, -40]) {
      const start = swing > 0 ? -30 : 30;
      const temps = [start, start + swing, start + swing + 2, start + swing + 1, start + swing + 3];
      const periods = [temps.map((t) => ({ ...PERIOD, temp_c: t }))];
      const decoded = roundTrip(msg({ vars: varSet(VAR.temp), periods }));
      const out = decoded.periods[0].map((p) => p.temp_c!);
      expect(out[0]).toBe(temps[0]);
      expect(out[1]).toBe(start + Math.min(Math.max(swing, -32), 31)); // clamped
      for (let i = 2; i < temps.length; i++) expect(out[i]).toBe(temps[i]); // healed
    }
  });

  it("clamp-heals under conditioning: contexts after the clamp derive from the CLAMPED chain", () => {
    // The delta codebooks are keyed by (resolution, time-of-day, previous decoded delta). An
    // encoder that chained the raw +40 jump instead of its clamped reconstruction would desync
    // from the decoder's context. 49 hourly periods cross every 3h time-of-day bucket, with the
    // clamped jump mid-column so every later delta is coded under post-clamp context.
    const temps: number[] = [];
    for (let i = 0; i < 12; i++) temps.push(-30 + i);          // steady +1 °C/h ramp
    temps.push(temps[11] + 40);                                 // +40 jump → clamped to +31
    for (let i = 13; i < 49; i++) temps.push(temps[i - 1] - 1); // post-jump decline
    const periods = [temps.map((t) => ({ ...PERIOD, temp_c: t }))];
    const decoded = roundTrip(msg({ vars: varSet(VAR.temp), periods }, { hourly: true }));
    const out = decoded.periods[0].map((p) => p.temp_c!);
    expect(out[12]).toBe(temps[11] + 31); // clamped
    for (let i = 13; i < 49; i++) expect(out[i]).toBe(temps[i]); // healed, contexts in sync
  });
});

describe("body decode desync detection", () => {
  it("throws when meaningful body bits remain past the last column read (e.g. context-store drift)", () => {
    // Vary the last-decoded column (925 hPa wind) so its bits are guaranteed non-zero — set bits
    // at the top of the body survive encodeBodyLE's high-order-zero trimming.
    const periods = [[
      { ...PERIOD, wind_aloft: withAloft(L925, { kph: 9, dir: 2 }) },
      { ...PERIOD, wind_aloft: withAloft(L925, { kph: 9, dir: 5 }) },
      { ...PERIOD, wind_aloft: withAloft(L925, { kph: 9, dir: 7 }) },
    ]];
    const m = msg({ periods });
    const encoded = messageToString(m);
    // Resolve with a selection missing that final column: the decoder reads every earlier column
    // identically, then stops with the 925 hPa bits unread — the shape of codebook or
    // request-store drift, which would otherwise return garbage values silently.
    const drifted = { ...ctxOf(m), vars: new Set([...m.vars].filter((v) => v !== VAR.w925)) };
    expect(() => messageFromString(encoded, () => drifted)).toThrow(/desynced/);
    // The same message with the true context still decodes.
    expect(() => messageFromString(encoded, () => ctxOf(m))).not.toThrow();
  });
});

describe("corrupt character rejection", () => {
  // U+0080 is what the field actually produces: a field test found a hop that turns
  // GSM-7's Greek characters into C1 controls, Δ at septet 0x10 arriving as U+0080. É stands for
  // the milder Latin-1 case. Both are single UTF-16 units, so they corrupt in place.
  const CORRUPTIONS = [["\u0080", "U\\+0080"], ["\u00C9", "U\\+00C9"]] as const;

  it("throws instead of decoding when a body character is not in the alphabet", () => {
    const m = msg({});
    const encoded = messageToString(m);
    expect(() => messageFromString(encoded, () => ctxOf(m))).not.toThrow();

    // A body character, well past the header.
    const at = encoded.length - 3;
    for (const [ch, label] of CORRUPTIONS) {
      const damaged = encoded.slice(0, at) + ch + encoded.slice(at + 1);
      expect(() => messageFromString(damaged, () => ctxOf(m))).toThrow(
        /is not a base-85 character/,
      );
      // The message names the character, its code point and where it sits — a corruption
      // reported from the field has to be diagnosable from one pasted reply.
      expect(() => messageFromString(damaged, () => ctxOf(m))).toThrow(
        // The index counts from the body, which starts after the version tag and header.
        new RegExp(`${label}\\) at ${at - WIRE_HEADER_CHARS} of the body`),
      );
    }
  });

  it("throws instead of decoding when a header character is not in the alphabet", () => {
    // The header is the worse of the two: it is read MSB-first, so skipping a character used to
    // shift every later digit down a place and silently produce a different code and seq.
    const m = msg({});
    const encoded = messageToString(m);
    for (const [ch] of CORRUPTIONS) {
      const damaged = encoded.slice(0, 2) + ch + encoded.slice(3);
      expect(() => messageFromString(damaged, () => ctxOf(m))).toThrow(
        /is not a base-85 character/,
      );
    }
  });

  it("still decodes a message whose every character is in the alphabet", () => {
    // The guard must not fire on the alphabet's own edges — the first and last characters of
    // ALPHABET are the ones an off-by-one in the lookup would drop.
    const m = msg({});
    expect(() => messageFromString(messageToString(m), () => ctxOf(m))).not.toThrow();
    expect(ALPHABET).toContain("!");
    expect(ALPHABET).toContain("z");
  });
});

describe("order-1 precipitation encoding", () => {
  const vars = varSet(VAR.snow);
  // The snow codebooks key on the same period's weathercode class, so a period must carry a
  // weathercode consistent with its snowfall — "snowing hard, zero accumulation" is a
  // contradiction the tables (rightly) charge for, and it isn't what these tests are about.
  const snowPeriod = (cm: number): Period => ({ ...PERIOD, weathercode: cm > 0 ? 71 : 0, snow_cm: cm });

  it("collapses an all-dry snow column to almost nothing and round-trips to zero", () => {
    const dry = Array.from({ length: 72 }, () => snowPeriod(0));
    const decoded = roundTrip(msg({ vars, periods: [dry] }, { hourly: true }));
    decoded.periods[0].forEach((p) => expect(p.snow_cm).toBe(0));
    // A dry run is the order-1 tables' cheapest input (P(0 | prev=0, clear) is near 1), so the
    // all-dry column must undercut one with snow every period. Compare exact body bits (not the
    // base-85 encoded char length) since a few bits of savings can land on either side of a char
    // boundary and not move the visible string length.
    const snowy = Array.from({ length: 72 }, () => snowPeriod(20));
    const dryBits = encodeBreakdown(msg({ vars, periods: [dry] }, { hourly: true })).bodyBits;
    const snowyBits = encodeBreakdown(msg({ vars, periods: [snowy] }, { hourly: true })).bodyBits;
    expect(dryBits).toBeLessThan(snowyBits);
  });

  it("round-trips a mostly-zero snow column exactly", () => {
    const vals = Array.from({ length: 72 }, (_, i) => (i % 12 === 0 ? 10 : 0));
    const periods = [vals.map(snowPeriod)];
    const decoded = roundTrip(msg({ vars, periods }, { hourly: true }));
    decoded.periods[0].forEach((p, i) => expect(p.snow_cm).toBeCloseTo(qSnow(vals[i]), 5));
    // Mostly-dry beats a column where every cell is nonzero and widely spread.
    const dense = Array.from({ length: 72 }, (_, i) => snowPeriod(3 * (i + 1)));
    const sparseBits = encodeBreakdown(msg({ vars, periods }, { hourly: true })).bodyBits;
    const denseBits = encodeBreakdown(msg({ vars, periods: [dense] }, { hourly: true })).bodyBits;
    expect(sparseBits).toBeLessThan(denseBits);
  });

  it("a snowing weathercode makes the same snow column cheaper (cross-variable context)", () => {
    // The wet columns key their codebooks on the SAME period's weathercode class, which is free
    // context (weathercode decodes first, always present). Identical snowfall under code 71
    // (snow) vs code 0 (clear) must cost fewer bits in the SNOW column — the weathercode column's
    // own cost differs between the two messages, so bodyBits would conflate the two effects.
    const snowing = Array.from({ length: 72 }, () => ({ ...PERIOD, weathercode: 71, snow_cm: 6 }));
    const clear = snowing.map((p) => ({ ...p, weathercode: 0 }));
    const snowBits = (periods: Period[]) =>
      encodeBreakdown(msg({ vars, periods: [periods] }, { hourly: true }))
        .columns.find((c) => c.name === "snow")!.bits;
    expect(snowBits(snowing)).toBeLessThan(snowBits(clear));
  });
});
