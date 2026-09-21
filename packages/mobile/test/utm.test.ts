import { describe, it, expect } from 'vitest';
import { parseLatLon, formatLatLon, formatCoords } from '../coords';
import { formatUtm, latLonToUtm, parseUtm } from '../utm';

function near(actual: { lat: number; lon: number } | null, expected: { lat: number; lon: number }) {
  expect(actual).not.toBeNull();
  expect(actual!.lat).toBeCloseTo(expected.lat, 7);
  expect(actual!.lon).toBeCloseTo(expected.lon, 7);
}

// Mount Whitney, 11S 384409 4048903
const WHITNEY = { lat: 36.57859564, lon: -118.29199753 };

describe('conversion', () => {
  // Expected values from PROJ (pyproj 3.7.2, EPSG:326xx / 327xx to EPSG:4326).
  const REFERENCE: [string, string, number, number][] = [
    ['Mount Whitney', '11S 384409 4048903', 36.57859564, -118.29199753],
    ['Denali', '5V 600700 6994861', 63.06919993, -151.00699078],
    ['Cerro Torre', '18F 638274 4538243', -49.29290239, -73.09829889],
    ['Jiehkkevarri', '34W 455775 7707179', 69.46999884, 19.86999611],
    ['Mont Blanc', '32T 334201 5077665', 45.83260374, 6.86520282],
    ['Everest', '45R 492625 3095886', 27.98809627, 86.92500001],
    ['Cotopaxi', '17M 785251 9924343', -0.68380311, -78.43720044],
    ['Mount Cameroon', '32N 518866 464568', 4.20299825, 9.16999787],
    ['Vinson', '16C 530708 1282631', -78.52540191, -85.6171203],
  ];
  for (const [name, text, lat, lon] of REFERENCE) {
    it(`converts ${name}`, () => near(parseUtm(text), { lat, lon }));
  }

  it('matches the published position of the CN Tower', () => {
    const out = parseUtm('17T 630084 4833438');
    expect(out!.lat).toBeCloseTo(43.6426, 4);
    expect(out!.lon).toBeCloseTo(-79.3871, 4);
  });

  it('reads the widened Norway zone and the Svalbard zones as written', () => {
    near(parseUtm('32V 297230 6700510'), { lat: 60.38999832, lon: 5.31999619 });
    near(parseUtm('33X 514814 8683004'), { lat: 78.21999858, lon: 15.65002067 });
  });

  it('reads fractional meters', () => {
    near(parseUtm('11S 384409.25 4048901.75'), { lat: 36.5785844, lon: -118.29199455 });
  });
});

describe('formats', () => {
  it('reads the zone and band joined, spaced, and in lower case', () => {
    near(parseUtm('11S 384409 4048903'), WHITNEY);
    near(parseUtm('11 S 384409 4048903'), WHITNEY);
    near(parseUtm('11s 384409 4048903'), WHITNEY);
    near(parseUtm('  11S 384409 4048903 '), WHITNEY);
  });

  it('reads the Garmin zero-padded easting', () => {
    near(parseUtm('11 S 0384409 4048903'), WHITNEY);
  });

  it('reads axis letters after the numbers', () => {
    near(parseUtm('11S 384409E 4048903N'), WHITNEY);
    near(parseUtm('11S 384409 E 4048903 N'), WHITNEY);
    near(parseUtm('11S 384409mE 4048903mN'), WHITNEY);
  });

  it('reads the Google Earth format', () => {
    near(parseUtm('11 S 384409.00 m E 4048903.00 m N'), WHITNEY);
  });

  it('reads axis letters and labels before the numbers', () => {
    near(parseUtm('11S E 384409 N 4048903'), WHITNEY);
    near(parseUtm('11S E384409 N4048903'), WHITNEY);
    near(parseUtm('11S Easting: 384409 Northing: 4048903'), WHITNEY);
  });

  it('uses the axis letters to order the pair', () => {
    near(parseUtm('11S 4048903N 384409E'), WHITNEY);
    near(parseUtm('11S Northing 4048903, Easting 384409'), WHITNEY);
  });

  it('drops the UTM and Zone labels, separators, and a meters unit', () => {
    near(parseUtm('UTM 11S 384409 4048903'), WHITNEY);
    near(parseUtm('UTM Zone 11S, 384409, 4048903'), WHITNEY);
    near(parseUtm('Zone: 11S 384409/4048903'), WHITNEY);
    near(parseUtm('11S 384409 m 4048903 m'), WHITNEY);
    near(parseUtm('11S 384409 meters 4048903 meters'), WHITNEY);
  });
});

