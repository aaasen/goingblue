// The avalanche forecast as the app shows it and the wire will carry it: the fields of an
// Avalanche Canada bulletin, with every scale as an ordered list so the UI and the codec share
// one ordinal. Prose fields are plain text with paragraph breaks. Photos are left out.

// Array order is the ordinal: low to extreme.
export const DANGER_LEVELS = ['low', 'moderate', 'considerable', 'high', 'extreme'] as const;
export type DangerLevel = (typeof DANGER_LEVELS)[number];
// A band with no level: the center gave none, or the season did.
export type DangerStatus = 'noRating' | 'spring' | 'earlySeason' | 'offSeason' | 'noForecast';
export type DangerRating = DangerLevel | DangerStatus;

// Low to high.
export const ELEVATIONS = ['btl', 'tln', 'alp'] as const;
export type Elevation = (typeof ELEVATIONS)[number];

// Clockwise from north.
export const ASPECTS = ['n', 'ne', 'e', 'se', 's', 'sw', 'w', 'nw'] as const;
export type Aspect = (typeof ASPECTS)[number];

// Nine steps: the five names and the half-step between each neighboring pair.
export const LIKELIHOODS = [
  'unlikely', 'unlikely-possible', 'possible', 'possible-likely', 'likely',
  'likely-veryLikely', 'veryLikely', 'veryLikely-certain', 'certain',
] as const;
export type Likelihood = (typeof LIKELIHOODS)[number];

export const PROBLEM_TYPES = [
  'stormSlab', 'windSlab', 'persistentSlab', 'deepPersistentSlab',
  'wetSlab', 'wetLoose', 'dryLoose', 'cornice', 'glide',
] as const;
export type ProblemType = (typeof PROBLEM_TYPES)[number];

export const CONFIDENCES = ['low', 'moderate', 'high'] as const;
export type Confidence = (typeof CONFIDENCES)[number];

export interface DangerDay {
  // ms epoch of the day's start in the forecast's time zone.
  date: number;
  btl: DangerRating;
  tln: DangerRating;
  alp: DangerRating;
}

export interface AvalancheProblem {
  type: ProblemType;
  elevations: Elevation[];
  aspects: Aspect[];
  likelihood: Likelihood;
  // Destructive size, D1 to D5 in half steps; min equals max for a single size.
  size: { min: number; max: number };
  description: string;
}

export interface WeatherPeriod {
  // "Saturday Night", "Sunday".
  label: string;
  text: string;
}

export interface AvalancheForecast {
  // 'avalanche-canada', 'parks-glacier', ...
  center: string;
  // Who prepared the bulletin, as the center credits it: "Avalanche Canada", "Parks Canada".
  issuedBy: string;
  region: string;
  // ms epoch.
  issued: number;
  expires: number;
  // IANA zone, for the day labels.
  timezone: string;
  bottomLine: string;
  danger: DangerDay[];
  advice: string[];
  problems: AvalancheProblem[];
  avalancheSummary: string;
  snowpackSummary: string;
  weather: WeatherPeriod[];
  confidence: { rating: Confidence | 'noRating'; statements: string[] };
}

// Subregion names that contain the "-" forecast area titles join names with.
const HYPHENATED = ['Chic-Chocs'];

// The subregions a forecast area's title names, in title order: "Bow Valley-Highwood
// Pass-North 40-Spray - KLakes" joins names on a bare "-", and a spaced " - " is part of a name.
export function subregionNames(title: string): string[] {
  let t = title;
  HYPHENATED.forEach((name, i) => { t = t.replaceAll(name, `\u0000${i}\u0000`); });
  return t.split(/(?<=\S)-(?=\S)/)
    .map((s) => s.replace(/\u0000(\d+)\u0000/g, (_, i: string) => HYPHENATED[Number(i)]).trim())
    .filter(Boolean);
}
