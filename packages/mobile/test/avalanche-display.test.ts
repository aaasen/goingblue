import { describe, it, expect } from 'vitest';
import { AVALANCHE_PIECES } from '@weather/protocol';
import {
  bulletinTimezone, dangerCell, dangerTables, dayLabel, forecastRegion, highestDanger, likelihoodScale, pieceAt, pieceFeatures, sizeScale, stampLabel,
} from '../avalancheDisplay';

describe('dangerCell', () => {
  it('numbers the five levels and colors them on the public scale', () => {
    expect(dangerCell('low')).toMatchObject({ number: '1', name: 'Low', text: '#1c1c1e', icon: 'low' });
    expect(dangerCell('considerable')).toMatchObject({ number: '3', name: 'Considerable', text: '#1c1c1e' });
    expect(dangerCell('high')).toMatchObject({ number: '4', name: 'High', text: '#ffffff' });
    expect(dangerCell('extreme')).toMatchObject({ number: '5', name: 'Extreme', border: '#ed1c24', icon: 'extreme' });
  });

  it('shows a band without a level as a gray named cell', () => {
    expect(dangerCell('spring')).toEqual({ fill: '#0072c6', text: '#ffffff', number: '', name: 'Spring Conditions', icon: 'spring' });
    expect(dangerCell('earlySeason')).toMatchObject({ fill: '#0072c6', icon: 'info' });
    expect(dangerCell('offSeason')).toMatchObject({ fill: '#ffffff', text: '#000000', name: 'Summer Conditions', icon: 'blank' });
    expect(dangerCell('noRating').name).toBe('No Rating');
  });
});

describe('highestDanger', () => {
  it('takes the top level across the bands', () => {
    expect(highestDanger({ alp: 'moderate', tln: 'considerable', btl: 'low' })).toBe('considerable');
    expect(highestDanger({ alp: 'noRating', tln: 'noRating', btl: 'low' })).toBe('low');
  });

  it("falls back to the alpine band's status when no band has a level", () => {
    expect(highestDanger({ alp: 'spring', tln: 'spring', btl: 'noRating' })).toBe('spring');
  });
});

describe('forecastRegion', () => {
  it("fills the forecast's pieces in the first day's highest danger", () => {
    const region = forecastRegion([6, 27], [
      { alp: 'high', tln: 'considerable', btl: 'moderate' },
      { alp: 'extreme', tln: 'extreme', btl: 'extreme' },
    ]);
    expect(region?.data.features.map((f) => f.properties?.id)).toEqual([6, 27]);
    expect(region).toMatchObject({ fill: '#ed1c24', outline: '#ed1c24' });
  });

  it('rings extreme in red and fills a day without a level in its status color', () => {
    expect(forecastRegion([6], [{ alp: 'extreme', tln: 'high', btl: 'high' }])).toMatchObject({ fill: '#231f20', outline: '#ed1c24' });
    expect(forecastRegion([6], [{ alp: 'earlySeason', tln: 'earlySeason', btl: 'earlySeason' }])?.fill).toBe('#0072c6');
    expect(forecastRegion([6], [{ alp: 'offSeason', tln: 'offSeason', btl: 'offSeason' }])?.fill).toBe('#ffffff');
    expect(forecastRegion([6], [])?.fill).toBe('#ffffff');
  });

  it('draws nothing for a forecast that does not say where it applies', () => {
    expect(forecastRegion([], [{ alp: 'low', tln: 'low', btl: 'low' }])).toBeNull();
  });
});

describe('problem scales', () => {
  it('bolds and bars one likelihood, or both names around a half-step', () => {
    const possible = likelihoodScale('possible');
    expect(possible.rows.map((r) => r.label)).toEqual(['Certain', 'Very Likely', 'Likely', 'Possible', 'Unlikely']);
    expect(possible.rows.filter((r) => r.bold).map((r) => r.label)).toEqual(['Possible']);
    expect(possible.bar).toEqual([2.65, 3.35]);
    const half = likelihoodScale('possible-likely');
    expect(half.rows.filter((r) => r.bold).map((r) => r.label)).toEqual(['Likely', 'Possible']);
    expect(half.bar).toEqual([1.65, 3.35]);
  });

  it('bars sizes from max down to min, ending half sizes between rows', () => {
    const small = sizeScale({ min: 1, max: 2 });
    expect(small.rows.filter((r) => r.bold).map((r) => r.label)).toEqual(['2', '1']);
    expect(small.notes.filter((n) => n.bold).map((n) => n.label)).toEqual(['Large', 'Small']);
    expect(small.bar).toEqual([2.65, 4.35]);
    const half = sizeScale({ min: 1.5, max: 3 });
    expect(half.rows.filter((r) => r.bold).map((r) => r.label)).toEqual(['3', '2']);
    expect(half.notes.filter((n) => n.bold).map((n) => n.label)).toEqual(['Large']);
    expect(half.bar).toEqual([1.65, 3.5]);
    expect(sizeScale({ min: 2.5, max: 2.5 }).bar).toEqual([2.15, 2.85]);
    expect(sizeScale({ min: 3, max: 4 }).notes.find((n) => n.label === 'Very Large')?.bold).toBe(true);
  });
});

