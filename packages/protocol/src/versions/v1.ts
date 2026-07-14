import {
  WMO_CODES, VARS_BIT,
} from "../constants.js";
import { layoutFor, maxFillSeq } from "../layout.js";
import { putInt, takeInt, compandSqrt, expandSqrt } from "../bits.js";
import { encode, decode, encodeBodyLE, decodeBodyLE, nCharsForBits } from "../codec.js";
import { encodeVersion, takeVersion, VERSION_PREFIX_CHARS } from "../version.js";
import { WMO2IDX, type Period } from "../model.js";
import type { ForecastMessage, VersionedCodec, ContextResolver } from "../model.js";
import {
  encodeWeathercode, decodeWeathercode, WEATHERCODE_CLASS,
  windDirBook, windSpeedBook, encodeWindSpeedDelta, decodeWindSpeedDelta,
  precipBook, snowBook, rainBook,
  FREEZE_DELTA,
  CLOUD_HIGH_DELTA, CLOUD_MID_DELTA, CLOUD_LOW_DELTA, type DeltaCodec,
  encodeTempDelta, decodeTempDelta, tempDeltaBook, tempTodBucket,
  TEMP_DELTA_MIN, TEMP_DELTA_MAX,
  makeBitSink, makeBitSource, type CodeBook,
} from "../entropy.js";

export const V1_VERSION = 1;
const VERSION = V1_VERSION;

// Duration-first fill: the user requests a duration in days and the server fills the message
// budget by refining days from the front of the window (see layout.ts).
//
// The response is slim: lat/lon/model/vars, the requested duration, the UTC offset, AND the
// request datetime are NOT on the wire. The client stores the request under `code` and recovers
// them via a ContextResolver at decode time (see RequestContext). The period layout — count and
// per-period resolution — isn't on the wire either: the header carries only the fill-sequence
// number, from which both sides derive the identical layout via layoutFor(). Periods within one
// message can span different resolutions, which the column codecs already handle (the temp-delta
// codebooks were derived across resolutions for exactly this reason, see entropy.ts).
//
// The 7-bit version field lives in the shared, self-describing prefix (see version.ts), not in this
// packed header. Packed header layout (22 bits):
//   code:7 seq:8 elev:7
// seq:8 stores (seq - 1), i.e. 1..256; the largest layout is seq = 5 × durationDays.
// The body carries no length field — it is a single rANS stream (see rans.ts), serialized
// little-endian and self-delimiting: the decoder knows the structure and consumes exactly the
// symbols the encoder wrote (see encodeBodyLE/decodeBodyLE and SymSource.assertDone).
// The weathercode column has no codebook selector either: each symbol's codebook is keyed by
// the previously decoded symbol, which both sides already have (see entropy.ts).
export const V1_SEQ_BITS = 8;

// Message code: client-assigned key the response echoes; see RequestContext / model.ts.
const CODE_BITS = 7;
// Elevation: 7 bits in 100 m steps → 0..12700 m. It's a coarse sanity check (summit vs. valley),
// so metre precision isn't needed.
const ELEV_BITS = 7;
const ELEV_STEP_M = 100;

export const V1_HEADER_BITS =
  CODE_BITS + V1_SEQ_BITS + ELEV_BITS; // 22
// Total chars before the body: the shared version prefix plus this version's packed header.
export const V1_HEADER_CHARS = VERSION_PREFIX_CHARS + nCharsForBits(V1_HEADER_BITS); // 1 + 4 = 5
const HEADER_BITS = V1_HEADER_BITS;
const HEADER_CHARS = nCharsForBits(V1_HEADER_BITS); // packed-header chars (excludes version prefix)

// temp: 8 bits, 1°C steps, offset -100°C → -100°C to +155°C
// snow/rain: 6 bits each, sqrt-companded (see ACCUM_* below). rain is bit 12, the slot
// formerly reserved for the removed `vis`; bit 13 (formerly tmin) is reserved, as is bit 8
// (formerly cloud_total — redundant with weathercode + per-altitude cloud cover, removed).
// wind: 8 = 5-bit speed + 3-bit direction (raw-width equivalent; both entropy-coded).
export const VAR_BITS_V1 = [3, 8, 6, 4, 8, 8, 8, 8, 0, 3, 3, 3, 6];
//                          ^p ^t ^s ^f ^w ^5 ^6 ^7 ^-- ^cch ^ccm ^ccl ^rain

