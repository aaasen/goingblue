import { MODELS as M, type ModelSpec } from "./attribution.js";

// Model-selector help copy, shared by the app's Weather Model info sheet and the site's FAQ: the
// option's label, the center behind it, and the models it serves, highest resolution first, which
// is the order they serve in, so the list reads as the blend outward that Auto's line describes.
// Names and horizons come off the specs, keeping this text saying what the meteogram's band labels
// say; only the region is written here.
export interface ModelInfoEntry { spec: ModelSpec; region: string }

export const MODEL_INFO: Array<{ name: string; desc: string; models: ModelInfoEntry[] }> = [
  {
    name: "Auto",
    desc: "Chooses the highest resolution model for your location from over 30 regional weather "
      + "models. Seamlessly blends to lower-resolution global models at longer time horizons.",
    models: [],
  },
  {
    name: "NOAA",
    desc: "US National Oceanic and Atmospheric Administration",
    models: [
      { spec: M.gfs_hrrr, region: "continental US" },
      { spec: M.gfs_global, region: "global" },
    ],
  },
  {
    name: "GEM",
    desc: "Environment and Climate Change Canada",
    models: [
      { spec: M.gem_hrdps_continental, region: "Canada and the northern US" },
      { spec: M.gem_regional, region: "North America" },
      { spec: M.gem_global, region: "global" },
    ],
  },
  {
    name: "ECMWF",
    desc: "European Centre for Medium-Range Weather Forecasts",
    models: [{ spec: M.ecmwf_ifs, region: "global" }],
  },
  {
    name: "ICON",
    desc: "Deutscher Wetterdienst (Germany)",
    models: [
      { spec: M.icon_d2, region: "central Europe" },
      { spec: M.icon_eu, region: "Europe" },
      { spec: M.icon_global, region: "global" },
    ],
  },
];

// A spec's horizon in the units the reader thinks in: hours while a run is short enough to plan
// an outing around, days once it isn't. Halves survive the switch (ICON Global's 7.5 days).
export function horizonText(hours: number): string {
  if (hours < 96) return `${hours} hours`;
  const days = hours / 24;
  return `${Number.isInteger(days) ? days : days.toFixed(1)} days`;
}

export const OPEN_METEO_DOCS = "https://open-meteo.com/en/docs#data_sources";
