// What the avalanche view says and colors, kept apart from the drawing so it can be tested.
import {
  DANGER_LEVELS, LIKELIHOODS,
  type AvalanchePiece, type DangerRating, type Elevation, type Likelihood, type ProblemType,
} from '@weather/protocol';
import type { DangerIcon } from './dangerIcons';
import type { TimeFormat } from './settings';

// The North American public danger scale's colors.
const LEVEL_FILL: Record<(typeof DANGER_LEVELS)[number], string> = {
  low: '#50b848', moderate: '#fff200', considerable: '#f7941e', high: '#ed1c24', extreme: '#231f20',
};
const LEVEL_NAME: Record<(typeof DANGER_LEVELS)[number], string> = {
  low: 'Low', moderate: 'Moderate', considerable: 'Considerable', high: 'High', extreme: 'Extreme',
};
const STATUS_NAME: Record<Exclude<DangerRating, (typeof DANGER_LEVELS)[number]>, string> = {
  noRating: 'No Rating', spring: 'Spring', earlySeason: 'Early Season', offSeason: 'Off Season', noForecast: 'No Forecast',
};

export interface DangerCell {
  fill: string;
  text: string;
  // The level's number, 1 to 5; empty for a band without a level.
  number: string;
  name: string;
  icon: DangerIcon;
  // Extreme's cell is black with the high-danger red around it.
  border?: string;
}

export function dangerCell(rating: DangerRating): DangerCell {
  const level = (DANGER_LEVELS as readonly string[]).indexOf(rating);
  if (level === -1) {
    return { fill: '#e5e5ea', text: '#636366', number: '', name: STATUS_NAME[rating as keyof typeof STATUS_NAME], icon: 'noRating' };
  }
  const key = DANGER_LEVELS[level];
  return {
    fill: LEVEL_FILL[key],
    text: key === 'high' || key === 'extreme' ? '#ffffff' : '#1c1c1e',
    number: `${level + 1}`,
    name: LEVEL_NAME[key],
    icon: key,
    ...(key === 'extreme' && { border: LEVEL_FILL.high }),
  };
}

export const PROBLEM_NAMES: Record<ProblemType, string> = {
  stormSlab: 'Storm slab', windSlab: 'Wind slab', persistentSlab: 'Persistent slab',
  deepPersistentSlab: 'Deep persistent slab', wetSlab: 'Wet slab', wetLoose: 'Wet loose',
  dryLoose: 'Dry loose', cornice: 'Cornice', glide: 'Glide',
};

// Title case in the danger tables, sentence case on the problem rose, as Avalanche Canada has them.
export const ELEVATION_NAMES: Record<Elevation, string> = { btl: 'Below Treeline', tln: 'Treeline', alp: 'Alpine' };
export const ROSE_ELEVATION_NAMES: Record<Elevation, string> = { btl: 'Below treeline', tln: 'Treeline', alp: 'Alpine' };

const LIKELIHOOD_NAMES = ['Unlikely', 'Possible', 'Likely', 'Very Likely', 'Certain'];

// A vertical scale read top to bottom: rows sit at 0, 1, 2, ... in row units, notes label a
// span of rows at its middle, and the bar covers [top, bottom] in the same units.
export interface Scale {
  rows: { label: string; bold: boolean }[];
  notes: { label: string; at: number; bold: boolean }[];
  bar: [number, number];
}

// How far the bar reaches past the centers of the rows it covers.
const BAR_REACH = 0.35;

// Certain on top. A half-step covers and bolds the two names it sits between.
export function likelihoodScale(l: Likelihood): Scale {
  const step = LIKELIHOODS.indexOf(l) / 2;
  const lo = Math.floor(step), hi = Math.ceil(step);
  const top = LIKELIHOOD_NAMES.length - 1;
  return {
    rows: LIKELIHOOD_NAMES.map((label, k) => ({ label, bold: k >= lo && k <= hi })).reverse(),
    notes: [],
    bar: [top - hi - BAR_REACH, top - lo + BAR_REACH],
  };
}

// Size 5 on top. As Avalanche Canada draws it, a half size ends the bar halfway between two rows
// but rounds up to a whole row for the bold labels, and a note is bold only when every size it
// names is covered.
export function sizeScale(size: { min: number; max: number }): Scale {
  const lo = Math.round(size.min), hi = Math.round(size.max);
  const bold = (...sizes: number[]) => sizes.every((s) => s >= lo && s <= hi);
  const row = (s: number) => 5 - s;
  // A lone half size still needs a bar to see.
  const reach = (s: number) => (Number.isInteger(s) || size.min === size.max ? BAR_REACH : 0);
  return {
    rows: [5, 4, 3, 2, 1].map((s) => ({ label: `${s}`, bold: bold(s) })),
    notes: [
      { label: 'Very Large', at: (row(3) + row(4)) / 2, bold: bold(3, 4) },
      { label: 'Large', at: row(2), bold: bold(2) },
      { label: 'Small', at: row(1), bold: bold(1) },
    ],
    bar: [row(size.max) - reach(size.max), row(size.min) + reach(size.min)],
  };
}