const TEMP_OFFSET = 100;

// Snow (cm) and rain (mm) use sqrt companding (see compandSqrt): fine resolution near zero,
// coarsening with magnitude, so one 6-bit field spans light hourly through heavy daily
// accumulation. k = (2^bits - 1) / sqrt(maxValue).
export const ACCUM_BITS = 6;
const ACCUM_MAX = (1 << ACCUM_BITS) - 1;
export const SNOW_MAX_CM = 200;
export const RAIN_MAX_MM = 144;
export const SNOW_K = ACCUM_MAX / Math.sqrt(SNOW_MAX_CM); // ≈ 4.4548
export const RAIN_K = ACCUM_MAX / Math.sqrt(RAIN_MAX_MM); // = 5.25
const KPH_PER_STEP = 5 * 1.609344;
// Speed steps 0..31 (5 mph each → 155 mph cap). The old 4-bit domain saturated at 75 mph, which
// real 500 hPa winds exceed in 6-8.6% of corpus periods — the wrong place to clamp for a tool
// built around high-altitude wind.
const WIND_SPEED_BITS = 5;
const WIND_SPEED_MAX = (1 << WIND_SPEED_BITS) - 1;

function clampInt(v: number, width: number): number {
  return Math.min(Math.max(v, 0), (1 << width) - 1);
}

// temp: entropy-coded period-over-period deltas (see TEMP_DELTA_* in entropy.ts), not a plain
// scalar column — each model's first period is an anchor at full width, quantized the same way.
const TEMP_ANCHOR_BITS = VAR_BITS_V1[VARS_BIT.temp];
const quantTemp = (p: Period, field: "temp_c"): number =>
  clampInt(Math.round((p[field] ?? 0) + TEMP_OFFSET), TEMP_ANCHOR_BITS);
const TEMP_DELTA_COLUMNS: [bit: number, field: "temp_c", name: string][] = [
  [VARS_BIT.temp, "temp_c", "temp"],
];

// freeze: entropy-coded period-over-period deltas under a single shared table (see FREEZE_DELTA
// in entropy.ts — no per-message selector; freeze-level delta shape doesn't vary enough by
// location/season to be worth one), not a plain scalar column. 304.8 m (1000 ft) steps,
// 0..15 (0-15000 ft).
const FREEZE_STEP_M = 304.8;
const FREEZE_ANCHOR_BITS = VAR_BITS_V1[VARS_BIT.freeze];
// The 1e-9 rescues float dust only (14 × 304.8 / 304.8 = 13.999999999999998 → 13 without it, so
// a decoded value would re-quantize one step down); genuine sub-step values still floor down.
const quantFreeze = (p: Period): number => clampInt(Math.floor((p.freeze_m ?? 0) / FREEZE_STEP_M + 1e-9), FREEZE_ANCHOR_BITS);

// cloud cover (low/mid/high): entropy-coded period-over-period deltas (see CLOUD_*_DELTA in
// entropy.ts) — same anchor+delta shape as freeze, each level under its own single shared table
// (not pooled across levels) since low/mid/high cloud persistence differs meaningfully by
// altitude.
const CLOUD_ANCHOR_BITS = VAR_BITS_V1[VARS_BIT.cch]; // 3; ccm/ccl share the same width
const quantCloud = (p: Period, field: "cloud_high" | "cloud_mid" | "cloud_low"): number =>
  clampInt(Math.round((p[field] ?? 0) * 7 / 100), CLOUD_ANCHOR_BITS);
const CLOUD_DELTA_COLUMNS: {
  bit: number;
  field: "cloud_high" | "cloud_mid" | "cloud_low";
  codec: DeltaCodec;
}[] = [
  { bit: VARS_BIT.cch, field: "cloud_high", codec: CLOUD_HIGH_DELTA },
  { bit: VARS_BIT.ccm, field: "cloud_mid", codec: CLOUD_MID_DELTA },
  { bit: VARS_BIT.ccl, field: "cloud_low", codec: CLOUD_LOW_DELTA },
];

