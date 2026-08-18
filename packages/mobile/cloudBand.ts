// Helpers for the Windy-style vertical cloud band (v3's cloud column). The message carries
// coverage at CLOUD_BAND_LEVELS_HPA (300 hPa first — see @weather/protocol); rendering wants a
// vertically uniform grid so a bilinearly-stretched image is linear in pressure, which is close
// to how Windy spaces its altitude axis. These helpers resample one period's stack onto that
// grid and convert between pressure and altitude for the axis lines.

import { CLOUD_BAND_LEVELS_HPA } from '@weather/protocol';

export const BAND_TOP_HPA = CLOUD_BAND_LEVELS_HPA[0];
export const BAND_BOTTOM_HPA = CLOUD_BAND_LEVELS_HPA[CLOUD_BAND_LEVELS_HPA.length - 1];
const GRID_STEP_HPA = 25;
export const GRID_ROWS = (BAND_BOTTOM_HPA - BAND_TOP_HPA) / GRID_STEP_HPA + 1; // 29

// International Standard Atmosphere, troposphere leg. Good to a few tens of meters at the
// altitudes the band draws — placement only, nothing is computed from it.
export function pressureToMeters(hpa: number): number {
  return 44330.77 * (1 - Math.pow(hpa / 1013.25, 0.190263));
}
export function metersToPressure(m: number): number {
  return 1013.25 * Math.pow(1 - m / 44330.77, 1 / 0.190263);
}

// One period's level stack → GRID_ROWS coverage values (0..100, top row first), linear in
// pressure between the wire's levels. `out[outOffset + r * outStride]` receives row r, so a
// caller can write straight into a column of a row-major image buffer.
export function resampleColumn(
  levels: readonly (number | undefined)[] | undefined,
  out: Uint8Array, outOffset: number, outStride: number,
): void {
  for (let r = 0; r < GRID_ROWS; r++) {
    const p = BAND_TOP_HPA + r * GRID_STEP_HPA;
    let seg = 0;
    while (seg < CLOUD_BAND_LEVELS_HPA.length - 2 && CLOUD_BAND_LEVELS_HPA[seg + 1] < p) seg++;
    const p0 = CLOUD_BAND_LEVELS_HPA[seg], p1 = CLOUD_BAND_LEVELS_HPA[seg + 1];
    const t = Math.min(1, Math.max(0, (p - p0) / (p1 - p0)));
    const v = (levels?.[seg] ?? 0) * (1 - t) + (levels?.[seg + 1] ?? 0) * t;
    out[outOffset + r * outStride] = Math.round(Math.min(100, Math.max(0, v)));
  }
}
