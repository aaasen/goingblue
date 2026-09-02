// Geographic field widths — shared by every version's header.
export const LAT_BITS = 15;  // -90..+90 in ~611m steps
export const LON_BITS = 16;  // -180..+180 in ~611m steps at equator
export const ELEV_BITS = 14; // 0..16383m

// Restricted to characters in the GSM-7 basic alphabet, so a message can be carried over SMS
// where each character is a single septet. Excludes the printable-ASCII characters that GSM-7
// either omits (`) or relegates to the extension table, which would cost two septets each
// ([ \ ] ^ { | } ~). This is base-85; see codec.ts.
//
// It is GSM-7 basic INTERSECT printable ASCII, and only the first half of that was ever an SMS
// constraint. The ASCII half was there because one alphabet had to survive inReach too; now that
// `d:` picks the alphabet per route (see devices.ts), the SMS route spends SMS_ALPHABET instead
// and this stays the alphabet of every route that can't.
export const ALPHABET =
  "!\"#$%&'()*+,-./0123456789:;<=>?@ABCDEFGHIJKLMNOPQRSTUVWXYZ_abcdefghijklmnopqrstuvwxyz";

// The non-ASCII half of GSM-7 basic: 39 more characters, each still a single septet, so 160 of
// them still fit one SMS segment. They are split by what they survive rather than listed in GSM
// table order, because that split is the fallback (see SMS_ALPHABET).
//
// Latin-1: everything with an ISO-8859-1 equivalent. Measured intact end to end, in both
// directions, in the field, including the three
// whose GSM septet positions collide with ASCII characters this alphabet already spends
// (0x24 ¤ vs $, 0x40 ¡ vs @, 0x5F § vs _) and which a Latin-1 confusion would swap silently.
export const GSM_LATIN1 = "£¥èéùìòÇØøÅåÆæßÉ¤¡ÄÖÑÜ§¿äöñüà";

// The three of those the inReach leg turns base-85 INTO. A reply written in ALPHABET arrives in the
// Garmin Messenger app with every $ @ _ shown as ¤ ¡ § — the septets are carried intact and
// displayed by the GSM-7 table rather than ASCII (field-confirmed 2026-08-22: the swapped-back
// paste decoded in the shipped app, and nothing else in the reply was touched). So in a reply
// that never spent the GSM-7 half, the three can only mean their ASCII twins, and the decoder
// folds them back (see foldSeptetSwap). The SMS route is the one exception, because there they
// are their own characters — base-124 spends all three.
export const SEPTET_SWAP: Record<string, string> = { "¤": "$", "¡": "@", "§": "_" };

// Undoes the inReach display swap above on a string known to be base-85/ASCII — a version tag,
// a packed header, or the body of any route but SMS. Never call it on a base-124 body.
export function foldSeptetSwap(s: string): string {
  return s.replace(/[¤¡§]/g, (c) => SEPTET_SWAP[c]);
}

// Greek: the ten GSM-7 basic characters with NO ISO-8859-1 equivalent, and so the ten with
// somewhere to fall. A field test found a hop on the inbound SMS leg that transcodes through Latin-1
// and turns exactly these into C1 controls, deterministically — septet position q arriving as
// U+0070+q. That leg is one a reply never travels, and the outbound leg carried all 39 byte-exact,
// which is why they are spent. If a route ever mangles them outbound, the fallback is to drop
// this term from SMS_ALPHABET: 114 characters, 6.6% over base-85 instead of 8.5%.
export const GSM_GREEK = "ΔΦΓΛΩΠΨΣΘΞ";

// What the SMS route writes a body in: base-124, 6.954 bits a character against base-85's 6.409.
// The version tag and packed header stay base-85 on every route (see codec.ts).
export const SMS_ALPHABET = ALPHABET + GSM_LATIN1 + GSM_GREEK;

