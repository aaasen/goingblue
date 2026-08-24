// Coordinate parsing for the builder's custom-location field.
//
// The field's keyboard is numbers-and-punctuation, so anything beyond a plain decimal pair arrives
// by paste — from a map app's share sheet, a Wikipedia infobox, a Garmin screen, a friend's text.
// Those sources disagree on nearly everything: degree and prime glyphs, whether the hemisphere
// letter leads or trails, whether the pair is separated by a comma, a semicolon or a space, and
// (outside the anglosphere) whether the comma IS the decimal mark. One grammar covers all of it:
//
//   half := [hemi] [sign] D[°] [M['] [S["]] [hemi]
//   pair := half sep half
//
// where `sep` is a hard separator (, ; / |), or a hemisphere letter marking the end of a half, or
// — when neither is present — an even split of the numbers. Minutes and seconds may be omitted
// from the right (decimal degrees, degrees + decimal minutes, full DMS all read), and the
// hemisphere letters decide which half is latitude, so `152°23′W 57°47′N` reads correctly.
//
// The parser is strict about anything it doesn't recognise: a word that isn't a coordinate label
// or a hemisphere letter, three numbers, a minute value of 61 all return null, so the field's
// invalid state stays meaningful. It never guesses at a lon-first pair.

export interface LatLon { lat: number; lon: number }

type Unit = '' | '°' | "'" | '"';
type Hemi = 'N' | 'S' | 'E' | 'W';

type Num = { kind: 'num'; value: number; negative: boolean; unit: Unit };
type Token = Num | { kind: 'hemi'; letter: Hemi } | { kind: 'sep' };

