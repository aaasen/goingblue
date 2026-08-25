import type {
  FilterSpecification,
  LayerSpecification,
  StyleSpecification,
  SymbolLayerSpecification,
} from '@maplibre/maplibre-react-native';

// MapLibre style for the location picker, rendered by MapLibre Native straight out of our own
// PMTiles archives on R2 — the production z0-10 basemap built by maps/build (stripped Protomaps
// vectors + Overture labels with English names + Copernicus land cover, and a prebaked
// hillshade). This is the online tier; the offline stacks (bundled global z6, downloadable
// country/state packs) slot in UNDER these layers as further `stack()` calls with their own
// sources — the layer set is identical, parameterized by source.
//
// The web twin of this stack is maps/preview/style.js; keep them in step.

export const BASEMAP_URL = 'https://r2.going.blue';
// Noto Sans Regular/Medium/Italic — the three faces the basemap uses; hosted glyphs for now
// (bundling them comes with the offline packs).
const GLYPHS = 'https://protomaps.github.io/basemaps-assets/fonts/{fontstack}/{range}.pbf';

// Data ends at z10; overzoom keeps the map usable past it (~35 m/px at 63°N by 12.5).
export const DATA_MAX_ZOOM = 10;
export const MAX_ZOOM = 12.5;
// Floor keeps the camera at a useful scale — continent-wide, but never the whole world tiled
// out at once on a phone screen.
export const MIN_ZOOM = 2;

const LANDCOVER_COLORS: Record<string, string> = {
  forest: '#aac29e',
  grassland: '#d1d7b4',
  scrub: '#c4d0aa',
  farmland: '#ded9be',
  barren: '#d8d3c7',
  glacier: '#f2f8fc',
  urban_area: '#d5cfd3',
  wetland: '#c3d3c4',
};
const EARTH = '#d8d3c7';
const WATER = '#a9c7dc';

const landcoverColor = [
  'match',
  ['get', 'kind'],
  ...Object.entries(LANDCOVER_COLORS).flat(),
  EARTH,
] as unknown as string;

// English where the source carries it (stock Protomaps layers keep name:en; our own label
// layers — peaks, water_labels, glacier_labels — were built with English coalesced into `name`).
const nameEn = ['coalesce', ['get', 'name:en'], ['get', 'name']] as unknown as string;

const halo = { 'text-halo-color': '#ffffff', 'text-halo-width': 1.4 };

// Peak label: "Denali\n20,308 ft". The peaks layer carries `ele` in metres.
const peakText = [
  'case',
  ['has', 'ele'],
  [
    'concat',
    ['get', 'name'],
    '\n',
    ['number-format', ['round', ['*', ['get', 'ele'], 3.28084]], { 'max-fraction-digits': 0 }],
    ' ft',
  ],
  ['get', 'name'],
] as unknown as string;

interface StackSources {
  // Vector source with earth/landcover/landuse/water/boundaries/places plus our peaks,
  // water_labels and glacier_labels.
  base: string;
  // Raster source with the prebaked hillshade.
  hillshade: string;
  // Layers only apply from this zoom — packs cover a zoom band, the online tier the top.
  minzoom?: number;
}