// Value columns (precip chance, snow, rain), in body (column-major) order: each cell's quantized
// value is entropy-coded directly — no anchor, no deltas — under a codebook keyed by (the period's
// resolution, the SAME cell's weathercode class, the previously decoded value), or the variable's
// bootstrap table for the column's first cell (see precipBook/snowBook/rainBook in entropy.ts).
// The weathercode column decodes first and is always present, so its class is free context for
// all three — the same trick the 600/700 hPa wind columns play on the upper pressure level, and
// worth 0.10-0.33 b/period each (see WEATHERCODE_CLASS in entropy.ts). Values, not deltas,
// because zero is an absorbing regime: "still dry" is the single strongest signal these columns
// carry, and a delta of 0 would conflate it with "steady heavy snowfall". This replaced the
// adaptive best-of (raw / FOR / sparse / empty + 2-bit selector) scheme — sparse charged a full
// bit per dry period where the order-1 tables charge a small fraction of one. temp (bit 1),
// freeze (bit 3) and cloud_high/mid/low (bits 9/10/11) are handled separately in
// buildBody/decode below.
const VALUE_COLUMNS: {
  bit: number;
  book(res: number, wcClass: number, prev: number | null): CodeBook;
  get(p: Period): number;          // quantized value symbol
  set(p: Period, v: number): void; // dequantize the symbol back onto the period
}[] = [
  { bit: 0, book: precipBook,
    get: (p) => clampInt(Math.round((p.precip ?? 0) * 7 / 100), 3),
    set: (p, v) => { p.precip = Math.round(v * 100 / 7); } },
  { bit: 2, book: snowBook,
    get: (p) => compandSqrt(p.snow_cm ?? 0, SNOW_K, ACCUM_BITS),
    set: (p, v) => { p.snow_cm = expandSqrt(v, SNOW_K); } },
  { bit: 12, book: rainBook,
    get: (p) => compandSqrt(p.rain_mm ?? 0, RAIN_K, ACCUM_BITS),
    set: (p, v) => { p.rain_mm = expandSqrt(v, RAIN_K); } },
];

// Wind columns (surface + 500/600/700 hPa): speed + direction per cell, both entropy-coded under
// tables keyed by context both sides already have — each period's resolution, the column's level,
// and (for 600/700 hPa) the upper pressure level's already-decoded same-period values, since
// adjacent levels share the synoptic flow (see windSpeedBook/windDirBook in entropy.ts). `level`
// indexes the speed-table axis; `upperBit` names the column conditioned on, applied only when
// that column is present in vars_mask (upper columns encode/decode first in this array's order).
// Calm periods (quantized speed 0) carry no direction symbol at all — see buildBody.
const WIND_COLUMNS: { bit: number; kph: keyof Period; dir: keyof Period; level: number; upperBit: number }[] = [
  { bit: 4, kph: "wind_sfc_kph", dir: "wind_sfc_dir", level: 0, upperBit: -1 },
  { bit: 5, kph: "wind_500_kph", dir: "wind_500_dir", level: 1, upperBit: -1 },
  { bit: 6, kph: "wind_600_kph", dir: "wind_600_dir", level: 2, upperBit: 5 },
  { bit: 7, kph: "wind_700_kph", dir: "wind_700_dir", level: 3, upperBit: 6 },
];

// Per-period codebook resolution index (0..4 = 24h..1h) from each period's span. The fill mixes
// resolutions within one message, and both sides know the layout (the encoder from
// msg.periodHours, the decoder from layoutFor), so a per-period table key costs no wire bits.
// A period-over-period delta at a resolution boundary is keyed by the ARRIVING period's
// resolution — the step it spans.
const HOURS_TO_RES: Record<number, number> = { 24: 0, 12: 1, 6: 2, 3: 3, 1: 4 };
const resTableIdx = (periodHours: number[]): number[] =>
  periodHours.map((h) => HOURS_TO_RES[h] ?? 0);

// Per-period local time-of-day bucket (see tempTodBucket in entropy.ts), from the first period's
// UTC start hour (msg.hour — layout-derived on both sides), the contiguous period spans, and the
// location's UTC offset — all context both sides already have, so it costs no wire bits. Periods
// are contiguous by construction (see layoutFor), so start times are prefix sums of the spans;
// half-hours keep the midpoint integral at every resolution.
const todTableIdx = (firstHour: number, periodHours: number[], utcOffsetHours: number): number[] => {
  const out: number[] = [];
  let startHalfHours = (firstHour + utcOffsetHours) * 2;
  for (const h of periodHours) {
    out.push(tempTodBucket(startHalfHours + h)); // midpoint = start + h/2
    startHalfHours += 2 * h;
  }
  return out;
};

