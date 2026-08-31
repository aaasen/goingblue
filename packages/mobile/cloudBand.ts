// Helpers for the Windy-style vertical cloud band (v4's cloud column). The message carries
// coverage on a LEADING PREFIX of CLOUD_BAND_LEVELS_HPA (300 hPa first — see @weather/protocol):
// the wire truncates the stack at one level below the forecast point (cloudBandLevelCount), so
// a decoded array's LENGTH is the band's floor. Rendering wants a grid that is uniform in
// PRESSURE so resampling between the wire's levels is a straight interpolation, and a placement
// function that maps that grid onto the plot. bandScale builds both for a given level count;
// the ISA conversions (re-exported from the protocol, where they are wire format) place
// pressures at altitudes for the axis labels.

import { CLOUD_BAND_LEVELS_HPA, pressureToMeters, metersToPressure } from '@weather/protocol';
import type { LevelUnit } from './settings';

export { pressureToMeters, metersToPressure };

export const BAND_TOP_HPA = CLOUD_BAND_LEVELS_HPA[0];

// One rung of the altitude ladder: the standard-atmosphere height of a wire level, as a rough
// band with its unit — thousands of feet ("14k ft", "400 ft" at the ground) or half-kilometres
// ("5.5km", "0.1km" at the ground) — or, for the reader who thinks in pressure, the level itself
// ("500 hPa"). The same label for every reader of a pressure level, whether on the cloud band's
// rail, a wind row, or the builder's level list.
//
// On the cloud band the top rung is written "30k+" (`open`): 300 hPa is the highest level the
// message carries, so the band stops flat there — and an unqualified "30k" would make that flat
// top a claim about the sky, that cloud ends at 30k, when it is only a statement about the wire.
// The "+" turns the top of the scale into what it actually is: everything from 30k up, gathered
// onto one edge (fillCloudBand folds the model's high cloud into that slot). A wind level is a
// point reading — 300 hPa wind is the wind AT 30k, bundling nothing above it — so wind rungs
// are plain. In pressure the open top reads "≤300 hPa": up is DOWN in hPa, so a "+" would point
// the wrong way.
export function ladderLabel(hpa: number, unit: LevelUnit, open = false): string {
  const isTop = open && hpa === BAND_TOP_HPA;
  if (unit === 'hpa') return `${isTop ? '≤' : ''}${hpa} hPa`;
  const m = pressureToMeters(hpa);
  const plus = isTop ? '+' : '';
  if (unit === 'ft') {
    const ft = m * 3.28084;
    return ft < 1000 ? `${Math.round(ft / 100) * 100} ft` : `${Math.round(ft / 1000)}k${plus} ft`;
  }
  const km = m / 1000;
  return `${km < 0.5 ? km.toFixed(1) : String(Math.round(km * 2) / 2)}km${plus}`;
}
export const GRID_STEP_HPA = 25;

// The band's geometry for one message: everything that depends on how many levels the wire
// carried. Built per cloud-band row from the decoded array's length — never from a constant,
// which would draw a sea-level ladder under a summit forecast.
export interface BandScale {
  // The carried levels, highest first — the prefix of CLOUD_BAND_LEVELS_HPA this message holds.
  levels: readonly number[];
  bottomHpa: number;
  // Rows of the resampled pressure-uniform grid, GRID_STEP_HPA apart, top row at BAND_TOP_HPA.
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

// The band spans exactly the levels the message carries: 300 hPa on the row's top edge, the
// last carried level on its bottom, one slice per level-to-level gap and nothing padded outside
// them. The edges are both wire truncations, and the axis stops where the data stops at each:
// 300 hPa is the ceiling of what the MESSAGE carries, not of the sky — the tropopause is nearer
// 36k, and cirrus lives up there — so the rail reads the top level as "30k+"; the bottom level
// is one below the forecast point's ground (or 1000 hPa, which IS the ground, from low country).
export function bandScale(nLevels: number): BandScale {
  const levels = CLOUD_BAND_LEVELS_HPA.slice(0, Math.max(2, Math.min(nLevels, CLOUD_BAND_LEVELS_HPA.length)));
  const slices = levels.length - 1;
  const bottomHpa = levels[levels.length - 1];
  // Every gap between adjacent CLOUD_BAND_LEVELS_HPA entries is a multiple of GRID_STEP_HPA,
  // so the division is exact for every prefix.
  const gridRows = (bottomHpa - BAND_TOP_HPA) / GRID_STEP_HPA + 1;

  const segOf = (hpa: number): number => {
    let seg = 0;
    while (seg < levels.length - 2 && levels[seg + 1] < hpa) seg++;
    return seg;
  };

  return {
    levels,
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
        const p = BAND_TOP_HPA + r * GRID_STEP_HPA;
        const seg = segOf(p);
        const p0 = levels[seg], p1 = levels[seg + 1];
        const t = Math.min(1, Math.max(0, (p - p0) / (p1 - p0)));
        const v = (stack?.[seg] ?? 0) * (1 - t) + (stack?.[seg + 1] ?? 0) * t;
        out[outOffset + r * outStride] = Math.round(Math.min(100, Math.max(0, v)));
      }
    },
  };
}