// Every printable ASCII character except space: U+0021..U+007E, 94 of them. Built from the range
// rather than transcribed, because the range IS the definition — the alphabet is "anything a route
// with no character restrictions at all can carry", and a literal could only get that wrong.
//
// Space is the one exclusion, and not for transport reasons: whitespace separates tokens in a
// request and readParts splits a paste on it, so a body may never contain one.
//
// This is the widest alphabet worth having over a byte-counted transport, which is the opposite of
// the reasoning behind SMS_ALPHABET above. HTTP meters bytes, not characters, and UTF-8 spends a
// third of every non-ASCII byte on continuation markers — so a body of 3-byte characters carries
// 5.0 bits per byte where ASCII carries 6.5. Widening past ASCII would make an HTTP reply LARGER.
// 6.555 bits a character here against base-85's 6.409, which is the whole of the available upside:
// 7 bits/byte is the ceiling for any UTF-8 text at all, and the control characters between here
// and there are not worth having.
export const HTTP_ALPHABET =
  Array.from({ length: 0x7e - 0x21 + 1 }, (_, i) => String.fromCharCode(0x21 + i)).join("");

// The refinement ladder: resolution index (0..4, coarse → fine) → hours per period.
// Fill layouts use indices 1..4; index 0 (24h) survives only as a ladder position — see layout.ts.
export const RESOLUTION_HOURS: Record<number, number> = { 0: 24, 1: 12, 2: 6, 3: 3, 4: 1 };

// The resolutions fill layouts actually emit, as RESOLUTION_HOURS indices, in CODEBOOK TABLE ROW
// ORDER: every resolution-keyed weight table carries exactly one row per entry (24h never occurs
// in a layout, so no table trains or ships a row for it), and hours → table row is this array's
// position (resTableIdx in wire.ts). The derive scripts iterate this same array, so the trained
// rows and the rows the codec reads cannot drift apart.
export const TABLE_RES_IDXS = [1, 2, 3, 4] as const;

// Model choice is expressed at the forecast-center level, not the individual model. Each center
// maps to an Open-Meteo _seamless family (or, for Europe, HRES surface + IFS 0.25° pressure
// levels) so the label stays valid when an upstream model is swapped out. Best Match is the
// default (bit 0): Open-Meteo picks the highest-resolution model available for the location.
export const MODEL_BIT: Record<string, number> = { BEST: 0, US: 1, CA: 2, EU: 3, DE: 4 };
export const MODEL_NAMES: string[] = [
  "Auto",
  "American (NOAA)",
  "Canadian (GEM)",
  "European (ECMWF)",
  "German (DWD)",
];

// ── Model agreement (VAR.agreement) ─────────────────────────────────────────────
// Pairwise agreement between the served forecast and each other center, one series per pair in
// this fixed order. WIRE FORMAT: the order indexes Period.agreement, and horizonHours is a free
// clamp (like AQ_HORIZON_HOURS in wire.ts) — periods whose start offset reaches a center's
// horizon carry no symbols for that pair, derived identically on both sides from the layout.
// The pair whose center IS the served model is never carried (agreementPairs in wire.ts); the
// default best_match serve carries all four. Horizons are hours from the FIRST PERIOD's start,
// deliberately inside each center's real reach; a ragged upstream edge inside the clamp falls
// back to the no-data symbol (AGREEMENT_NO_DATA in entropy.ts).
export const AGREEMENT_CENTERS = [
  { bit: 1, label: "US", horizonHours: 16 * 24 }, // MODEL_BIT.US — GFS seamless
  { bit: 2, label: "CA", horizonHours: 10 * 24 }, // MODEL_BIT.CA — GEM seamless
  { bit: 3, label: "EU", horizonHours: 15 * 24 }, // MODEL_BIT.EU — ECMWF IFS
  { bit: 4, label: "DE", horizonHours: 180 }, // MODEL_BIT.DE — DWD ICON seamless
] as const;