describe('band letter', () => {
  it('reads S as the band, never as the southern hemisphere', () => {
    expect(parseUtm('11S 384409 4048903')!.lat).toBeGreaterThan(0);
  });

  it('rejects hemisphere-style letters whose band the northing contradicts', () => {
    // Zone 18 South at 36°S, and zone 11 North at 36.6°N, as GIS software writes them.
    expect(parseUtm('18S 640000 6000000')).toBeNull();
    expect(parseUtm('11N 384409 4048903')).toBeNull();
  });

  it('rejects a band that is not the one the northing falls in', () => {
    expect(parseUtm('11T 384409 4048903')).toBeNull();
    expect(parseUtm('11R 384409 4048903')).toBeNull();
    expect(parseUtm('18G 638274 4538243')).toBeNull();
  });

  it('allows for meter rounding at a band edge', () => {
    // 40°N on the central meridian of zone 10 is northing 4427757: the S/T edge.
    expect(parseUtm('10S 500000 4427757')).not.toBeNull();
    expect(parseUtm('10T 500000 4427757')).not.toBeNull();
    expect(parseUtm('10S 500000 4428312')).not.toBeNull();   // 40.005°N
    expect(parseUtm('10S 500000 4429977')).toBeNull();       // 40.02°N
  });

  it('runs band X to 84°N', () => {
    expect(parseUtm('10X 500000 9328000')).not.toBeNull();
    expect(parseUtm('10X 500000 9400000')).toBeNull();
  });

  it('rejects I and O, which are not bands', () => {
    expect(parseUtm('11I 384409 4048903')).toBeNull();
    expect(parseUtm('11O 384409 4048903')).toBeNull();
  });
});

describe('validation', () => {
  it('rejects a missing band letter or zone', () => {
    expect(parseUtm('11 384409 4048903')).toBeNull();
    expect(parseUtm('S 384409 4048903')).toBeNull();
    expect(parseUtm('384409 4048903')).toBeNull();
  });

  it('rejects a zone outside 1 to 60', () => {
    expect(parseUtm('0S 384409 4048903')).toBeNull();
    expect(parseUtm('61S 384409 4048903')).toBeNull();
    expect(parseUtm('011S 384409 4048903')).toBeNull();
  });

  it('rejects an easting or northing out of range', () => {
    expect(parseUtm('11S 99999 4048903')).toBeNull();
    expect(parseUtm('11S 900000 4048903')).toBeNull();
    expect(parseUtm('11M 384409 10000001')).toBeNull();
  });

  it('never guesses at a northing-first pair', () => {
    expect(parseUtm('11S 4048903 384409')).toBeNull();
  });

  it('rejects the wrong number of numbers', () => {
    expect(parseUtm('11S')).toBeNull();
    expect(parseUtm('11S 384409')).toBeNull();
    expect(parseUtm('11S 384409 4048903 4421')).toBeNull();
  });

  it('rejects one axis letter, a repeated one, or letters on opposite sides', () => {
    expect(parseUtm('11S 384409E 4048903')).toBeNull();
    expect(parseUtm('11S 384409E 4048903E')).toBeNull();
    expect(parseUtm('11S E 384409 4048903 N')).toBeNull();
  });

  it('rejects a sign, a decimal comma, and any other word', () => {
    expect(parseUtm('11S -384409 4048903')).toBeNull();
    expect(parseUtm('11S 384409,5 4048903,5')).toBeNull();
    expect(parseUtm('11S 384409 4048903 Whitney')).toBeNull();
    expect(parseUtm('11S 384409 miles 4048903')).toBeNull();
    expect(parseUtm('11S EG 84409 48903')).toBeNull();
  });
});

describe('through the coordinates field', () => {
  it('reads UTM from parseLatLon', () => {
    near(parseLatLon('11S 384409 4048903'), WHITNEY);
    expect(formatLatLon(parseLatLon('11S 384409 4048903')!)).toBe('36.57860, -118.29200');
  });

  it('rejects malformed UTM outright', () => {
    expect(parseLatLon('11N 384409 4048903')).toBeNull();
    expect(parseLatLon('11S 384409')).toBeNull();
  });

  it('still reads a latitude that opens like a zone and band', () => {
    near(parseLatLon('10 S 20 E'), { lat: -10, lon: 20 });
    near(parseLatLon('10S 20E'), { lat: -10, lon: 20 });
    near(parseLatLon('57 N 152 W'), { lat: 57, lon: -152 });
    near(parseLatLon('45N 120W'), { lat: 45, lon: -120 });
    near(parseLatLon('57 47 35 N 152 23 39 W'), { lat: 57 + 47 / 60 + 35 / 3600, lon: -(152 + 23 / 60 + 39 / 3600) });
  });
});