// Glyphs that mean the same thing as the ASCII form they're mapped to. The minute and second
// sets carry the curly quotes because iOS substitutes them for anything typed as ' or ".
const MINUS = /[−‐‑‒–—]/g;      // real minus, hyphens, dashes
const DEGREE = /[º˚*]/g;                             // º (ordinal), ˚ (ring above), *
const MINUTE = /[′’‘´`]/g;                 // ′ ’ ‘ ´ `
const SECOND = /[″”“]/g;                        // ″ ” “
// Words that name the axes in labelled text ("Lat: 57.79, Lon: -152.39"). The letters themselves
// carry no information the numbers don't, so they're dropped before tokenising.
const LABEL = /\b(?:latitude|longitude|lat|long|lng|lon)\b\.?/gi;
// A bracketed note with no digits in it — "(Kodiak)", "[approx]" — is commentary, not coordinates.
const NOTE = /\([^\d()]*\)|\[[^\d[\]]*\]/g;

function count(s: string, ch: string): number {
  return s.split(ch).length - 1;
}

function normalize(s: string): string {
  return s
    .replace(MINUS, '-')
    .replace(DEGREE, '°')
    .replace(MINUTE, "'")
    .replace(SECOND, '"')
    .replace(/''/g, '"')          // two apostrophes standing in for a double prime: 35''
    .replace(LABEL, ' ')
    .replace(NOTE, ' ')
    .replace(/[()[\]]/g, ' ');
}

// Every character is claimed by exactly one alternative; the catch-all at the end is what makes
// an unrecognised character a rejection rather than something skipped over. A hemisphere letter
// must not be followed by another letter, so "NW" or a stray word never reads as a hemisphere.
const TOKEN = /([-+]?)(\d+(?:\.\d+)?|\.\d+)\s*([°'"]?)|([nsew])(?![a-z])|([,;/|])|[:=\s]+|([\s\S])/gi;

function tokenize(s: string): Token[] | null {
  const tokens: Token[] = [];
  for (const m of s.matchAll(TOKEN)) {
    if (m[2] != null) {
      tokens.push({ kind: 'num', value: parseFloat(m[2]), negative: m[1] === '-', unit: m[3] as Unit });
    } else if (m[4] != null) {
      tokens.push({ kind: 'hemi', letter: m[4].toUpperCase() as Hemi });
    } else if (m[5] != null) {
      tokens.push({ kind: 'sep' });
    } else if (m[6] != null) {
      return null;
    }
  }
  while (tokens[0]?.kind === 'sep') tokens.shift();
  while (tokens[tokens.length - 1]?.kind === 'sep') tokens.pop();
  return tokens;
}

// Cut the token list into its two halves. A hard separator decides outright. Failing that, a
// hemisphere letter does: the first one ends the first half if it isn't leading, otherwise the
// second one starts the second half if it isn't trailing. Failing that (no letters, or one
// leading and one trailing), the numbers split evenly.
function splitHalves(tokens: Token[]): [Token[], Token[]] | null {
  const seps = tokens.flatMap((t, i) => (t.kind === 'sep' ? [i] : []));
  if (seps.length > 1) return null;
  if (seps.length === 1) return [tokens.slice(0, seps[0]), tokens.slice(seps[0] + 1)];

  const hemis = tokens.flatMap((t, i) => (t.kind === 'hemi' ? [i] : []));
  if (hemis.length > 2) return null;
  if (hemis.length >= 1 && hemis[0] > 0) return [tokens.slice(0, hemis[0] + 1), tokens.slice(hemis[0] + 1)];
  if (hemis.length === 2 && hemis[1] < tokens.length - 1) return [tokens.slice(0, hemis[1]), tokens.slice(hemis[1])];

  const count = tokens.filter((t) => t.kind === 'num').length;
  if (count % 2 !== 0) return null;
  let seen = 0;
  for (let i = 0; i < tokens.length; i++) {
    if (tokens[i].kind === 'num' && ++seen === count / 2) return [tokens.slice(0, i + 1), tokens.slice(i + 1)];
  }
  return null;
}

interface Half { value: number; axis: 'lat' | 'lon' | null }

// Read one half as D[ M[ S]]. Each position's unit symbol, if written, must be the one for that
// position, and only the degrees may carry a sign or a fraction when more parts follow. A
// hemisphere letter and a minus sign together are a contradiction, not a double negative.
function parseHalf(tokens: Token[]): Half | null {
  let hemi: Hemi | null = null;
  const nums: Num[] = [];
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    if (t.kind === 'hemi') {
      if (hemi != null || (i !== 0 && i !== tokens.length - 1)) return null;
      hemi = t.letter;
    } else if (t.kind === 'num') {
      nums.push(t);
    }
  }
  if (nums.length < 1 || nums.length > 3) return null;

  const units: Unit[] = ['°', "'", '"'];
  for (let i = 0; i < nums.length; i++) {
    if (nums[i].unit !== '' && nums[i].unit !== units[i]) return null;
    if (i > 0 && nums[i].negative) return null;
    if (i > 0 && nums[i].value >= 60) return null;
    if (i < nums.length - 1 && !Number.isInteger(nums[i].value)) return null;
  }

  let value = nums[0].value + (nums[1]?.value ?? 0) / 60 + (nums[2]?.value ?? 0) / 3600;
  if (nums[0].negative) {
    if (hemi != null) return null;
    value = -value;
  }
  if (hemi === 'S' || hemi === 'W') value = -value;
  return { value, axis: hemi == null ? null : hemi === 'N' || hemi === 'S' ? 'lat' : 'lon' };
}

function parseReading(s: string): LatLon | null {
  const tokens = tokenize(s);
  if (tokens == null) return null;
  const halves = splitHalves(tokens);
  if (halves == null) return null;
  const a = parseHalf(halves[0]);
  const b = parseHalf(halves[1]);
  if (a == null || b == null) return null;
  if (a.axis != null && a.axis === b.axis) return null;
  const aIsLat = a.axis === 'lat' || (a.axis == null && b.axis !== 'lat');
  const [lat, lon] = aIsLat ? [a.value, b.value] : [b.value, a.value];
  if (Math.abs(lat) > 90 || Math.abs(lon) > 180) return null;
  return { lat, lon };
}

// Parse one string into coordinates, or null if it doesn't read as exactly one lat/lon pair.
//
// Commas are the one genuinely ambiguous character: a pair separator to most of the world, the
// decimal mark to the rest. A string with a dot in it settles the question. Without one, both
// readings are tried, and a semicolon — the pair separator people reach for precisely when the
// comma is taken — puts the decimal reading first. Only a comma between two digits can be a
// decimal mark; "57, -152" stays a pair.
export function parseLatLon(input: string): LatLon | null {
  if (count(input, '(') !== count(input, ')') || count(input, '[') !== count(input, ']')) return null;
  const s = normalize(input);
  const decimalComma = s.replace(/(\d),(?=\d)/g, '$1.');
  const readings = s.includes('.') || decimalComma === s
    ? [s]
    : s.includes(';') ? [decimalComma, s] : [s, decimalComma];
  for (const reading of readings) {
    const out = parseReading(reading);
    if (out != null) return out;
  }
  return null;
}
