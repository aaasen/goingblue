export const VERSION = 1;
export const HEADER_BITS = 32;
export const PERIOD_BITS = 40;

export const ALPHABET =
  "!\"#$%&'()*+,-./0123456789:;<=>?@ABCDEFGHIJKLMNOPQRSTUVWXYZ[\\]^_`abcdefghijklmnopqrstuvwxyz{|}~";

export const LOCATIONS: string[] = ["upper", "airstrip", "current"];

export const RESOLUTION_HOURS: Record<number, number> = { 0: 24, 1: 12, 2: 6, 3: 3, 4: 1 };
export const RESOLUTION_LABEL: Record<number, string> = {
  0: "daily",
  1: "12h",
  2: "6h",
  3: "3h",
  4: "1h",
};

export const MODEL_BIT: Record<string, number> = { ECMWF: 0, GFS: 1, ICON: 2 };
export const MODEL_NAMES: string[] = ["ECMWF", "GFS", "ICON"];

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
