// Geographic field widths — shared by every version's header.
export const LAT_BITS = 15;  // -90..+90 in ~611m steps
export const LON_BITS = 16;  // -180..+180 in ~611m steps at equator
export const ELEV_BITS = 14; // 0..16383m

// Restricted to characters in the GSM-7 basic alphabet, so a message can be carried over SMS
// where each character is a single septet. Excludes the printable-ASCII characters that GSM-7
// either omits (`) or relegates to the extension table, which would cost two septets each
// ([ \ ] ^ { | } ~). This is base-85; see codec.ts.
export const ALPHABET =
  "!\"#$%&'()*+,-./0123456789:;<=>?@ABCDEFGHIJKLMNOPQRSTUVWXYZ_abcdefghijklmnopqrstuvwxyz";

// The refinement ladder: resolution index (0..4, coarse → fine) → hours per period.
// Fill layouts use indices 1..4; index 0 is retained for resolution-keyed codebooks — see layout.ts.
export const RESOLUTION_HOURS: Record<number, number> = { 0: 24, 1: 12, 2: 6, 3: 3, 4: 1 };

// Model choice is expressed at the forecast-center level, not the individual model. Each center
// maps to an Open-Meteo _seamless family (or, for Europe, HRES surface + IFS 0.25° pressure
// levels) so the label stays valid when an upstream model is swapped out. Best Match is the
// default (bit 0): Open-Meteo picks the highest-resolution model available for the location.
export const MODEL_BIT: Record<string, number> = { BEST: 0, US: 1, CA: 2, EU: 3 };
export const MODEL_NAMES: string[] = [
  "Auto",
  "American (NOAA)",
  "Canadian (GEM)",
  "European (ECMWF)",
];

// vars_mask bit indices
export const VARS_BIT: Record<string, number> = {
  precip: 0,
  temp: 1,   // representative temperature sample (see Period.temp_c in model.ts)
  snow: 2,
  freeze: 3,
  wind: 4,   // surface (10m) wind
  w500: 5,
  w600: 6,
  w700: 7,
  gust: 8,   // surface (10m) wind gusts, speed only (bit formerly carried cc, total cloud cover)
  cch: 9,    // high cloud cover
  ccm: 10,   // mid cloud cover
  ccl: 11,   // low cloud cover
  rain: 12,  // liquid precipitation (rain + showers), mm
  // Air quality (CAMS), on two incompatible index scales — see the AQI ladders in entropy.ts.
  // Every one of these is model-independent: the `m:` center selection does not apply, and they
  // reach only ~4 days (AQ_HORIZON_HOURS in v2.ts). Bit 13 is the slot tmin left when temp
  // became a single representative sample per period.
  aq_pm25: 13,     // US AQI PM2.5 sub-index — the smoke column
  aq_o3: 14,       // US AQI ozone sub-index
  aqi: 15,         // US AQI, the headline index (max over every sub-index)
  aqi_eu: 16,      // European AQI, the headline index
  aqi_eu_pm25: 17, // European AQI PM2.5 sub-index (a 24h running mean upstream, so it's smooth)
  // The remaining constituents, added once the 2026-08-15 CAMS pull carried them. Bits 18..21
  // and their codes were held open for the European four while only european_aqi and
  // european_aqi_pm2_5 existed in the corpus; the US three follow at 22..24.
  //
  // The two scales deliberately offer the SAME FIVE constituents. The US index also defines a
  // carbon monoxide sub-index and the European one does not, but CO leads the US headline in
  // 0.0% of corpus periods — it is never the pollutant a reader is being warned about — so
  // carrying it would have bought a column that says nothing and made the two scales' menus
  // differ for no reader-visible gain. Bit 25 is free if that judgement ever changes.
  aqi_eu_pm10: 18, // European AQI PM10 sub-index
  aqi_eu_no2: 19,  // European AQI nitrogen dioxide sub-index
  aqi_eu_o3: 20,   // European AQI ozone sub-index — leads this scale 68.6% of the time
  aqi_eu_so2: 21,  // European AQI sulphur dioxide sub-index
  aq_pm10: 22,     // US AQI PM10 sub-index
  aq_no2: 23,      // US AQI nitrogen dioxide sub-index
  aq_so2: 24,      // US AQI sulphur dioxide sub-index
};

// Core forecast variables are implicit in every request. The request's `v:` token only carries
// user-configurable additions, which keeps the satellite message body as short as possible.
export const ALWAYS_VARS = ["temp", "snow", "rain", "wind", "gust"] as const;
export const ALWAYS_VARS_MASK = ALWAYS_VARS.reduce(
  (mask, variable) => mask | (1 << VARS_BIT[variable]),
  0,
);

// Single-character request codes for the user-configurable variable groups. A group is however
// many protocol variables one toggle turns on together: the cloud and upper-wind toggles cover
// three each, while every air-quality index is its own toggle — the pollutants behave differently
// enough (smoke vs photochemical smog vs traffic NO2) that a reader wants them separately, and
// each costs its own share of the message budget.
export const CONFIGURABLE_VAR_GROUPS = {
  p: ["precip"],
  c: ["cch", "ccm", "ccl"],
  w: ["w500", "w600", "w700"],
  f: ["freeze"],
  a: ["aqi"],           // US Air Quality Index
  s: ["aq_pm25"],       // smoke
  o: ["aq_o3"],         // ozone
  m: ["aq_pm10"],       // US PM10 sub-index
  d: ["aq_no2"],        // US nitrogen dioxide sub-index
  u: ["aq_so2"],        // US sulphur dioxide sub-index
  e: ["aqi_eu"],        // European AQI
  "2": ["aqi_eu_pm25"], // European PM2.5 sub-index
  "1": ["aqi_eu_pm10"], // European PM10 sub-index
  n: ["aqi_eu_no2"],    // European nitrogen dioxide sub-index
  "3": ["aqi_eu_o3"],   // European ozone sub-index
  q: ["aqi_eu_so2"],    // European sulphur dioxide sub-index
} as const;

// The request codes above, as a character class for the compact `v:` token (`v:aso`). Derived
// rather than written out so a new group can't be added without the parser accepting it.
export const VAR_GROUP_CODES = Object.keys(CONFIGURABLE_VAR_GROUPS).join("");

export const WMO_BITS = 5;

export const DEFAULT_VARS_MASK =
  (1 << 0) | (1 << 2) | (1 << 3) | (1 << 5) | (1 << 6) | (1 << 7);
// precip + snow + freeze + w500 + w600 + w700

export const WMO_CODES: number[] = [
  0, 1, 2, 3, 45, 48, 51, 53, 55, 56, 57, 61, 63, 65, 66, 67, 71, 73, 75, 77,
  80, 81, 82, 85, 86, 95, 96, 99,
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
