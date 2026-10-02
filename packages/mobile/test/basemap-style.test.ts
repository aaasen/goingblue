import { describe, expect, it } from 'vitest';
import { buildBasemapStyle } from '../basemapStyle';

const BUNDLED = { base: 'file:///bundled-base.pmtiles', hs: 'file:///bundled-hs.pmtiles' };

describe('glyphs', () => {
  it('points at the local glyph directory', () => {
    const style = buildBasemapStyle(BUNDLED, [], 'file:///glyphs/');
    expect(style.glyphs).toBe('file:///glyphs/{fontstack}/{range}.pbf');
  });

  it('hides labels instead of fetching glyphs when the local set is missing', () => {
    const style = buildBasemapStyle(BUNDLED, [], undefined);
    expect(style.glyphs).toBeUndefined();
    const symbols = style.layers.filter((l) => l.type === 'symbol');
    expect(symbols.length).toBeGreaterThan(0);
    for (const l of symbols) expect(l.layout?.visibility).toBe('none');
  });
});
