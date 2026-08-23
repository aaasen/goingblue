import type {
  FilterSpecification,
  LayerSpecification,
  StyleSpecification,
  SymbolLayerSpecification,
} from '@maplibre/maplibre-react-native';

// MapLibre style for the location picker, rendered by MapLibre Native straight out of PMTiles
// archives. This is the "online tier" of the chunked basemap: full-depth public archives streamed
// and cached by the native engine. The offline stacks (bundled global z6 + downloadable country and
// state packs) slot in UNDER these layers later; the layer set here is the same one the packs use,
// parameterized by source, so adding a pack is a second `stack()` with its own sources.
//
// Vectors are the Protomaps daily build (stock schema; only our layers are styled — roads and
// buildings are never drawn). Terrain is Mapterhorn's planet DEM, shaded client-side by a
// `hillshade` layer, so there is nothing to bake and crevasse/moraine detail comes through at z13.
// Both are evaluation endpoints: production serves its own R2 copies.

// Pinned rather than "latest": the offline packs are extracts of this build, so the online tier
// and the packs agree on every feature and label. Bump both together.
export const PROTOMAPS_BUILD = 'https://build.protomaps.com/20260820.pmtiles';
export const MAPTERHORN_PLANET = 'https://download.mapterhorn.com/planet.pmtiles';
// Noto Sans Regular/Medium/Italic — the three faces the offline packs bundle; hosted by Protomaps.
const GLYPHS = 'https://protomaps.github.io/basemaps-assets/fonts/{fontstack}/{range}.pbf';

export const MAX_ZOOM = 15.5;

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

const halo = { 'text-halo-color': '#ffffff', 'text-halo-width': 1.4 };

// English where the source carries it (all stock Protomaps layers), else the local name.
const nameEn = ['coalesce', ['get', 'name:en'], ['get', 'name']] as unknown as string;

// Peak label: "Name\n20,310 ft". The stock schema carries `elevation` in metres.
const peakText = [
  'case',
  ['has', 'elevation'],
  [
    'concat',
    nameEn,
    '\n',
    ['number-format', ['round', ['*', ['get', 'elevation'], 3.28084]], { 'max-fraction-digits': 0 }],
    ' ft',
  ],
  nameEn,
] as unknown as string;

interface StackSources {
  // Vector source with earth/landuse/water/boundaries/places/pois.
  base: string;
  // Vector source for landcover. Stock landcover ends at z7, so this is a second source over the
  // same archive capped at maxzoom 7 — it overzooms instead of vanishing at z8+.
  landcover: string;
  // Either a prebaked raster hillshade (offline packs) or a raster-dem (online) — see `shade`.
  terrain: { kind: 'raster' | 'dem'; source: string };
  // Layers only apply from this zoom — packs cover a zoom band, the online tier the top.
  minzoom?: number;
}

// Full layer set for one archive set, ids prefixed so several stacks can coexist.
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

  const shade: LayerSpecification =
    src.terrain.kind === 'raster'
      ? {
          id: p + 'hillshade',
          type: 'raster',
          source: src.terrain.source,
          ...minzoom,
          paint: { 'raster-opacity': 0.55, 'raster-contrast': 0.25, 'raster-resampling': 'linear' },
        }
      : {
          id: p + 'hillshade',
          type: 'hillshade',
          source: src.terrain.source,
          ...minzoom,
          paint: {
            'hillshade-exaggeration': 0.4,
            'hillshade-shadow-color': '#5a5248',
            'hillshade-highlight-color': '#ffffff',
          },
        };

  return [
    fill('earth', 'earth', { 'fill-color': EARTH }),
    {
      id: p + 'landcover',
      type: 'fill',
      source: src.landcover,
      'source-layer': 'landcover',
      ...minzoom,
      paint: { 'fill-color': landcoverColor },
    },
    fill('glacier', 'landuse', { 'fill-color': '#f2f8fc', 'fill-opacity': 0.9 }, ['==', ['get', 'kind'], 'glacier']),
    fill('bare-rock', 'landuse', { 'fill-color': '#cdc7bd', 'fill-opacity': 0.7 }, ['==', ['get', 'kind'], 'bare_rock']),
    shade,
    fill('water', 'water', { 'fill-color': WATER }, ['==', ['geometry-type'], 'Polygon']),
    {
      // Rivers: stock water lines from z9 (streams arrive at higher zooms than we carry).
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
    symbol('water-labels', 'water', {
      filter: ['all', ['==', ['geometry-type'], 'Point'], ['has', 'name']],
      layout: { 'text-field': nameEn, 'text-font': ['Noto Sans Italic'], 'text-size': 12, 'text-padding': 8 },
      paint: { 'text-color': '#4a7ba6', ...halo },
    }),
    symbol('peaks', 'pois', {
      filter: ['all', ['==', ['get', 'kind'], 'peak'], ['has', 'name']],
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
        'symbol-sort-key': ['-', 9000, ['coalesce', ['get', 'elevation'], 0]],
      },
      paint: { 'text-color': '#5a4636', ...halo },
    }),
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

export const basemapStyle: StyleSpecification = {
  version: 8,
  glyphs: GLYPHS,
  sources: {
    'online-base': { type: 'vector', url: `pmtiles://${PROTOMAPS_BUILD}`, maxzoom: 15 },
    'online-landcover': { type: 'vector', url: `pmtiles://${PROTOMAPS_BUILD}`, maxzoom: 7 },
    'online-dem': {
      type: 'raster-dem',
      url: `pmtiles://${MAPTERHORN_PLANET}`,
      encoding: 'terrarium',
      tileSize: 512,
      maxzoom: 12,
    },
  },
  layers: [
    { id: 'background', type: 'background', paint: { 'background-color': WATER } },
    ...stack('o-', {
      base: 'online-base',
      landcover: 'online-landcover',
      terrain: { kind: 'dem', source: 'online-dem' },
    }),
  ],
};
