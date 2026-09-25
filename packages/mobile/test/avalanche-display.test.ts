import { describe, it, expect } from 'vitest';
import {
  dangerCell, dayLabel, likelihoodScale, pieceFeatures, sizeScale, stampLabel,
} from '../avalancheDisplay';

describe('dangerCell', () => {
  it('numbers the five levels and colors them on the public scale', () => {
    expect(dangerCell('low')).toMatchObject({ number: '1', name: 'Low', text: '#1c1c1e', icon: 'low' });
    expect(dangerCell('considerable')).toMatchObject({ number: '3', name: 'Considerable', text: '#1c1c1e' });
    expect(dangerCell('high')).toMatchObject({ number: '4', name: 'High', text: '#ffffff' });
    expect(dangerCell('extreme')).toMatchObject({ number: '5', name: 'Extreme', border: '#ed1c24', icon: 'extreme' });
  });

  it('shows a band without a level as a gray named cell', () => {
    expect(dangerCell('spring')).toEqual({ fill: '#e5e5ea', text: '#636366', number: '', name: 'Spring', icon: 'noRating' });
    expect(dangerCell('noRating').name).toBe('No Rating');
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

describe('pieces', () => {
  const piece = (id: number, names: string[], bbox: [number, number, number, number]) =>
    ({ id, center: 'avalanche-canada', names, bbox, polygons: [] });
  const pieces = [
    piece(0, ['Brandywine'], [-124, 50, -123, 51]),
    piece(1, ['Sky Pilot'], [-123.5, 49.4, -123, 49.8]),
    piece(2, ['Kitimat', 'Rupert', 'Shames'], [-130, 54, -128, 55]),
  ];

  it('turns pieces into MultiPolygon features', () => {
    expect(pieceFeatures(pieces).features[2]).toMatchObject({ properties: { id: 2 }, geometry: { type: 'MultiPolygon' } });
  });
});
