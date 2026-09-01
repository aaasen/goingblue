// Helpers for the Windy-style vertical cloud band (the wire's cloud column). The message carries
// coverage on an elevation-keyed RUN of CLOUD_BAND_LEVELS_HPA (highest carried level first —
// see cloudBandLevelRange in @weather/protocol): capped at 300 hPa for low country, reaching
// 250/200 only at high elevations, truncated two levels below the forecast point. A decoded
// array's LENGTH is the run's size; WHICH levels it names comes from the header's elevation
// through the same shared function, so the two sides cannot disagree. Rendering wants a grid
// that is uniform in PRESSURE so resampling between the wire's levels is a straight
// interpolation, and a placement function that maps that grid onto the plot. bandScale builds
// both; the ISA conversions (re-exported from the protocol, where they are wire format) place
// pressures at altitudes for the axis labels.

import {
  CLOUD_BAND_LEVELS_HPA, cloudBandLevelRange, pressureToMeters, metersToPressure,
} from '@weather/protocol';
import type { LevelUnit } from './settings';

export { pressureToMeters, metersToPressure };

// One rung of the altitude ladder: the standard-atmosphere height of a wire level, as a rough
// band with its unit — thousands of feet ("14k ft", "400 ft" at the ground) or half-kilometres
// ("5.5km", "0.1km" at the ground) — or, for the reader who thinks in pressure, the level itself
// ("500 hPa"). The same label for every reader of a pressure level, whether on the cloud band's
// rail, a wind row, or the builder's level list.
//
// On the cloud band the top rung is written with a "+" ("30k+", or "39k+" on a summit band
// that reaches 200 hPa): the carried top is where the band stops flat, and an unqualified
// number would make that flat top a claim about the sky — that cloud ends there — when it is
// only a statement about the wire. The "+" turns the top of the scale into what it actually
// is: everything from that level up, gathered onto one edge (fillCloudBand folds the higher
// cloud into the carried top). Pass `open` for exactly the band's carried top; a wind level is
// a point reading — 300 hPa wind is the wind AT 30k, bundling nothing above it — so wind rungs
// stay plain. In pressure the open top reads "≤300 hPa": up is DOWN in hPa, so a "+" would
// point the wrong way.
export function ladderLabel(hpa: number, unit: LevelUnit, open = false): string {
  if (unit === 'hpa') return `${open ? '≤' : ''}${hpa} hPa`;
  const m = pressureToMeters(hpa);
  const plus = open ? '+' : '';
  if (unit === 'ft') {
    const ft = m * 3.28084;
    return ft < 1000 ? `${Math.round(ft / 100) * 100} ft` : `${Math.round(ft / 1000)}k${plus} ft`;
  }
  const km = m / 1000;
  return `${km < 0.5 ? km.toFixed(1) : String(Math.round(km * 2) / 2)}km${plus}`;
}
export const GRID_STEP_HPA = 25;

// The band's geometry for one message: everything that depends on which levels the wire
// carried. Built per cloud-band row from the decoded array's length plus the header's
// elevation (which fixes WHERE in the ladder that run sits) — never from a constant, which
// would draw a sea-level ladder under a summit forecast.
export interface BandScale {
  // The carried levels, highest first — the run of CLOUD_BAND_LEVELS_HPA this message holds.
  levels: readonly number[];
  topHpa: number;
  bottomHpa: number;
  // Rows of the resampled pressure-uniform grid, GRID_STEP_HPA apart, top row at topHpa.
  gridRows: number;
  // Where a pressure sits on the band, 0 (top) to 1 (bottom): one equal slice per
  // LEVEL-TO-LEVEL gap, not linear in pressure or in altitude. The wire's levels are unevenly
  // spaced — 100 hPa apart aloft, 75 near the ground, and in feet the top gap alone is 6.5k
  // while the bottom two are 2.3k and 2.1k — so a physical axis would crowd half the levels
  // into the lowest fifth of the plot, which is exactly where most of the cloud is. An even
  // ladder spends the band's height on what the message actually carries: every level gets the
  // same room to show a deck in. Pressures between levels interpolate inside their own slice,
  // so the mapping stays continuous and the resampled grid lands on it without seams.
  hpaToFrac(hpa: number): number;
  // One period's level stack → gridRows coverage values (0..100, top row first), linear in
  // pressure between the wire's levels. `out[outOffset + r * outStride]` receives row r, so a
  // caller can write straight into a column of a row-major image buffer.
  resampleColumn(
    levels: readonly (number | undefined)[] | undefined,
    out: Uint8Array, outOffset: number, outStride: number,
  ): void;
}

// The band spans exactly the levels the message carries: the carried top on the row's top edge
// (300 hPa for low country, up to 200 on a summit band), the last carried level on its bottom,
// one slice per level-to-level gap and nothing padded outside them. The edges are both wire
// truncations, and the axis stops where the data stops at each: the top is the ceiling of what
// the MESSAGE carries, not of the sky — cirrus can still top out above it — so the rail reads
// the top level open ("30k+"); the bottom level is two below the forecast point's ground (or
// 1000 hPa, which IS the ground, from low country). `nLevels` is the decoded array's length;
// `elevationM` is the header's elevation, which fixes where in the ladder the run starts
// (cloudBandLevelRange — the same function the decoder keyed the run on).
export function bandScale(nLevels: number, elevationM: number): BandScale {
  const { start } = cloudBandLevelRange(elevationM);
  const levels = CLOUD_BAND_LEVELS_HPA.slice(
    start, start + Math.max(2, Math.min(nLevels, CLOUD_BAND_LEVELS_HPA.length - start)));
  const slices = levels.length - 1;
  const topHpa = levels[0];
  const bottomHpa = levels[levels.length - 1];
  // Every gap between adjacent CLOUD_BAND_LEVELS_HPA entries is a multiple of GRID_STEP_HPA,
  // so the division is exact for every run.
  const gridRows = (bottomHpa - topHpa) / GRID_STEP_HPA + 1;

  const segOf = (hpa: number): number => {
    let seg = 0;
    while (seg < levels.length - 2 && levels[seg + 1] < hpa) seg++;
    return seg;
  };

  return {
    levels,
    topHpa,
    bottomHpa,
    gridRows,
    hpaToFrac(hpa: number): number {
      const seg = segOf(hpa);
      const p0 = levels[seg], p1 = levels[seg + 1];
      const t = Math.min(1, Math.max(0, (hpa - p0) / (p1 - p0)));
      return (seg + t) / slices;
    },
    resampleColumn(stack, out, outOffset, outStride): void {
      for (let r = 0; r < gridRows; r++) {
        const p = topHpa + r * GRID_STEP_HPA;
        const seg = segOf(p);
        const p0 = levels[seg], p1 = levels[seg + 1];
        const t = Math.min(1, Math.max(0, (p - p0) / (p1 - p0)));
        const v = (stack?.[seg] ?? 0) * (1 - t) + (stack?.[seg + 1] ?? 0) * t;
        out[outOffset + r * outStride] = Math.round(Math.min(100, Math.max(0, v)));
      }
    },
  };
}