// A sequential reader over the entropy-coded body: convenience wrappers for each codec around
// the shared SymSource (which owns the coder state).
function reader(bits: number[]) {
  const src = makeBitSource(bits);
  return {
    int: (n: number): number => src.raw(n),
    weathercode: (prevSym: number | null): number => decodeWeathercode(src, prevSym),
    sym: (book: CodeBook): number => src.sym(book),
    windSpeedDelta: (book: CodeBook): number => decodeWindSpeedDelta(src, book),
    delta: (codec: DeltaCodec): number => codec.decode(src),
    tempDelta: (book: CodeBook): number => decodeTempDelta(src, book),
    assertDone: (): void => src.assertDone(),
  };
}

// The packed header is plain fixed-width MSB-first bits — not part of the body's rANS stream —
// so it gets a plain bit cursor, not a SymSource.
function headerReader(bits: number[]) {
  let pos = 0;
  return {
    int(n: number): number { const [v, p] = takeInt(bits, pos, n); pos = p; return v; },
  };
}

// Visits every cell in column-major (period-major, model-minor) order.
function eachCell(nPeriods: number, nModels: number, fn: (p: number, m: number) => void): void {
  for (let p = 0; p < nPeriods; p++) for (let m = 0; m < nModels; m++) fn(p, m);
}

// ── Top-level codec ────────────────────────────────────────────────────────────

// Column-name map (bit → var label from VARS_BIT), for the instrumented breakdown below.
const BIT_NAME: Record<number, string> = Object.fromEntries(
  Object.entries(VARS_BIT).map(([name, bit]) => [bit, name]),
);

// Callback receiving each column's contribution as it is emitted: label and bit cost.
type ColumnSink = (name: string, bits: number) => void;