describe('zoned labels', () => {
  const issued = Date.parse('2026-03-01T00:00:00Z');
  it('names days and stamps times in the forecast zone', () => {
    expect(dayLabel(Date.parse('2026-03-01T08:00:00Z'), 'America/Vancouver')).toBe('Sunday');
    expect(stampLabel(issued, 'America/Vancouver', '12h')).toBe('Sat, February 28, 2026 at 4:00 PM PT');
    expect(stampLabel(issued, 'America/Vancouver', '24h')).toBe('Sat, February 28, 2026 at 16:00 PT');
    const morning = Date.parse('2026-03-01T08:05:00Z');
    expect(stampLabel(morning, 'America/Vancouver', '12h')).toBe('Sun, March 1, 2026 at 12:05 AM PT');
    expect(stampLabel(morning, 'America/Vancouver', '24h')).toBe('Sun, March 1, 2026 at 00:05 PT');
    expect(stampLabel(issued, 'Europe/Zurich', '24h')).toBe('Sun, March 1, 2026 at 01:00');
  });
});

describe('dangerTables', () => {
  const tz = 'America/Vancouver';
  const day = (iso: string, r: 'offSeason' | 'spring' | 'low') => ({ date: Date.parse(iso), alp: r, tln: r, btl: r });
  const expires = Date.parse('2026-10-01T23:00:00Z');
  const now = Date.parse('2026-09-28T19:00:00Z');
  it('collapses a spring or summer bulletin into one table until it expires once its days are past', () => {
    const danger = [day('2026-07-01T07:00:00Z', 'offSeason'), day('2026-07-02T07:00:00Z', 'spring'), day('2026-07-03T07:00:00Z', 'offSeason')];
    expect(dangerTables({ danger, expires, timezone: tz }, now)).toEqual([{ key: danger[0].date, label: 'Until October 1', day: danger[0] }]);
  });
  it('keeps one table per day while the last day is today or later', () => {
    const danger = [day('2026-09-27T07:00:00Z', 'spring'), day('2026-09-28T07:00:00Z', 'spring')];
    expect(dangerTables({ danger, expires, timezone: tz }, now).map((t) => t.label)).toEqual(['Sunday', 'Monday']);
  });
  it('keeps one table per day when any band has another rating', () => {
    const danger = [day('2026-03-01T08:00:00Z', 'low'), day('2026-03-02T08:00:00Z', 'offSeason')];
    expect(dangerTables({ danger, expires, timezone: tz }, now).map((t) => t.label)).toEqual(['Sunday', 'Monday']);
  });
});

describe('pieces', () => {
  const piece = (id: number, names: string[], bbox: [number, number, number, number]) =>
    ({ id, center: 'avalanche-canada', names, bbox, polygons: [] });
  const pieces = [
    piece(0, ['Brandywine'], [-124, 50, -123, 51]),
    piece(1, ['Sky Pilot'], [-123.5, 49.4, -123, 49.8]),
    piece(2, ['Kitimat', 'Rupert', 'Shames'], [-130, 54, -128, 55]),
  ];

  it('finds the piece a point falls in, holes excluded', () => {
    const square = (w: number, s: number, e: number, n: number): [number, number][] =>
      [[w, s], [e, s], [e, n], [w, n], [w, s]];
    const donut = { ...piece(3, ['Donut'], [0, 0, 10, 10]), polygons: [[square(0, 0, 10, 10), square(4, 4, 6, 6)]] };
    expect(pieceAt(2, 2, [donut])?.names).toEqual(['Donut']);
    expect(pieceAt(5, 5, [donut])).toBeNull();
    expect(pieceAt(20, 20, [donut])).toBeNull();
  });

  it('places real points in the shipped pieces', () => {
    expect(pieceAt(50.12, -122.95, AVALANCHE_PIECES)?.names).toEqual(['Spearhead']);
    expect(pieceAt(49.28, -123.12, AVALANCHE_PIECES)).toBeNull();
  });

  it('turns pieces into MultiPolygon features', () => {
    expect(pieceFeatures(pieces).features[2]).toMatchObject({ properties: { id: 2 }, geometry: { type: 'MultiPolygon' } });
  });
});

describe('bulletinTimezone', () => {
  it("stamps a bulletin in its center's zone rather than the point's own", () => {
    expect(bulletinTimezone(50.1163, -122.9574)).toBe('America/Vancouver'); // Sea to Sky
    expect(bulletinTimezone(51.1784, -115.5708)).toBe('America/Edmonton'); // Banff
    // Kootenay Pass sits on Creston's clock, which keeps no daylight time; Avalanche Canada
    // stamps the region on Pacific time.
    expect(bulletinTimezone(49.058, -117.04)).toBe('America/Vancouver');
    expect(bulletinTimezone(49.53, -57.8)).toBe('America/St_Johns'); // Gros Morne
    expect(bulletinTimezone(48.95, -66.1)).toBe('America/New_York'); // Chic-Chocs
  });
});

