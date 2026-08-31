import type {
  FilterSpecification,
  LayerSpecification,
  StyleSpecification,
  SymbolLayerSpecification,
} from "maplibre-gl";

// The stats map's basemap: MapLibre GL JS rendering the production z0-10 archives on R2, the
// same online tier the app draws (stripped Protomaps vectors + Overture labels with English
// names + Copernicus land cover, and a prebaked hillshade). This is a web port of the app's
// style builder, online tier only: no bundled archives and no offline packs, since a browser
// dashboard always has the network. The layer stack is a copy of the app's; keep it in step
// with packages/mobile/basemapStyle.ts.

export const BASEMAP_URL = "https://r2.going.blue";
// Noto Sans Regular/Medium/Italic, the three faces the basemap uses; same hosted glyphs the
// app's online tier reads.
const GLYPHS = "https://protomaps.github.io/basemaps-assets/fonts/{fontstack}/{range}.pbf";

// Data ends at z10; overzoom keeps the map usable past it.
export const DATA_MAX_ZOOM = 10;
export const MAX_ZOOM = 12.5;
// One level under the app's floor of 2: the dashboard map is a world overview on a large
// screen, not a phone picker.
export const MIN_ZOOM = 1;

const LANDCOVER_COLORS: Record<string, string> = {
  forest: "#aac29e",
  grassland: "#d1d7b4",
  scrub: "#c4d0aa",
  farmland: "#ded9be",
  barren: "#d8d3c7",
  glacier: "#f2f8fc",
  urban_area: "#d5cfd3",
  wetland: "#c3d3c4",
};
const EARTH = "#d8d3c7";
const WATER = "#a9c7dc";

const landcoverColor = [
  "match",
  ["get", "kind"],
  ...Object.entries(LANDCOVER_COLORS).flat(),
  EARTH,
] as unknown as string;

// English where the source carries it (stock Protomaps layers keep name:en; our own label
// layers were built with English coalesced into `name`).
const nameEn = ["coalesce", ["get", "name:en"], ["get", "name"]] as unknown as string;

const halo = { "text-halo-color": "#ffffff", "text-halo-width": 1.4 };

// Peak label: "Denali\n20,308 ft". The peaks layer carries `ele` in meters.
const peakText = [
  "case",
  ["has", "ele"],
  [
    "concat",
    ["get", "name"],
    "\n",
    ["number-format", ["round", ["*", ["get", "ele"], 3.28084]], { "max-fraction-digits": 0 }],
    " ft",
  ],
  ["get", "name"],
] as unknown as string;

interface StackSources {
  // Vector source with earth/landcover/landuse/water/boundaries/places plus our peaks,
  // water_labels and glacier_labels.
  base: string;
  // Raster source with the prebaked hillshade.
  hillshade: string;
}