// The wire's four agreement levels (0 = strong disagreement .. 3 = strong agreement), cut from
// the continuous 0..1 score at these thresholds. WIRE FORMAT (digest-pinned): the cuts give a
// level its physical meaning, exactly like an AQI ladder — provisional quartiles of the
// 2026-09-01 live multi-model snapshot, to be re-derived as snapshots accumulate.
export const AGREEMENT_LEVELS = 4;
export const AGREEMENT_CUTS = [0.45, 0.63, 0.88] as const;
export function quantAgreement(score: number): number {
  let lv = 0;
  while (lv < AGREEMENT_CUTS.length && score >= AGREEMENT_CUTS[lv]) lv++;
  return lv;
}

// Codebook lead-time axis: agreement decays with forecast lead, so the tables are keyed by the
// period's start offset (hours from the first period's start) bucketed at these edges.
export const AGREEMENT_LEAD_EDGES = [48, 120, 240] as const;
export const AGREEMENT_LEAD_BUCKETS = AGREEMENT_LEAD_EDGES.length + 1; // 4
export function agreementLeadBucket(startHourOffset: number): number {
  let b = 0;
  while (b < AGREEMENT_LEAD_EDGES.length && startHourOffset >= AGREEMENT_LEAD_EDGES[b]) b++;
  return b;
}

// The cloud band's pressure levels, highest first — the order Period.cloud_band and the wire.ts
// cloud-band column both use. These are the ten levels every center's pressure product can
// serve or bracket (ECMWF lacks 600/400; the server interpolates them in). 750/800 hPa are
// deliberately absent for now: best_match zero-fills 750 where the serving model doesn't carry
// it, which reads as clear sky, and neither is in the training corpus. 250/200 hPa have real
// cloud, humidity and height at all four center selections (verified 2026-08-31); their
// codebooks alias the 300 hPa rows (CLOUD_BAND_TRAINED_LEVEL_OFFSET in entropy.ts) because the
// training corpus stops at 300.
export const CLOUD_BAND_LEVELS_HPA = [200, 250, 300, 400, 500, 600, 700, 850, 925, 1000] as const;
// Pressure-level wind uses the [300..925] run of the same ladder, one selectable column per
// level (WIND_LEVEL_VARS), highest first — Period.wind_aloft is indexed by it. 1000 hPa is
// ~110 m: the always-on 10 m wind already describes that air, and above ~110 m the level is
// under the terrain, so it never earned a column (dropped 2026-08-22). 250/200 hPa are
// cloud-band-only: the band carries an elevation-keyed run of the ladder (cloudBandLevelRange
// in wire.ts), but each wind level is its own column and the cirrus levels never earned one.
// Every center's pressure
// product serves wind at all seven (verified 2026-08-22 against best_match, gfs_seamless,
// gem_seamless and ecmwf_ifs025), so no level is gated per center.
export const WIND_LEVELS_HPA = CLOUD_BAND_LEVELS_HPA.slice(2, 9) as readonly number[];

// International Standard Atmosphere, troposphere leg — the fixed scale that places the band's
// pressure levels at altitudes. Good to a few tens of meters over the band's span. WIRE FORMAT:
// cloudBandLevelRange reads the ground pressure off it, so a coefficient change moves
// which levels a message carries. The app uses the same pair for the band's axis labels and
// ground line, which is exactly why it lives here and not in two copies.
export function pressureToMeters(hpa: number): number {
  return 44330.77 * (1 - Math.pow(hpa / 1013.25, 0.190263));
}
export function metersToPressure(m: number): number {
  return 1013.25 * Math.pow(1 - m / 44330.77, 1 / 0.190263);
}