// Build the column-major body (shared by the string encoder and the instrumented breakdown). The
// optional sink observes per-column bit costs without changing the bytes produced.
function buildBody(msg: ForecastMessage, sink?: ColumnSink): { body: number[] } {
  const nModels = msg.periods.length;
  const nPeriods = msg.periods[0].length;
  const res = resTableIdx(msg.periodHours);
  const em = makeBitSink();
  const mark = (name: string, before: number) => sink?.(name, em.cost - before);

  // Weathercode column (always present, entropy-coded). Each symbol's codebook is keyed by the
  // previously encoded symbol — null (the bootstrap table) for the first symbol of the sequence.
  // The symbols are kept: their classes key the value columns below, and taking the class from the
  // ENCODED symbol (not the raw input code, which may not be a known WMO code) is what keeps the
  // encoder's context identical to the decoder's.
  let before = em.cost;
  let prevWcSym: number | null = null;
  const wcSym: number[][] = msg.periods.map((rows) => rows.map(() => 0));
  eachCell(nPeriods, nModels, (p, m) => {
    const idx = WMO2IDX[msg.periods[m][p].weathercode] ?? 0;
    encodeWeathercode(em, prevWcSym, idx);
    wcSym[m][p] = idx;
    prevWcSym = idx;
  });
  mark("weathercode", before);

  // temp: per model, an anchor (first period, full width) followed by entropy-coded
  // period-over-period deltas — never diffed across a model boundary. Each delta's codebook is
  // keyed by (the arriving period's resolution and time-of-day bucket, the previous decoded
  // delta) — see tempDeltaBook in entropy.ts; the model's first delta uses the bootstrap table.
  // A delta beyond the escape field's range (|jump| > 32°C between periods) is clamped to
  // TEMP_DELTA_MIN..TEMP_DELTA_MAX, and every later delta is diffed against the decoder's
  // reconstruction, so the error heals on the next period instead of offsetting the rest of the
  // column. CRITICAL: the context chains the CLAMPED delta (what the decoder will decode), never
  // the raw input difference — otherwise the two sides' contexts diverge after a clamp.
  const tod = todTableIdx(msg.hour, msg.periodHours, msg.utcOffsetHours);
  for (const [bit, field, name] of TEMP_DELTA_COLUMNS) {
    if (!(msg.vars_mask & (1 << bit))) continue;
    before = em.cost;
    for (let m = 0; m < nModels; m++) {
      let reconstructed = quantTemp(msg.periods[m][0], field);
      em.raw(reconstructed, TEMP_ANCHOR_BITS);
      let prevDelta: number | null = null;
      for (let p = 1; p < nPeriods; p++) {
        const delta = Math.min(Math.max(
          quantTemp(msg.periods[m][p], field) - reconstructed, TEMP_DELTA_MIN), TEMP_DELTA_MAX);
        encodeTempDelta(em, tempDeltaBook(res[p], tod[p], prevDelta), delta);
        reconstructed += delta;
        prevDelta = delta;
      }
    }
    mark(name, before);
  }

  // freeze: per model, an anchor (first period, full width) followed by entropy-coded
  // period-over-period deltas under a single shared table (see FREEZE_DELTA in entropy.ts —
  // no per-message selector).
  if (msg.vars_mask & (1 << VARS_BIT.freeze)) {
    before = em.cost;
    for (let m = 0; m < nModels; m++) {
      em.raw(quantFreeze(msg.periods[m][0]), FREEZE_ANCHOR_BITS);
      for (let p = 1; p < nPeriods; p++) {
        FREEZE_DELTA.encode(em, quantFreeze(msg.periods[m][p]) - quantFreeze(msg.periods[m][p - 1]));
      }
    }
    mark("freeze", before);
  }

  // cloud cover (low/mid/high): per model, an anchor (first period, full width) followed by
  // entropy-coded period-over-period deltas, each level under its own single shared table (see
  // CLOUD_*_DELTA in entropy.ts — no per-message selector).
  for (const col of CLOUD_DELTA_COLUMNS) {
    if (!(msg.vars_mask & (1 << col.bit))) continue;
    before = em.cost;
    for (let m = 0; m < nModels; m++) {
      em.raw(quantCloud(msg.periods[m][0], col.field), CLOUD_ANCHOR_BITS);
      for (let p = 1; p < nPeriods; p++) {
        col.codec.encode(em, quantCloud(msg.periods[m][p], col.field) - quantCloud(msg.periods[m][p - 1], col.field));
      }
    }
    mark(BIT_NAME[col.bit], before);
  }

  // Value columns (precip chance, snow, rain): each cell's quantized value entropy-coded under a
  // table keyed by (the period's resolution, the cell's own weathercode class, the previously
  // encoded value) — bootstrap for the column's first cell. The chain carries across model
  // boundaries, like weathercode.
  for (const col of VALUE_COLUMNS) {
    if (!(msg.vars_mask & (1 << col.bit))) continue;
    before = em.cost;
    let prev: number | null = null;
    eachCell(nPeriods, nModels, (p, m) => {
      const v = col.get(msg.periods[m][p]);
      em.sym(col.book(res[p], WEATHERCODE_CLASS[wcSym[m][p]], prev), v);
      prev = v;
    });
    mark(BIT_NAME[col.bit], before);
  }
  // Same float-dust epsilon as quantFreeze: a decoded speed (s × step) must re-quantize to s.
  const windSpeed = (c: Period, kph: keyof Period) =>
    Math.min(Math.floor(((c[kph] as number) ?? 0) / KPH_PER_STEP + 1e-9), WIND_SPEED_MAX);
  // Quantized speeds and displayed directions of already-encoded wind columns, keyed by var bit —
  // the cross-level context for the 600/700 hPa columns (their upper column encodes first).
  const spdByBit = new Map<number, number[][]>();
  const dispByBit = new Map<number, number[][]>();
  for (const col of WIND_COLUMNS) {
    if (!(msg.vars_mask & (1 << col.bit))) continue;
    before = em.cost;
    const upper = col.upperBit >= 0 && (msg.vars_mask & (1 << col.upperBit))
      ? { spd: spdByBit.get(col.upperBit)!, disp: dispByBit.get(col.upperBit)! }
      : null;
    const spd: number[][] = msg.periods.map((rows) => rows.map((c) => windSpeed(c, col.kph)));

    // Speed: per model, a raw anchor then entropy-coded period-over-period deltas, the table
    // keyed by (the period's resolution, level) — or by the upper level's same-period delta when
    // that column is present (see windSpeedBook in entropy.ts). Never diffed across a model
    // boundary.
    for (let m = 0; m < nModels; m++) {
      em.raw(spd[m][0], WIND_SPEED_BITS);
      for (let p = 1; p < nPeriods; p++) {
        const book = windSpeedBook(res[p], col.level, upper ? upper.spd[m][p] - upper.spd[m][p - 1] : null);
        encodeWindSpeedDelta(em, book, spd[m][p] - spd[m][p - 1]);
      }
    }

    // Direction: entropy-coded under a table keyed by (the period's resolution, previously
    // encoded direction, and the upper level's same-period displayed direction when present).
    // Calm periods (speed step 0) emit no symbol at all — direction there is weather-model
    // dither — and the context chain carries the last encoded direction across the gap. disp[]
    // is the direction a client shows for each period (last encoded, 0 before any); the decoder
    // reconstructs it identically.
    const disp: number[][] = msg.periods.map((rows) => rows.map(() => 0));
    const eff: number[] = new Array(nModels).fill(0);
    let prevDir: number | null = null;
    eachCell(nPeriods, nModels, (p, m) => {
      if (spd[m][p] > 0) {
        const d = ((msg.periods[m][p][col.dir] as number) ?? 0) % 8;
        em.sym(windDirBook(res[p], prevDir, upper ? upper.disp[m][p] : null), d);
        prevDir = d;
        eff[m] = d;
      }
      disp[m][p] = eff[m];
    });
    spdByBit.set(col.bit, spd);
    dispByBit.set(col.bit, disp);

    mark(BIT_NAME[col.bit], before);
  }

  return { body: em.bits };
}