// Full layer set for one archive pair, ids prefixed to match the app's stack.
function stack(p: string, src: StackSources): LayerSpecification[] {
  const fill = (id: string, sourceLayer: string, paint: Record<string, unknown>, filter?: FilterSpecification) =>
    ({
      id: p + id,
      type: "fill",
      source: src.base,
      "source-layer": sourceLayer,
      ...(filter && { filter }),
      paint,
    }) as LayerSpecification;
  const symbol = (id: string, sourceLayer: string, spec: Partial<SymbolLayerSpecification>) =>
    ({
      id: p + id,
      type: "symbol",
      source: src.base,
      "source-layer": sourceLayer,
      ...spec,
    }) as LayerSpecification;

  // Significance-ranked labels arrive in three zoom bands: only the biggest features at low
  // zoom, everything from z10. rank is per 0.25 degree cell (peaks by elevation, lakes by area).
  const banded = (
    id: string,
    sourceLayer: string,
    bands: [suffix: string, bandMin: number, maxrank: number][],
    spec: (filter: FilterSpecification) => Partial<SymbolLayerSpecification>,
  ) =>
    bands.map(([suffix, bandMin, maxrank]) =>
      symbol(id + suffix, sourceLayer, {
        ...spec(["<=", ["coalesce", ["get", "rank"], 1], maxrank] as FilterSpecification),
        minzoom: bandMin,
        ...(suffix !== "-all" && { maxzoom: bandMin === 0 ? 9 : 10 }),
      }),
    );

  return [
    fill("earth", "earth", { "fill-color": EARTH }),
    fill("landcover", "landcover", { "fill-color": landcoverColor }),
    fill("glacier", "landuse", { "fill-color": "#f2f8fc", "fill-opacity": 0.9 }, ["==", ["get", "kind"], "glacier"]),
    fill("bare-rock", "landuse", { "fill-color": "#cdc7bd", "fill-opacity": 0.7 }, ["==", ["get", "kind"], "bare_rock"]),
    {
      id: p + "hillshade",
      type: "raster",
      source: src.hillshade,
      paint: { "raster-opacity": 0.55, "raster-contrast": 0.25, "raster-resampling": "linear" },
    },
    fill("water", "water", { "fill-color": WATER }, ["==", ["geometry-type"], "Polygon"]),
    {
      id: p + "rivers",
      type: "line",
      source: src.base,
      "source-layer": "water",
      filter: ["==", ["geometry-type"], "LineString"],
      paint: { "line-color": WATER, "line-width": ["interpolate", ["linear"], ["zoom"], 9, 0.8, 12, 2] },
    },
    {
      id: p + "boundaries-region",
      type: "line",
      source: src.base,
      "source-layer": "boundaries",
      filter: ["!=", ["get", "kind"], "country"],
      paint: { "line-color": "#9b909b", "line-width": 0.8, "line-dasharray": [3, 2] },
    },
    {
      id: p + "boundaries-country",
      type: "line",
      source: src.base,
      "source-layer": "boundaries",
      filter: ["==", ["get", "kind"], "country"],
      paint: { "line-color": "#8a7f8a", "line-width": 1.4 },
    },
    ...banded("water-labels", "water_labels", [["", 0, 2], ["-mid", 9, 5], ["-all", 10, 99]], (filter) => ({
      filter,
      layout: { "text-field": ["get", "name"], "text-font": ["Noto Sans Italic"], "text-size": 12, "text-padding": 8 },
      paint: { "text-color": "#4a7ba6", ...halo },
    })),
    symbol("glacier-labels", "glacier_labels", {
      layout: { "text-field": ["get", "name"], "text-font": ["Noto Sans Italic"], "text-size": 12 },
      paint: { "text-color": "#6a94b8", ...halo },
    }),
    ...banded("peaks", "peaks", [["", 0, 2], ["-mid", 9, 6], ["-all", 10, 99]], (filter) => ({
      filter,
      layout: {
        "icon-image": "peak-triangle",
        "icon-size": 1,
        "text-optional": true,
        "text-field": peakText,
        "text-font": ["Noto Sans Medium"],
        "text-size": 12,
        "text-anchor": "top",
        "text-offset": [0, 0.6],
        "text-padding": 14,
        "symbol-sort-key": ["-", 9000, ["coalesce", ["get", "ele"], 0]],
      },
      paint: { "text-color": "#5a4636", ...halo },
    })),
    symbol("places-city", "places", {
      filter: ["==", ["get", "kind"], "locality"],
      layout: {
        "text-field": nameEn,
        "text-font": ["Noto Sans Regular"],
        "text-size": 12,
        "symbol-sort-key": ["coalesce", ["get", "min_zoom"], 10],
      },
      paint: { "text-color": "#3d3a38", ...halo },
    }),
    symbol("places-region", "places", {
      filter: ["==", ["get", "kind"], "region"],
      layout: {
        "text-field": nameEn,
        "text-font": ["Noto Sans Regular"],
        "text-size": 12,
        "text-transform": "uppercase",
        "text-letter-spacing": 0.1,
      },
      paint: { "text-color": "#8a847e", ...halo },
    }),
    symbol("places-country", "places", {
      filter: ["==", ["get", "kind"], "country"],
      layout: {
        "text-field": nameEn,
        "text-font": ["Noto Sans Medium"],
        "text-size": 14,
        "text-transform": "uppercase",
      },
      paint: { "text-color": "#54504e", ...halo },
    }),
  ];
}

// The full basemap style: the online z10 archive pair and its layer stack. Overlays (the stats
// map's request points) are the caller's to append, on top.
export function basemapStyle(): StyleSpecification {
  return {
    version: 8,
    glyphs: GLYPHS,
    sources: {
      "online-base": {
        type: "vector",
        url: `pmtiles://${BASEMAP_URL}/global-base.pmtiles`,
        maxzoom: DATA_MAX_ZOOM,
      },
      "online-hs": {
        type: "raster",
        url: `pmtiles://${BASEMAP_URL}/global-hs.pmtiles`,
        tileSize: 512,
        maxzoom: DATA_MAX_ZOOM,
      },
    },
    layers: [
      { id: "background", type: "background", paint: { "background-color": WATER } },
      ...stack("o-", { base: "online-base", hillshade: "online-hs" }),
    ],
  };
}
