import { describe, expect, it } from 'vitest';
import { AVALANCHE_PIECES } from '@weather/protocol';
import { ZONE_CENTERS, ZONE_CENTER_SECTIONS, centerName, centerRegions, zoneAt, zonePoint, zoneRegion } from '../avalancheZones';

describe('zone points', () => {
  it('puts every region\'s request point inside that region, clear of its boundary', () => {
    for (const piece of AVALANCHE_PIECES) {
      const { lat, lon } = zonePoint(piece);
      expect(zoneAt({ lat, lon })?.id, piece.names.join()).toBe(piece.id);
      // Still inside after a nudge of a few hundred meters each way.
      for (const [dy, dx] of [[0.003, 0], [-0.003, 0], [0, 0.003], [0, -0.003]]) {
        expect(zoneAt({ lat: lat + dy, lon: lon + dx })?.id, piece.names.join()).toBe(piece.id);
      }
      expect(`${lat}`).toBe(`${Number(lat.toFixed(4))}`);
    }
  });

  it('frames a region for the map', () => {
    const piece = AVALANCHE_PIECES[0];
    expect(zoneRegion(piece, '#123456')).toMatchObject({ fill: '#123456', bbox: piece.bbox });
  });
});

describe('centers and regions', () => {
  it('lists every center once, by name', () => {
    expect(ZONE_CENTERS.length).toBe(new Set(AVALANCHE_PIECES.map((p) => p.center)).size);
    const names = ZONE_CENTERS.map((c) => c.name);
    expect(new Set(names).size).toBe(names.length);
    expect(names).toEqual([...names].sort((a, b) => a.localeCompare(b, 'en')));
    expect(ZONE_CENTER_SECTIONS.map((s) => [s.title, s.centers.length])).toEqual([['USA', 21], ['Canada', 7]]);
    expect(ZONE_CENTER_SECTIONS[1].centers.map((c) => c.key)).toContain('avalanche-canada');
    expect(centerName('nwac')).toBe('Northwest Avalanche Center');
    expect(centerName('parks-jasper')).toBe('Parks Canada: Jasper');
  });

  it('lists each center\'s regions once', () => {
    for (const { key } of ZONE_CENTERS) {
      const listed = centerRegions(key).flatMap((s) => s.pieces.map((p) => p.id)).sort((a, b) => a - b);
      expect(listed).toEqual(AVALANCHE_PIECES.filter((p) => p.center === key).map((p) => p.id));
    }
  });

  it('groups every Avalanche Canada region under a range', () => {
    const sections = centerRegions('avalanche-canada');
    expect(sections.every((s) => s.title !== null)).toBe(true);
    expect(sections.map((s) => s.title)).toContain('Vancouver Island');
    expect(sections.find((s) => s.title === 'Vancouver Island')!.pieces.map((p) => p.names[0]))
      .toEqual(['East Island', 'North Island', 'South Island', 'West Island']);
    expect(centerRegions('nwac')).toHaveLength(1);
  });
});