// Full layer set for one archive pair, ids prefixed so several stacks can coexist.
function stack(p: string, src: StackSources): LayerSpecification[] {
  const minzoom = src.minzoom == null ? {} : { minzoom: src.minzoom };
  const fill = (id: string, sourceLayer: string, paint: Record<string, unknown>, filter?: FilterSpecification) =>
    ({
      id: p + id,
      type: 'fill',
      source: src.base,
      'source-layer': sourceLayer,
      ...minzoom,
      ...(filter && { filter }),
      paint,
    }) as LayerSpecification;
  const symbol = (id: string, sourceLayer: string, spec: Partial<SymbolLayerSpecification>) =>
    ({
      id: p + id,
      type: 'symbol',
      source: src.base,
      'source-layer': sourceLayer,
      ...minzoom,
      ...spec,
    }) as LayerSpecification;

  // Significance-ranked labels arrive in three zoom bands: only the biggest features at low
  // zoom, everything from z10. rank is per 0.25° cell (peaks by elevation, lakes by area).
  const banded = (
    id: string,
    sourceLayer: string,
    bands: [suffix: string, bandMin: number, maxrank: number][],
    spec: (filter: FilterSpecification) => Partial<SymbolLayerSpecification>,
  ) =>
    bands.map(([suffix, bandMin, maxrank]) =>
      symbol(id + suffix, sourceLayer, {
        ...spec(['<=', ['coalesce', ['get', 'rank'], 1], maxrank] as FilterSpecification),
        minzoom: Math.max(bandMin, src.minzoom ?? 0),
        ...(suffix !== '-all' && { maxzoom: bandMin === 0 ? 9 : 10 }),
      }),
    );

  return [
    fill('earth', 'earth', { 'fill-color': EARTH }),
    fill('landcover', 'landcover', { 'fill-color': landcoverColor }),
    fill('glacier', 'landuse', { 'fill-color': '#f2f8fc', 'fill-opacity': 0.9 }, ['==', ['get', 'kind'], 'glacier']),
    fill('bare-rock', 'landuse', { 'fill-color': '#cdc7bd', 'fill-opacity': 0.7 }, ['==', ['get', 'kind'], 'bare_rock']),
    {
      id: p + 'hillshade',
      type: 'raster',
      source: src.hillshade,
      ...minzoom,
      paint: { 'raster-opacity': 0.55, 'raster-contrast': 0.25, 'raster-resampling': 'linear' },
    },
    fill('water', 'water', { 'fill-color': WATER }, ['==', ['geometry-type'], 'Polygon']),
    {
      id: p + 'rivers',
      type: 'line',
      source: src.base,
      'source-layer': 'water',
      ...minzoom,
      filter: ['==', ['geometry-type'], 'LineString'],
      paint: { 'line-color': WATER, 'line-width': ['interpolate', ['linear'], ['zoom'], 9, 0.8, 12, 2] },
    },
    {
      id: p + 'boundaries-region',
      type: 'line',
      source: src.base,
      'source-layer': 'boundaries',
      ...minzoom,
      filter: ['!=', ['get', 'kind'], 'country'],
      paint: { 'line-color': '#9b909b', 'line-width': 0.8, 'line-dasharray': [3, 2] },
    },
    {
      id: p + 'boundaries-country',
      type: 'line',
      source: src.base,
      'source-layer': 'boundaries',
      ...minzoom,
      filter: ['==', ['get', 'kind'], 'country'],
      paint: { 'line-color': '#8a7f8a', 'line-width': 1.4 },
    },
    ...banded('water-labels', 'water_labels', [['', 0, 2], ['-mid', 9, 5], ['-all', 10, 99]], (filter) => ({
      filter,
      layout: { 'text-field': ['get', 'name'], 'text-font': ['Noto Sans Italic'], 'text-size': 12, 'text-padding': 8 },
      paint: { 'text-color': '#4a7ba6', ...halo },
    })),
    symbol('glacier-labels', 'glacier_labels', {
      layout: { 'text-field': ['get', 'name'], 'text-font': ['Noto Sans Italic'], 'text-size': 12 },
      paint: { 'text-color': '#6a94b8', ...halo },
    }),
    ...banded('peaks', 'peaks', [['', 0, 2], ['-mid', 9, 6], ['-all', 10, 99]], (filter) => ({
      filter,
      layout: {
        'icon-image': 'peak-triangle',
        'icon-size': 1,
        'text-optional': true,
        'text-field': peakText,
        'text-font': ['Noto Sans Medium'],
        'text-size': 12,
        'text-anchor': 'top',
        'text-offset': [0, 0.6],
        'text-padding': 14,
        'symbol-sort-key': ['-', 9000, ['coalesce', ['get', 'ele'], 0]],
      },
      paint: { 'text-color': '#5a4636', ...halo },
    })),
    symbol('places-city', 'places', {
      filter: ['==', ['get', 'kind'], 'locality'],
      layout: {
        'text-field': nameEn,
        'text-font': ['Noto Sans Regular'],
        'text-size': 12,
        'symbol-sort-key': ['coalesce', ['get', 'min_zoom'], 10],
      },
      paint: { 'text-color': '#3d3a38', ...halo },
    }),
    symbol('places-region', 'places', {
      filter: ['==', ['get', 'kind'], 'region'],
      layout: {
        'text-field': nameEn,
        'text-font': ['Noto Sans Regular'],
        'text-size': 12,
        'text-transform': 'uppercase',
        'text-letter-spacing': 0.1,
      },
      paint: { 'text-color': '#8a847e', ...halo },
    }),
    symbol('places-country', 'places', {
      filter: ['==', ['get', 'kind'], 'country'],
      layout: {
        'text-field': nameEn,
        'text-font': ['Noto Sans Medium'],
        'text-size': 14,
        'text-transform': 'uppercase',
      },
      paint: { 'text-color': '#54504e', ...halo },
    }),
  ];
}