// Canonical wire variable names. Always spell a variable through VAR (VAR.w500, never the
// literal "w500"): the constant is the single spelling of each name, so a typo is a compile
// error instead of a silently empty selection. A message's selection travels as a
// ReadonlySet<Variable> (see ForecastMessage.vars / RequestContext.vars in model.ts).
export const VAR = {
  precip: "precip",
  temp: "temp",   // representative temperature sample (see Period.temp_c in model.ts)
  // Dewpoint at the temp sample's hour (see Period.dewpoint_c). Rides on temp: the column is
  // carried only when temp is, and relative humidity is the reader's to derive from the pair.
  dewpoint: "dewpoint",
  snow: "snow",
  freeze: "freeze",
  rain: "rain",   // liquid precipitation (rain + showers), mm
  wind: "wind",   // surface (10m) wind
  gust: "gust",   // surface (10m) wind gusts, speed only
  // Pressure-level wind, one variable per WIND_LEVELS_HPA entry (see WIND_LEVEL_VARS). Selected
  // per level by the `w:` request token, never on by default.
  w300: "w300",
  w400: "w400",
  w500: "w500",
  w600: "w600",
  w700: "w700",
  w850: "w850",
  w925: "w925",
  // The whole pressure-level cloud band (CLOUD_BAND_LEVELS_HPA) rides this one variable.
  clouds: "clouds",
  // Model agreement: per period, how the served forecast agrees with each other center
  // (AGREEMENT_CENTERS below) — one 2-bit level per pair, computed server-side from the
  // centers' own forecasts (see codec-server/src/agreement.ts). Rides this one variable.
  agreement: "agreement",
  // Air quality (CAMS), on two incompatible index scales — see the AQI ladders in entropy.ts.
  // Every one of these is model-independent: the `m:` center selection does not apply, and they
  // reach only ~4 days (AQ_HORIZON_HOURS in wire.ts).
  //
  // The two scales deliberately offer the SAME FIVE constituents. The US index also defines a
  // carbon monoxide sub-index and the European one does not, but CO leads the US headline in
  // 0.0% of corpus periods — it is never the pollutant a reader is being warned about — so
  // carrying it would have bought a column that says nothing and made the two scales' menus
  // differ for no reader-visible gain.
  aqi: "aqi",                 // US AQI, the headline index (max over every sub-index)
  aq_pm25: "aq_pm25",         // US AQI PM2.5 sub-index — the smoke column
  aq_o3: "aq_o3",             // US AQI ozone sub-index
  aq_pm10: "aq_pm10",         // US AQI PM10 sub-index
  aq_no2: "aq_no2",           // US AQI nitrogen dioxide sub-index
  aq_so2: "aq_so2",           // US AQI sulphur dioxide sub-index
  aqi_eu: "aqi_eu",           // European AQI, the headline index
  aqi_eu_pm25: "aqi_eu_pm25", // European AQI PM2.5 sub-index (a 24h running mean upstream)
  aqi_eu_o3: "aqi_eu_o3",     // European AQI ozone sub-index — leads this scale 68.6% of the time
  aqi_eu_pm10: "aqi_eu_pm10", // European AQI PM10 sub-index
  aqi_eu_no2: "aqi_eu_no2",   // European AQI nitrogen dioxide sub-index
  aqi_eu_so2: "aqi_eu_so2",   // European AQI sulphur dioxide sub-index
} as const;
export type Variable = (typeof VAR)[keyof typeof VAR];

// Every variable, in canonical order: the order selections are reported in (describeRequest).
// Order carries no wire meaning; the body's column order is fixed by the tables in wire.ts.
export const VARIABLES: readonly Variable[] = Object.values(VAR);

// The pressure-level wind variable of each WIND_LEVELS_HPA level, ladder order (300 hPa first).
export const WIND_LEVEL_VARS: readonly Variable[] =
  WIND_LEVELS_HPA.map((l) => VAR[`w${l}` as keyof typeof VAR]);
// The `w:` request token: ladder indices of the selected levels, e.g. `w:234` = 500/600/700 hPa.
export function windLevelsToken(vars: ReadonlySet<Variable>): string {
  return WIND_LEVEL_VARS.map((v, i) => (vars.has(v) ? String(i) : "")).join("");
}
// The wind variable one `w:` token character names, or null for a character off the ladder.
export function windLevelVar(ch: string): Variable | null {
  const i = ch.charCodeAt(0) - 48;
  return i >= 0 && i < WIND_LEVEL_VARS.length ? WIND_LEVEL_VARS[i] : null;
}

// Core forecast variables are implicit in every request. The request's `v:` token only carries
// user-configurable additions, which keeps the satellite message body as short as possible.
export const ALWAYS_VARS: readonly Variable[] = [VAR.temp, VAR.snow, VAR.rain, VAR.wind, VAR.gust];

