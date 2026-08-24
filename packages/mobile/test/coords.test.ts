import { describe, it, expect } from 'vitest';
import { parseLatLon } from '../coords';

// Kodiak: 57°47′35″N 152°23′39″W = 57.79306, -152.39417
const KODIAK = { lat: 57 + 47 / 60 + 35 / 3600, lon: -(152 + 23 / 60 + 39 / 3600) };

function near(actual: { lat: number; lon: number } | null, expected: { lat: number; lon: number }) {
  expect(actual).not.toBeNull();
  expect(actual!.lat).toBeCloseTo(expected.lat, 6);
  expect(actual!.lon).toBeCloseTo(expected.lon, 6);
}

describe('decimal degrees', () => {
  it('reads the forms the field already accepted', () => {
    near(parseLatLon('57.79306, -152.39417'), { lat: 57.79306, lon: -152.39417 });
    near(parseLatLon('57.79306 -152.39417'), { lat: 57.79306, lon: -152.39417 });
    near(parseLatLon('  (-44.9412396, -99.8386085) '), { lat: -44.9412396, lon: -99.8386085 });
    near(parseLatLon('57,152'), { lat: 57, lon: 152 });
  });

  it('reads semicolon, slash and pipe separators', () => {
    near(parseLatLon('57.79306; -152.39417'), { lat: 57.79306, lon: -152.39417 });
    near(parseLatLon('57.79306/-152.39417'), { lat: 57.79306, lon: -152.39417 });
    near(parseLatLon('57.79306 | -152.39417'), { lat: 57.79306, lon: -152.39417 });
  });

  it('reads decimal degrees with a degree sign and hemisphere letter', () => {
    near(parseLatLon('57.3880° N, 154.2973° W'), { lat: 57.388, lon: -154.2973 });
    near(parseLatLon('57.79306°N 152.39417°W'), { lat: 57.79306, lon: -152.39417 });
    near(parseLatLon('57.79306N,152.39417W'), { lat: 57.79306, lon: -152.39417 });
    near(parseLatLon('57.79306 n 152.39417 w'), { lat: 57.79306, lon: -152.39417 });
  });

  it('accepts a unicode minus, dashes, a leading plus, and non-ASCII whitespace', () => {
    near(parseLatLon('57.79306, −152.39417'), { lat: 57.79306, lon: -152.39417 });
    near(parseLatLon('57.79306, –152.39417'), { lat: 57.79306, lon: -152.39417 });
    near(parseLatLon('+57.79306, -152.39417'), { lat: 57.79306, lon: -152.39417 });
    near(parseLatLon('57.79306°N\u00a0152.39417°W'), { lat: 57.79306, lon: -152.39417 });
    near(parseLatLon('57.79306°N\u2009152.39417°W'), { lat: 57.79306, lon: -152.39417 });
  });
});

describe('degrees, minutes, seconds', () => {
  it('reads DMS with typographic primes', () => {
    near(parseLatLon('57°47′35″N 152°23′39″W'), KODIAK);
  });

  it('reads DMS with two apostrophes as the double prime', () => {
    near(parseLatLon('57°47′35′′N 152°23′39′′W'), KODIAK);
    near(parseLatLon("57°47'35''N 152°23'39''W"), KODIAK);
  });

  it('reads DMS with ASCII quotes, curly quotes, and the ordinal/ring degree signs', () => {
    near(parseLatLon('57°47\'35"N 152°23\'39"W'), KODIAK);
    near(parseLatLon('57°47’35”N 152°23’39”W'), KODIAK);
    near(parseLatLon('57º47′35″N 152º23′39″W'), KODIAK);
    near(parseLatLon('57˚47′35″N 152˚23′39″W'), KODIAK);
    near(parseLatLon('57*47\'35"N 152*23\'39"W'), KODIAK);
  });

  it('reads decimal seconds, as Google Maps writes them', () => {
    near(parseLatLon('57°47\'35.0"N 152°23\'39.0"W'), KODIAK);
  });

  it('reads DMS with spaces, and with no symbols at all', () => {
    near(parseLatLon('57° 47′ 35″ N, 152° 23′ 39″ W'), KODIAK);
    near(parseLatLon('57 47 35 N 152 23 39 W'), KODIAK);
    near(parseLatLon('57 47 35 -152 23 39'), KODIAK);
  });

  it('reads signed DMS without hemisphere letters', () => {
    near(parseLatLon('57°47′35″, -152°23′39″'), KODIAK);
  });
});

describe('degrees and decimal minutes', () => {
  it('reads the Garmin default format', () => {
    near(parseLatLon('N 57° 47.583′ W 152° 23.650′'), { lat: 57 + 47.583 / 60, lon: -(152 + 23.65 / 60) });
    near(parseLatLon('57° 47.583′ N 152° 23.650′ W'), { lat: 57 + 47.583 / 60, lon: -(152 + 23.65 / 60) });
    near(parseLatLon('57 47.583, -152 23.650'), { lat: 57 + 47.583 / 60, lon: -(152 + 23.65 / 60) });
  });
});

