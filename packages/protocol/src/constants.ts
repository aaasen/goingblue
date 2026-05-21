export const VERSION = 1;
// Header layout (94 bits): version:7 location:3 days:4 resolution:3 models_mask:4 vars_mask:14 month:4 day:5 hour:5 lat:15 lon:16 elev:14
export const HEADER_BITS = 94; // +1: vars_mask expanded from 13 to 14 bits
export const HEADER_CHARS = Math.ceil((HEADER_BITS * Math.log(2)) / Math.log(94)); // = 15
export const LAT_BITS = 15;  // -90..+90 in ~611m steps
export const LON_BITS = 16;  // -180..+180 in ~611m steps at equator
export const ELEV_BITS = 14; // 0..16383m

export const ALPHABET =
  "!\"#$%&'()*+,-./0123456789:;<=>?@ABCDEFGHIJKLMNOPQRSTUVWXYZ[\\]^_`abcdefghijklmnopqrstuvwxyz{|}~";

export const LOCATIONS: string[] = ["current", "11k", "14k", "17k", "summit", "airstrip"];

export const RESOLUTION_HOURS: Record<number, number> = { 0: 24, 1: 12, 2: 6, 3: 3, 4: 1 };
export const RESOLUTION_LABEL: Record<number, string> = {
  0: "daily",
  1: "12h",
  2: "6h",
  3: "3h",
  4: "1h",
};

export const MODEL_BIT: Record<string, number> = { HRES: 0, GFS: 1, ICON: 2, IFS: 3 };
export const MODEL_NAMES: string[] = ["ECMWF IFS HRES", "GFS", "ICON", "ECMWF IFS 0.25"];

// vars_mask bit indices
export const VARS_BIT: Record<string, number> = {
  precip: 0,
  temp: 1,   // max temperature
  snow: 2,
  freeze: 3,
  wind: 4,   // surface (10m) wind
  w500: 5,
  w600: 6,
  w700: 7,
  cc: 8,     // total cloud cover
  cch: 9,    // high cloud cover
  ccm: 10,   // mid cloud cover
  ccl: 11,   // low cloud cover
  vis: 12,   // visibility
  tmin: 13,  // min temperature
};

// Bits consumed per variable (parallel to VARS_BIT order)
// WMO always uses 5 bits; these are for optional vars bits 0-11
export const VAR_BITS = [3, 8, 4, 4, 7, 7, 7, 7, 3, 3, 3, 3, 4, 8];
//                       ^p ^t ^s ^f ^w ^5 ^6 ^7 ^cc ^cch ^ccm ^ccl ^vis ^tmin

export const WMO_BITS = 5;

export const DEFAULT_VARS_MASK =
  (1 << 0) | (1 << 2) | (1 << 3) | (1 << 5) | (1 << 6) | (1 << 7);
// precip + snow + freeze + w500 + w600 + w700

export function periodBitsForMask(varsMask: number): number {
  let bits = WMO_BITS;
  for (let i = 0; i < VAR_BITS.length; i++) {
    if (varsMask & (1 << i)) bits += VAR_BITS[i];
  }
  return bits;
}

export function nCharsForBits(nBits: number): number {
  if (nBits === 0) return 0;
  return Math.ceil((nBits * Math.log(2)) / Math.log(94));
}

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