// lat/lon/model/vars/duration/offset and the request datetime are recovered client-side via
// `code` (RequestContext), and the period layout is derived from `seq` — so all of them are
// intentionally absent from the header.
function buildHeader(msg: ForecastMessage): number[] {
  const seq = msg.seq;
  if (!Number.isInteger(seq) || seq < 1 || seq > 1 << V1_SEQ_BITS)
    throw new Error(`v1: message has no valid fill-sequence number (seq=${seq})`);
  const headerBits: number[] = [];
  putInt(headerBits, msg.code, CODE_BITS);
  putInt(headerBits, seq - 1, V1_SEQ_BITS);
  putInt(headerBits, Math.min(Math.max(Math.round(msg.elevation / ELEV_STEP_M), 0), (1 << ELEV_BITS) - 1), ELEV_BITS);
  return headerBits;
}

export function v1MessageToString(msg: ForecastMessage): string {
  const { body } = buildBody(msg);
  return encodeVersion(VERSION) + encode(buildHeader(msg)) + encodeBodyLE(body);
}

// One column's contribution to a message: its model cost in (fractional) bits.
export interface ColumnBreakdown { name: string; bits: number }

// Per-column bit accounting for a message, for encoding experiments. Produces the identical string
// as v1MessageToString (via the same buildBody), plus the bit cost of the version prefix, packed
// header, weathercode, and every present variable column.
export interface V1Breakdown {
  encoded: string;
  chars: number;
  versionBits: number;   // self-describing version prefix
  headerBits: number;    // packed header (code/periods/elev)
  bodyBits: number;      // actual serialized body bits (rANS state + renorm words)
  overheadBits: number;  // bodyBits − Σ columns[].bits: the coder's flush/renorm slack
  columns: ColumnBreakdown[];
}

export function v1EncodeBreakdown(msg: ForecastMessage): V1Breakdown {
  const columns: ColumnBreakdown[] = [];
  const { body } = buildBody(msg, (name, bits) => columns.push({ name, bits }));
  const encoded = encodeVersion(VERSION) + encode(buildHeader(msg)) + encodeBodyLE(body);
  const modelBits = columns.reduce((s, c) => s + c.bits, 0);
  return {
    encoded,
    chars: encoded.length,
    versionBits: VERSION_PREFIX_CHARS * 7, // GSM-7 septet per prefix char
    headerBits: HEADER_BITS,
    bodyBits: body.length,
    overheadBits: body.length - modelBits,
    columns,
  };
}

