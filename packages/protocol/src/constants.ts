// The protocol version emitted by encoders today. Decoders accept any version with a
// registered codec (see registry.ts); this is only the default for new messages.
export const CURRENT_VERSION = 1;

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

export const MODEL_BIT: Record<string, number> = { HRES: 0, GFS: 1, ICON: 2, IFS: 3 };
export const MODEL_NAMES: string[] = ["ECMWF IFS HRES", "GFS", "ICON", "ECMWF IFS 0.25"];

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
  cc: 8,     // total cloud cover
  cch: 9,    // high cloud cover
  ccm: 10,   // mid cloud cover
  ccl: 11,   // low cloud cover
  rain: 12,  // liquid precipitation (rain + showers), mm
  // bit 13 formerly carried tmin (min temperature), removed when temp became a single
  // representative sample per period — reserved for the next new variable.
};

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