describe('writing', () => {
  // The same PROJ reference points as the conversion, read the other way.
  const REFERENCE: [string, string, number, number][] = [
    ['Mount Whitney', '11S 384409 4048903', 36.57859564, -118.29199753],
    ['Denali', '5V 600700 6994861', 63.06919993, -151.00699078],
    ['Cerro Torre', '18F 638274 4538243', -49.29290239, -73.09829889],
    ['Jiehkkevarri', '34W 455775 7707179', 69.46999884, 19.86999611],
    ['Mont Blanc', '32T 334201 5077665', 45.83260374, 6.86520282],
    ['Everest', '45R 492625 3095886', 27.98809627, 86.92500001],
    ['Cotopaxi', '17M 785251 9924343', -0.68380311, -78.43720044],
    ['Mount Cameroon', '32N 518866 464568', 4.20299825, 9.16999787],
    ['Vinson', '16C 530708 1282631', -78.52540191, -85.6171203],
  ];
  for (const [name, text, lat, lon] of REFERENCE) {
    it(`writes ${name}`, () => expect(formatUtm({ lat, lon })).toBe(text));
  }

  it('agrees with the inverse to well under a millimeter', () => {
    const utm = latLonToUtm(WHITNEY)!;
    expect(utm.easting).toBeCloseTo(384409, 2);
    expect(utm.northing).toBeCloseTo(4048903, 2);
  });

  it('writes the widened Norway zone and the Svalbard zones', () => {
    expect(formatUtm({ lat: 60.38999832, lon: 5.31999619 })).toBe('32V 297230 6700510');
    expect(formatUtm({ lat: 78.21999858, lon: 15.65002067 })).toBe('33X 514814 8683004');
    expect(formatUtm({ lat: 78, lon: 8.9 })!.startsWith('31X')).toBe(true);
    expect(formatUtm({ lat: 78, lon: 21 })!.startsWith('35X')).toBe(true);
    expect(formatUtm({ lat: 78, lon: 41.9 })!.startsWith('37X')).toBe(true);
    expect(formatUtm({ lat: 78, lon: 42 })!.startsWith('38X')).toBe(true);
    // Below band V and X the columns are the plain 6° ones.
    expect(formatUtm({ lat: 55.9, lon: 5 })!.startsWith('31U')).toBe(true);
    expect(formatUtm({ lat: 71.9, lon: 8 })!.startsWith('32W')).toBe(true);
  });

  it('rounds to the step asked for', () => {
    expect(formatUtm(WHITNEY, 100)).toBe('11S 384400 4048900');
  });

  it('writes the antimeridian and a longitude past 180', () => {
    expect(formatUtm({ lat: 0, lon: 180 })!.startsWith('1N')).toBe(true);
    expect(formatUtm({ lat: 0, lon: -180 })!.startsWith('1N')).toBe(true);
    expect(formatUtm({ lat: 0, lon: 179.99 })!.startsWith('60N')).toBe(true);
  });

  it('has nothing to write past 80°S or 84°N', () => {
    expect(formatUtm({ lat: 84.01, lon: 0 })).toBeNull();
    expect(formatUtm({ lat: -80.01, lon: 0 })).toBeNull();
    expect(formatUtm({ lat: NaN, lon: 0 })).toBeNull();
    expect(formatUtm({ lat: 84, lon: 0 })).not.toBeNull();
    expect(formatCoords({ lat: 86, lon: 10 }, 'utm')).toBe('86.00000, 10.00000');
  });

  it('follows the chosen format', () => {
    expect(formatCoords(WHITNEY, 'utm')).toBe('11S 384409 4048903');
    expect(formatCoords(WHITNEY, 'latlon')).toBe('36.57860, -118.29200');
  });

  // Everything written has to read back, at both rounding steps, across every zone and band and
  // on the band edges, where rounding can carry the northing over the line.
  it('reads back whatever it writes', () => {
    let seed = 12345;
    const random = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
    const points: { lat: number; lon: number }[] = [];
    for (let i = 0; i < 5000; i++) points.push({ lat: -80 + 164 * random(), lon: -180 + 360 * random() });
    for (let lat = -80; lat <= 84; lat += 8) {
      for (let lon = -180; lon < 180; lon += 1.5) points.push({ lat, lon }, { lat: lat + 1e-6, lon }, { lat: lat - 1e-6, lon });
    }
    for (const p of points) {
      if (p.lat < -80 || p.lat > 84) continue;
      for (const step of [1, 100]) {
        const text = formatUtm(p, step)!;
        const back = parseUtm(text);
        expect(back, `${text} from ${p.lat}, ${p.lon}`).not.toBeNull();
        // Rounding can carry a point across the antimeridian.
        const dLon = ((back!.lon - p.lon + 540) % 360) - 180;
        const meters = Math.hypot((back!.lat - p.lat) * 111320, dLon * 111320 * Math.cos((p.lat * Math.PI) / 180));
        expect(meters, text).toBeLessThan(step);
      }
    }
  });
});