export function v1MessageFromString(s: string, resolve: ContextResolver): ForecastMessage {
  const [version, rest] = takeVersion(s);
  if (version !== VERSION)
    throw new Error(`Version mismatch: encoded v${version}, expected v${VERSION}`);

  if (rest.length < HEADER_CHARS)
    throw new Error(`Unexpected message length: ${s.length} chars`);

  const headerBits = decode(rest.slice(0, HEADER_CHARS), HEADER_BITS);
  const hr = headerReader(headerBits);

  const code = hr.int(CODE_BITS);
  const seq = hr.int(V1_SEQ_BITS) + 1;
  const elevation = hr.int(ELEV_BITS) * ELEV_STEP_M;

  // Recover the request-echo fields the slim header omits.
  const ctx = resolve(code);
  if (!ctx) throw new Error(`Unknown forecast code ${code}: no matching request in the store`);
  const { model, vars_mask, lat, lon, start, durationDays, utcOffsetHours } = ctx;
  if (durationDays == null || utcOffsetHours == null)
    throw new Error(`Forecast code ${code} matches a request without a duration`);
  if (seq > maxFillSeq(durationDays))
    throw new Error(`v1: seq ${seq} exceeds the ${durationDays}d fill sequence`);
  const models_mask = 1 << model; // a response carries exactly one model

  // The period layout is derived, not decoded: both sides compute it from the stored request.
  const requestUtcHour = Math.floor(start / 3600000);
  const layout = layoutFor(durationDays, requestUtcHour, utcOffsetHours, seq);

  // month/day/hour describe the FIRST PERIOD's start (which precedes the request time — the
  // first period is the one containing it), so display code can lay periods out from it.
  const firstStart = new Date(layout.periodStartUtcHour[0] * 3600000);

  // The body has no length field: the rANS stream is self-delimiting given the known structure
  // (nPeriods, nModels, vars_mask). decodeBodyLE materializes the meaningful low bits; renorm
  // words past them read as 0 — exactly the trailing zero words encodeBodyLE dropped. The first
  // period's UTC start hour and the UTC offset key the temp time-of-day tables — the identical
  // values the encoder used (msg.hour is layout-derived on both sides).
  const periods = decodeBody(
    decodeBodyLE(rest.slice(HEADER_CHARS)), vars_mask, layout.periodHours,
    firstStart.getUTCHours(), utcOffsetHours, 1);

  return {
    version,
    code,
    days: layout.days,
    models_mask,
    vars_mask,
    month: firstStart.getUTCMonth() + 1,
    day: firstStart.getUTCDate(),
    hour: firstStart.getUTCHours(),
    lat,
    lon,
    elevation,
    periods,
    seq,
    durationDays,
    periodHours: layout.periodHours,
    utcOffsetHours,
  };
}