// Each center's bulletin disclaimer, by paragraph, as its forecast page words it. A center
// without one here shows none.
export const DISCLAIMERS: Record<string, string[]> = {
  'avalanche-canada': [
    'USE AT YOUR OWN RISK',
    'Avalanche Canada’s Public Avalanche Bulletin, and other information and services provided by Avalanche Canada, are intended for personal and recreational purposes only.',
    'THIS INFORMATION IS PROVIDED "AS IS" AND IN NO EVENT SHALL THE PROVIDERS BE LIABLE FOR ANY DAMAGES, INCLUDING, WITHOUT LIMITATION, DAMAGES RESULTING FROM DISCOMFORT, INJURY, OR DEATH, CLAIMS BY THIRD PARTIES OR FOR OTHER SIMILAR COSTS, OR ANY SPECIAL, INCIDENTAL, OR CONSEQUENTIAL DAMAGES, ARISING OUT OF THE USE OF THE INFORMATION.',
    'The user acknowledges that it is impossible to accurately predict natural events such as avalanches in every instance, and uses the data in this bulletin with this always foremost in mind. The accuracy or reliability of the data is not guaranteed or warranted in any way and the Providers disclaim liability of any kind whatsoever, including, without limitation, liability for quality, performance, merchantability and fitness for a particular purpose arising out of the use, or inability to use the data.',
  ],
};

export const CONFIDENCE_NAMES: Record<string, string> = {
  low: 'Low', moderate: 'Moderate', high: 'High', noRating: 'No Rating',
};

// The weekday of an instant in the forecast's zone.
export function dayLabel(ms: number, timezone: string): string {
  return new Intl.DateTimeFormat('en-US', { weekday: 'long', timeZone: timezone }).format(new Date(ms));
}

// The generic abbreviations of the zones bulletins come in. Intl's shortGeneric names some of
// these by city ("St. John's Time") and Hermes may lack it, so the table is explicit.
const ZONE_ABBREVIATIONS: Record<string, string> = {
  'America/Vancouver': 'PT', 'America/Edmonton': 'MT', 'America/New_York': 'ET', 'America/St_Johns': 'NT', UTC: 'UTC',
};

// "Sat, February 28, 2026 at 16:00 PT", as Avalanche Canada stamps a bulletin, in the reader's
// clock format. Hermes's Intl can follow the device's 12/24-hour setting over the options and
// leaves the hour and minute out of formatToParts, so each field is formatted alone and the clock
// is built here, the way Meteogram's clockLabel builds it.
export function stampLabel(ms: number, timezone: string, timeFormat: TimeFormat): string {
  const d = new Date(ms);
  const format = (options: Intl.DateTimeFormatOptions) =>
    new Intl.DateTimeFormat('en-US', { ...options, timeZone: timezone }).format(d);
  const date = format({ weekday: 'short', month: 'long', day: 'numeric', year: 'numeric' });
  // "16", or "4 PM" from an engine that ignores hourCycle.
  const hourText = format({ hour: 'numeric', hourCycle: 'h23' });
  const pm = /PM/i.test(hourText), am = /AM/i.test(hourText);
  const raw = parseInt(hourText, 10);
  const hour = pm || am ? (raw % 12) + (pm ? 12 : 0) : raw % 24;
  const minute = `${parseInt(format({ minute: 'numeric' }), 10)}`.padStart(2, '0');
  const clock = timeFormat === '24h'
    ? `${`${hour}`.padStart(2, '0')}:${minute}`
    : `${hour % 12 || 12}:${minute} ${hour < 12 ? 'AM' : 'PM'}`;
  const zone = ZONE_ABBREVIATIONS[timezone];
  return `${date} at ${clock}${zone ? ` ${zone}` : ''}`;
}

// The pieces as map features, one MultiPolygon each.
export function pieceFeatures(pieces: readonly AvalanchePiece[]): GeoJSON.FeatureCollection {
  return {
    type: 'FeatureCollection',
    features: pieces.map((p) => ({
      type: 'Feature',
      properties: { id: p.id },
      geometry: { type: 'MultiPolygon', coordinates: p.polygons },
    })),
  };
}