describe('hemisphere letters', () => {
  it('accepts the letter before the number', () => {
    near(parseLatLon('N 57° 47′ 35″, W 152° 23′ 39″'), KODIAK);
    near(parseLatLon('N57.79306 W152.39417'), { lat: 57.79306, lon: -152.39417 });
  });

  it('uses the letters to assign the axes, whichever comes first', () => {
    near(parseLatLon('152°23′39″W 57°47′35″N'), KODIAK);
    near(parseLatLon('W 152.39417, N 57.79306'), { lat: 57.79306, lon: -152.39417 });
  });

  it('assigns the unlabelled half the remaining axis', () => {
    near(parseLatLon('152.39417 W, 57.79306'), { lat: 57.79306, lon: -152.39417 });
  });

  it('rejects a sign that contradicts the letter, and two letters on one axis', () => {
    expect(parseLatLon('57.79306 N, -152.39417 W')).toBeNull();
    expect(parseLatLon('57.79306 N, 152.39417 S')).toBeNull();
  });
});

describe('labelled and annotated text', () => {
  it('drops axis labels', () => {
    near(parseLatLon('Lat: 57.79306, Lon: -152.39417'), { lat: 57.79306, lon: -152.39417 });
    near(parseLatLon('Latitude 57.79306°, Longitude -152.39417°'), { lat: 57.79306, lon: -152.39417 });
    near(parseLatLon('lat=57.79306 lng=-152.39417'), { lat: 57.79306, lon: -152.39417 });
    near(parseLatLon('Lat/Long: 57.79306, -152.39417'), { lat: 57.79306, lon: -152.39417 });
    near(parseLatLon('LAT. 57.79306 LONG. -152.39417'), { lat: 57.79306, lon: -152.39417 });
  });

  it('drops a bracketed note without digits', () => {
    near(parseLatLon('57.79306, -152.39417 (Kodiak)'), { lat: 57.79306, lon: -152.39417 });
    near(parseLatLon('[approx] 57.79306, -152.39417'), { lat: 57.79306, lon: -152.39417 });
  });

  it('rejects any other word', () => {
    expect(parseLatLon('Kodiak 57.79306, -152.39417')).toBeNull();
    expect(parseLatLon('57.79306, -152.39417 Kodiak')).toBeNull();
    expect(parseLatLon('57.79306, -152.39417 (Kodiak 2)')).toBeNull();
    expect(parseLatLon('57.79306 NW, 152.39417')).toBeNull();
  });
});

describe('decimal comma', () => {
  it('reads a comma as the decimal mark when the pair is separated by something else', () => {
    near(parseLatLon('57,79306; -152,39417'), { lat: 57.79306, lon: -152.39417 });
    near(parseLatLon('57,79306 -152,39417'), { lat: 57.79306, lon: -152.39417 });
    near(parseLatLon('57°47,5′N 152°23,6′W'), { lat: 57 + 47.5 / 60, lon: -(152 + 23.6 / 60) });
  });

  it('reads a comma followed by whitespace or a sign as a separator', () => {
    near(parseLatLon('57,79306, -152,39417'), { lat: 57.79306, lon: -152.39417 });
    near(parseLatLon('57,79306,-152,39417'), { lat: 57.79306, lon: -152.39417 });
    near(parseLatLon('57, -152'), { lat: 57, lon: -152 });
  });

  it('rejects the ambiguous four-number comma string', () => {
    expect(parseLatLon('57,5,152,3')).toBeNull();
  });

  it('never reads a comma as a decimal mark once a dot is present', () => {
    expect(parseLatLon('57.5,152,3')).toBeNull();
  });
});

describe('validation', () => {
  it('rejects out-of-range values', () => {
    expect(parseLatLon('91, 0')).toBeNull();
    expect(parseLatLon('0, 181')).toBeNull();
    expect(parseLatLon('-90.0001, 0')).toBeNull();
    near(parseLatLon('90, 180'), { lat: 90, lon: 180 });
    near(parseLatLon('-90, -180'), { lat: -90, lon: -180 });
  });

  it('rejects minutes or seconds of 60 or more', () => {
    expect(parseLatLon('57°60′N 152°23′W')).toBeNull();
    expect(parseLatLon('57°47′60″N 152°23′39″W')).toBeNull();
  });

  it('rejects fractional degrees or minutes followed by more parts', () => {
    expect(parseLatLon('57.5°47′N 152°23′W')).toBeNull();
    expect(parseLatLon('57°47.5′35″N 152°23′39″W')).toBeNull();
  });

  it('rejects a unit symbol in the wrong position', () => {
    expect(parseLatLon('57′47″N 152′23″W')).toBeNull();
    expect(parseLatLon('57°47°N 152°23°W')).toBeNull();
  });

  it('rejects the wrong number of numbers', () => {
    expect(parseLatLon('')).toBeNull();
    expect(parseLatLon('   ')).toBeNull();
    expect(parseLatLon('57.79306')).toBeNull();
    expect(parseLatLon('57.79306, -152.39417, 1200')).toBeNull();
    expect(parseLatLon('57 47 35 152 23')).toBeNull();
    expect(parseLatLon('57°47′35″12″N 152°23′39″W')).toBeNull();
  });

  it('rejects a sign on minutes or seconds, and unmatched brackets', () => {
    expect(parseLatLon('57 -47 N 152 23 W')).toBeNull();
    expect(parseLatLon('(57.79306, -152.39417')).toBeNull();
  });

  it('never guesses at a lon-first pair', () => {
    expect(parseLatLon('-152.39417, 57.79306')).toBeNull();
  });
});
