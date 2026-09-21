// UTM parsing for the builder's coordinates field.
//
// Gaia, CalTopo, Garmin and Google Earth all write a UTM position as a zone number, an MGRS
// latitude band letter, and an easting and northing in meters:
//
//   utm   := [UTM] [Zone] Z [ ] B  coord coord
//   coord := [E|N] number [m] [E|N]
//
// so `10S 559741 4282182`, `10 S 0559741 4282182`, `10S 559741E 4282182N` and
// `10 S 559741.00 m E 4282182.00 m N` all read. The letter is always a band, never a hemisphere:
// `18S` is 32 to 40°N in zone 18, not "zone 18 South". The band has to agree with the latitude
// the northing works out to, which is what turns hemisphere-style text into an invalid field
// rather than a pin on the wrong side of the equator.
//
// Easting comes first unless the E/N letters say otherwise. The datum is WGS84.

import type { LatLon } from './coords';

// C to M lie south of the equator, N to X north. Each band is 8° tall except X, which runs
// 72 to 84°N. I and O are skipped.
const BANDS = 'CDEFGHJKLMNPQRSTUVWX';
// Easting and northing are rounded to the meter, so a point on a band edge can land a hair
// outside the band it was labelled with.
const BAND_SLACK_DEG = 0.01;

const A = 6378137;
const F = 1 / 298.257223563;
const K0 = 0.9996;
const FALSE_EASTING = 500000;
const FALSE_NORTHING_SOUTH = 10000000;

// Inverse transverse Mercator by the Krüger series, to third order in the third flattening.
// That is under a millimeter across the whole easting range.
export function utmToLatLon(zone: number, south: boolean, easting: number, northing: number): LatLon {
  const n = F / (2 - F);
  const n2 = n * n;
  const n3 = n2 * n;
  const radius = (A / (1 + n)) * (1 + n2 / 4 + (n2 * n2) / 64);
  const beta = [n / 2 - (2 * n2) / 3 + (37 * n3) / 96, n2 / 48 + n3 / 15, (17 * n3) / 480];
  const delta = [2 * n - (2 * n2) / 3 - 2 * n3, (7 * n2) / 3 - (8 * n3) / 5, (56 * n3) / 15];

  const xi = (northing - (south ? FALSE_NORTHING_SOUTH : 0)) / (K0 * radius);
  const eta = (easting - FALSE_EASTING) / (K0 * radius);
  let xiP = xi;
  let etaP = eta;
  for (let j = 1; j <= 3; j++) {
    xiP -= beta[j - 1] * Math.sin(2 * j * xi) * Math.cosh(2 * j * eta);
    etaP -= beta[j - 1] * Math.cos(2 * j * xi) * Math.sinh(2 * j * eta);
  }

  const chi = Math.asin(Math.sin(xiP) / Math.cosh(etaP));
  let phi = chi;
  for (let j = 1; j <= 3; j++) phi += delta[j - 1] * Math.sin(2 * j * chi);

  const centralMeridian = zone * 6 - 183;
  const lon = centralMeridian + (Math.atan2(Math.sinh(etaP), Math.cos(xiP)) * 180) / Math.PI;
  return { lat: (phi * 180) / Math.PI, lon: ((lon + 540) % 360) - 180 };
}

const ZONE = /^\s*(?:utm(?![a-z])[\s:]*)?(?:zone(?![a-z])[\s:]*)?(\d{1,2})\s*([c-hj-np-x])(?![a-z])/i;
// Every character after the zone is claimed by exactly one alternative, and the catch-all makes
// anything unrecognized (a sign, a stray word) a rejection. A meters unit only counts directly
// after a number, where it may run into the axis letter: `559741mE`.
const TOKEN = /(\d+(?:\.\d+)?)(?:\s*m(?:eters?|etres?)?(?=\s*[en]?(?![a-z])))?|(easting|northing|[en])(?![a-z])|[\s,;/|:=]+|([\s\S])/gi;

// Parse one string as a UTM position, or null if it doesn't read as exactly one.
export function parseUtm(input: string): LatLon | null {
  const head = ZONE.exec(input);
  if (head == null) return null;
  const zone = parseInt(head[1], 10);
  if (zone < 1 || zone > 60) return null;
  const band = BANDS.indexOf(head[2].toUpperCase());

  const nums: number[] = [];
  const axes: string[] = [];
  let shape = '';
  for (const m of input.slice(head[0].length).matchAll(TOKEN)) {
    if (m[1] != null) {
      nums.push(parseFloat(m[1]));
      shape += '#';
    } else if (m[2] != null) {
      axes.push(m[2][0].toUpperCase());
      shape += 'a';
    } else if (m[3] != null) {
      return null;
    }
  }

  // Two bare numbers, or two numbers that each carry an axis letter on the same side.
  if (shape === '#a#a' || shape === 'a#a#') {
    if (axes[0] === axes[1]) return null;
    if (axes[0] === 'N') nums.reverse();
  } else if (shape !== '##') {
    return null;
  }

  const [easting, northing] = nums;
  if (easting < 100000 || easting >= 900000) return null;
  if (northing < 0 || northing > FALSE_NORTHING_SOUTH) return null;

  const out = utmToLatLon(zone, band < BANDS.indexOf('N'), easting, northing);
  const bandSouth = -80 + 8 * band;
  const bandNorth = band === BANDS.length - 1 ? 84 : bandSouth + 8;
  if (out.lat < bandSouth - BAND_SLACK_DEG || out.lat > bandNorth + BAND_SLACK_DEG) return null;
  return out;
}