// Single-character request codes for the user-configurable variables; each code toggles exactly
// one protocol variable. Every air-quality index is its own toggle: the pollutants behave
// differently enough (smoke vs photochemical smog vs traffic NO2) that a reader wants them
// separately, and each costs its own share of the message budget. Pressure-level wind has no
// code here: its levels travel in the `w:` token (windLevelsToken), one ladder index per
// selected level.
export const VAR_CODES = {
  p: VAR.precip,
  c: VAR.clouds,
  f: VAR.freeze,
  h: VAR.dewpoint,      // Humidity: dewpoint on the wire, relative humidity derived on the reader
  g: VAR.agreement,     // model aGreement (pairwise, vs the other centers)
  a: VAR.aqi,           // US Air Quality Index
  s: VAR.aq_pm25,       // smoke
  o: VAR.aq_o3,         // ozone
  m: VAR.aq_pm10,       // US PM10 sub-index
  d: VAR.aq_no2,        // US nitrogen dioxide sub-index
  u: VAR.aq_so2,        // US sulphur dioxide sub-index
  e: VAR.aqi_eu,        // European AQI
  "2": VAR.aqi_eu_pm25, // European PM2.5 sub-index
  "1": VAR.aqi_eu_pm10, // European PM10 sub-index
  n: VAR.aqi_eu_no2,    // European nitrogen dioxide sub-index
  "3": VAR.aqi_eu_o3,   // European ozone sub-index
  q: VAR.aqi_eu_so2,    // European sulphur dioxide sub-index
} as const;

// The request codes above, as a character class for the compact `v:` token (`v:aso`). Derived
// rather than written out so a new code can't be added without the parser accepting it.
export const VAR_CODE_CHARS = Object.keys(VAR_CODES).join("");

// A selection's `v:` token value: the code of every selected variable. Emitted in table order;
// the server unions the codes, so order carries no meaning.
export function varGroupCodesFor(vars: ReadonlySet<Variable>): string {
  return Object.entries(VAR_CODES)
    .filter(([, variable]) => vars.has(variable))
    .map(([code]) => code)
    .join("");
}

export const WMO_BITS = 5;

export const DEFAULT_VARS: readonly Variable[] = [VAR.precip, VAR.snow, VAR.freeze];
// pressure-level wind is opt-in, level by level

// The symbol alphabet. A code's INDEX here is its wire symbol (WMO2IDX in model.ts is just this
// list inverted), so codes are APPENDED, never inserted in numeric order — inserting renumbers
// every symbol above it and silently reinterprets messages encoded under the old order.
//
// 68/69 are WMO 4677's mixed rain-and-snow codes ("rain or drizzle and snow, slight" /
// "...moderate or heavy"). Open-Meteo never emits them; the server synthesizes them when a period
// aggregates hours of both phases (see aggregateWeathercode in codec-server/src/weathercode.ts),
// which it does for ~0.8% of periods at 12h — more often than 75, 82, 86, 96 or 99. Without them
// a half-rain half-snow window resolves to pure snow 98.9% of the time.
//
// 30 symbols keeps WMO_BITS at 5: the fixed-width fallback stays the same width up to 32.
export const WMO_CODES: number[] = [
  0, 1, 2, 3, 45, 48, 51, 53, 55, 56, 57, 61, 63, 65, 66, 67, 71, 73, 75, 77,
  80, 81, 82, 85, 86, 95, 96, 99,
  68, 69,
];

export const CARDINALS: string[] = ["N", "NE", "E", "SE", "S", "SW", "W", "NW"];

export function modelsFromMask(mask: number): string[] {
  return MODEL_NAMES.filter((_, i) => mask & (1 << i));
}

export function maskFromModels(models: string[]): number {
  return models.reduce((acc, m) => {
    const bit = MODEL_BIT[m.toUpperCase()];
    return bit !== undefined ? acc | (1 << bit) : acc;
  }, 0);
}