// Decodes the column-major body written by buildBody, given the structure the header/context
// implies (`periodHours` is the derived layout — it keys the wind tables per period). Throws
// unless the stream is consumed exactly (see SymSource.assertDone).
function decodeBody(
  bodyBits: number[], vars_mask: number, periodHours: number[],
  firstHour: number, utcOffsetHours: number, nModels: number,
): Period[][] {
  const nPeriods = periodHours.length;
  const rd = reader(bodyBits);

  const periods: Period[][] = Array.from({ length: nModels }, () =>
    Array.from({ length: nPeriods }, () => ({ weathercode: 0 } as Period)));

  // Weathercode column (entropy-coded, each symbol keyed by the previously decoded symbol). The
  // symbols are kept — their classes key the value columns below, mirroring buildBody.
  let prevWcSym: number | null = null;
  const wcSym: number[][] = periods.map((rows) => rows.map(() => 0));
  eachCell(nPeriods, nModels, (p, m) => {
    const sym = rd.weathercode(prevWcSym);
    periods[m][p].weathercode = WMO_CODES[sym] ?? 0;
    wcSym[m][p] = sym;
    prevWcSym = sym;
  });

  // Temp mirrors buildBody exactly: each delta's codebook keyed by (the arriving period's
  // resolution and time-of-day bucket, the previously decoded delta) — bootstrap for each
  // model's first delta.
  const res = resTableIdx(periodHours);
  const tod = todTableIdx(firstHour, periodHours, utcOffsetHours);
  for (const [bit, field] of TEMP_DELTA_COLUMNS) {
    if (!(vars_mask & (1 << bit))) continue;
    for (let m = 0; m < nModels; m++) {
      let quant = rd.int(TEMP_ANCHOR_BITS);
      periods[m][0][field] = quant - TEMP_OFFSET;
      let prevDelta: number | null = null;
      for (let p = 1; p < nPeriods; p++) {
        const delta = rd.tempDelta(tempDeltaBook(res[p], tod[p], prevDelta));
        quant += delta;
        periods[m][p][field] = quant - TEMP_OFFSET;
        prevDelta = delta;
      }
    }
  }

  if (vars_mask & (1 << VARS_BIT.freeze)) {
    for (let m = 0; m < nModels; m++) {
      let quant = rd.int(FREEZE_ANCHOR_BITS);
      periods[m][0].freeze_m = quant * FREEZE_STEP_M;
      for (let p = 1; p < nPeriods; p++) {
        quant += rd.delta(FREEZE_DELTA);
        periods[m][p].freeze_m = quant * FREEZE_STEP_M;
      }
    }
  }

  for (const col of CLOUD_DELTA_COLUMNS) {
    if (!(vars_mask & (1 << col.bit))) continue;
    for (let m = 0; m < nModels; m++) {
      let quant = rd.int(CLOUD_ANCHOR_BITS);
      periods[m][0][col.field] = Math.round((quant * 100) / 7);
      for (let p = 1; p < nPeriods; p++) {
        quant += rd.delta(col.codec);
        periods[m][p][col.field] = Math.round((quant * 100) / 7);
      }
    }
  }

  // Value columns mirror buildBody exactly: each symbol's table keyed by (the period's
  // resolution, the cell's decoded weathercode class, the previously decoded value), bootstrap
  // first, chained across model boundaries.
  for (const col of VALUE_COLUMNS) {
    if (!(vars_mask & (1 << col.bit))) continue;
    let prev: number | null = null;
    eachCell(nPeriods, nModels, (p, m) => {
      const v = rd.sym(col.book(res[p], WEATHERCODE_CLASS[wcSym[m][p]], prev));
      col.set(periods[m][p], v);
      prev = v;
    });
  }
  // Wind columns mirror buildBody exactly: speeds first (anchors + deltas), then calm-gated
  // directions, with the upper column's already-decoded values as cross-level context.
  const spdByBit = new Map<number, number[][]>();
  const dispByBit = new Map<number, number[][]>();
  for (const col of WIND_COLUMNS) {
    if (!(vars_mask & (1 << col.bit))) continue;
    const upper = col.upperBit >= 0 && (vars_mask & (1 << col.upperBit))
      ? { spd: spdByBit.get(col.upperBit)!, disp: dispByBit.get(col.upperBit)! }
      : null;

    const spd: number[][] = Array.from({ length: nModels }, () => new Array<number>(nPeriods).fill(0));
    for (let m = 0; m < nModels; m++) {
      let speed = rd.int(WIND_SPEED_BITS);
      spd[m][0] = speed;
      (periods[m][0][col.kph] as number) = speed * KPH_PER_STEP;
      for (let p = 1; p < nPeriods; p++) {
        const book = windSpeedBook(res[p], col.level, upper ? upper.spd[m][p] - upper.spd[m][p - 1] : null);
        speed += rd.windSpeedDelta(book);
        spd[m][p] = speed;
        (periods[m][p][col.kph] as number) = speed * KPH_PER_STEP;
      }
    }

    // Calm periods carried no direction symbol; they display the last decoded direction (0
    // before any), which is also the value the upper-context chain uses.
    const disp: number[][] = Array.from({ length: nModels }, () => new Array<number>(nPeriods).fill(0));
    const eff: number[] = new Array(nModels).fill(0);
    let prevDir: number | null = null;
    eachCell(nPeriods, nModels, (p, m) => {
      if (spd[m][p] > 0) {
        const d = rd.sym(windDirBook(res[p], prevDir, upper ? upper.disp[m][p] : null));
        prevDir = d;
        eff[m] = d;
      }
      disp[m][p] = eff[m];
      (periods[m][p][col.dir] as number) = eff[m];
    });
    spdByBit.set(col.bit, spd);
    dispByBit.set(col.bit, disp);
  }

  // Column reads that desynced from what the encoder wrote — codebook drift or a corrupted
  // message — mean the values above are garbage; the source's end-of-stream invariant catches
  // that here (see SymSource.assertDone in entropy.ts).
  rd.assertDone();

  return periods;
}

export const v1Codec: VersionedCodec = {
  encode: v1MessageToString,
  decode: v1MessageFromString,
};

