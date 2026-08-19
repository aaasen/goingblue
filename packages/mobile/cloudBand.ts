// Helpers for the Windy-style vertical cloud band (v3's cloud column). The message carries
// coverage at CLOUD_BAND_LEVELS_HPA (300 hPa first — see @weather/protocol); rendering wants a
// grid that is uniform in PRESSURE so resampling between the wire's levels is a straight
// interpolation, and a placement function that maps that grid onto the plot. These helpers do
// both, and convert pressure to altitude for the axis labels.

import { CLOUD_BAND_LEVELS_HPA } from '@weather/protocol';

export const BAND_TOP_HPA = CLOUD_BAND_LEVELS_HPA[0];
export const BAND_BOTTOM_HPA = CLOUD_BAND_LEVELS_HPA[CLOUD_BAND_LEVELS_HPA.length - 1];
export const GRID_STEP_HPA = 25;
export const GRID_ROWS = (BAND_BOTTOM_HPA - BAND_TOP_HPA) / GRID_STEP_HPA + 1; // 29

// Clear air above the top level, as a share of one slice. 300 hPa is the ceiling of what the
// MESSAGE carries, not the ceiling of the sky — the tropopause is nearer 36k, and cirrus lives
// up there — so the top level is read as "30k AND ABOVE" (the rail writes it "30k+") and the
// band ends hard on it. The headroom is what makes that edge legible: it lifts the boundary off
// the row border onto a gridline of its own, with the label beside it, so the flat top reads as
// the top of the SCALE rather than as cloud clipped by the section header. Nothing is padded at
// the bottom: 1000 hPa IS the ground, and cloud should reach it.
const TOP_PAD_SLICES = 0.5;
const BAND_SLICES = CLOUD_BAND_LEVELS_HPA.length - 1 + TOP_PAD_SLICES;

// Where a pressure sits on the band, 0 (top) to 1 (bottom): one equal slice per LEVEL-TO-LEVEL
// gap, not linear in pressure or in altitude. The wire's levels are unevenly spaced — 100 hPa
// apart aloft, 75 near the ground, and in feet the top gap alone is 6.5k while the bottom two
// are 2.3k and 2.1k — so a physical axis would crowd half the levels into the lowest fifth of
// the plot, which is exactly where most of the cloud is. An even ladder spends the band's height
// on what the message actually carries: every level gets the same room to show a deck in.
// Pressures between levels interpolate inside their own slice, so the mapping stays continuous
// and the resampled grid lands on it without seams.
export function hpaToFrac(hpa: number): number {
  let seg = 0;
  while (seg < CLOUD_BAND_LEVELS_HPA.length - 2 && CLOUD_BAND_LEVELS_HPA[seg + 1] < hpa) seg++;
  const p0 = CLOUD_BAND_LEVELS_HPA[seg], p1 = CLOUD_BAND_LEVELS_HPA[seg + 1];
  const t = Math.min(1, Math.max(0, (hpa - p0) / (p1 - p0)));
  return (TOP_PAD_SLICES + seg + t) / BAND_SLICES;
}

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