// One archive pair as { base, hs } pmtiles URLs (remote https or local file://).
export interface ArchivePair {
  base: string;
  hs: string;
}

// An installed offline pack: the pair on disk plus where it applies.
export interface PackArchives extends ArchivePair {
  id: string;
  bounds: number[]; // W, S, E, N
}

// The full style: the bundled global z6 pair (when its assets have resolved) at the bottom,
// each installed pack over it, the online z10 archives on top. Every tier renders at all
// zooms — a source overzooms past its data — so whichever upper tiers can't load (offline,
// R2 unreachable) simply leave the finest available tier beneath showing: pack detail where a
// pack is installed, bundled overview elsewhere.
export function buildBasemapStyle(bundled?: ArchivePair, packs: PackArchives[] = [], glyphsBase?: string): StyleSpecification {
  const sources: StyleSpecification['sources'] = {
    'online-base': {
      type: 'vector',
      url: `pmtiles://${BASEMAP_URL}/global-base.pmtiles`,
      maxzoom: DATA_MAX_ZOOM,
    },
    'online-hs': {
      type: 'raster',
      url: `pmtiles://${BASEMAP_URL}/global-hs.pmtiles`,
      tileSize: 512,
      maxzoom: DATA_MAX_ZOOM,
    },
  };
  const layers: LayerSpecification[] = [
    { id: 'background', type: 'background', paint: { 'background-color': WATER } },
  ];
  if (bundled) {
    sources['bundled-base'] = { type: 'vector', url: `pmtiles://${bundled.base}`, maxzoom: 6 };
    sources['bundled-hs'] = { type: 'raster', url: `pmtiles://${bundled.hs}`, tileSize: 512, maxzoom: 6 };
    layers.push(...stack('g-', { base: 'bundled-base', hillshade: 'bundled-hs' }));
  }
  for (const pack of packs) {
    // A pack is a z0-10 extract, but the bundled tier already covers 0-6 everywhere, so its
    // sources start at 6; bounds keep the engine from asking it for tiles elsewhere.
    const bounds = pack.bounds as [number, number, number, number];
    sources[`pack-${pack.id}-base`] = {
      type: 'vector', url: `pmtiles://${pack.base}`, minzoom: 6, maxzoom: DATA_MAX_ZOOM, bounds,
    };
    sources[`pack-${pack.id}-hs`] = {
      type: 'raster', url: `pmtiles://${pack.hs}`, tileSize: 512, minzoom: 6, maxzoom: DATA_MAX_ZOOM, bounds,
    };
    layers.push(...stack(`p-${pack.id}-`, {
      base: `pack-${pack.id}-base`, hillshade: `pack-${pack.id}-hs`, minzoom: 6,
    }));
  }
  layers.push(...stack('o-', { base: 'online-base', hillshade: 'online-hs' }));
  const glyphs = glyphsBase ? `${glyphsBase.replace(/\/$/, '')}/{fontstack}/{range}.pbf` : GLYPHS;
  return { version: 8, glyphs, sources, layers };
}
