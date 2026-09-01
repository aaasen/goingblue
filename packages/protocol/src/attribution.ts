/**
 * Predicts which weather model Open-Meteo serves for a given coordinate and forecast hour, for
 * each of the app's model-selector options: `best` (best_match) and the US/CA/EU/DE center
 * stacks (gfs_seamless / gem_seamless / ecmwf_ifs / icon_seamless — see codec-server
 * MODEL_CONFIG). Open-Meteo does
 * not expose this; it is inferred by replicating the server's routing, which is two mechanisms
 * (verified against open-meteo/open-meteo @ 5fcb532,
 * Sources/App/Controllers/ForecastapiController.swift):
 *
 *  1. A hardcoded region cascade picks an ordered reader list per coordinate — lat/lon
 *     rectangles plus "does this model's grid contain the point" probes (first match wins).
 *  2. Per variable and timestep, the highest-priority reader wins; NaN gaps (point outside a
 *     grid, hour past a model's horizon, variable absent) fall through to the next reader,
 *     blended over 3 timesteps at each seam (GenericReaderMulti.get / integrateIfNaNSmooth).
 *
 * So attribution = first model in the branch list that covers the point and still has data at
 * that hour. Grid geometries, projection math, and horizons below are transcribed from the
 * Swift domain definitions (Sources/App/<Center>/<Domain>.swift).
 *
 * Known approximations:
 *  - Elevation-file masking is not replicated: a grid can contain a point that the model masks
 *    out (all-NaN cell). Bounds-only coverage may then over-claim the local model.
 *  - Horizon boundaries depend on the age of the last full-length run, so a predicted
 *    transition can drift by up to `runIntervalHours` (+ delay estimation error).
 *  - The 3-step blend at every seam means the 3 hours after a transition mix two models.
 */

const DEG = Math.PI / 180;

export interface Projection {
  forward(lat: number, lon: number): { x: number; y: number };
}

/** Lambert conformal conic, spherical, single standard parallel (ϕ1 == ϕ2 in every domain used). */
export function lambertConformal(
  lambda0: number,
  phi0: number,
  phi1: number,
  radius: number,
): Projection {
  const l0 = (((lambda0 + 180) % 360) - 180) * DEG;
  const p0 = phi0 * DEG;
  const p1 = phi1 * DEG;
  const n = Math.sin(p1);
  const F = (Math.cos(p1) * Math.pow(Math.tan(Math.PI / 4 + p1 / 2), n)) / n;
  const rho0 = F / Math.pow(Math.tan(Math.PI / 4 + p0 / 2), n);
  return {
    forward(lat, lon) {
      const theta = n * (lon * DEG - l0);
      const p = F / Math.pow(Math.tan(Math.PI / 4 + (lat * DEG) / 2), n);
      return {
        x: radius * p * Math.sin(theta),
        y: radius * (rho0 - p * Math.cos(theta)),
      };
    },
  };
}

/** Lambert azimuthal equal-area, spherical (UKMO UKV). */
export function lambertAzimuthal(lambda0: number, phi1: number, radius: number): Projection {
  const l0 = lambda0 * DEG;
  const p1 = phi1 * DEG;
  return {
    forward(lat, lon) {
      const phi = lat * DEG;
      const dl = lon * DEG - l0;
      const k = Math.sqrt(2 / (1 + Math.sin(p1) * Math.sin(phi) + Math.cos(p1) * Math.cos(phi) * Math.cos(dl)));
      return {
        x: radius * k * Math.cos(phi) * Math.sin(dl),
        y: radius * k * (Math.cos(p1) * Math.sin(phi) - Math.sin(p1) * Math.cos(phi) * Math.cos(dl)),
      };
    },
  };
}

/**
 * Rotated lat/lon, spherical (GEM RDPS/HRDPS). `forward` returns rotated coordinates in
 * DEGREES (x = rotated longitude, y = rotated latitude), matching the Swift implementation,
 * so grids over this projection use degree-valued origin/dx/dy.
 */
export function rotatedLatLon(latitude: number, longitude: number): Projection {
  const theta = (90 + latitude) * DEG;
  const phi = longitude * DEG;
  return {
    forward(lat, lon) {
      const lonR = lon * DEG;
      const latR = lat * DEG;
      const x = Math.cos(lonR) * Math.cos(latR);
      const y = Math.sin(lonR) * Math.cos(latR);
      const z = Math.sin(latR);
      const x2 = Math.cos(theta) * Math.cos(phi) * x + Math.cos(theta) * Math.sin(phi) * y + Math.sin(theta) * z;
      const y2 = -Math.sin(phi) * x + Math.cos(phi) * y;
      const z2 = -Math.sin(theta) * Math.cos(phi) * x - Math.sin(theta) * Math.sin(phi) * y + Math.cos(theta) * z;
      return { x: -Math.atan2(y2, x2) / DEG, y: -Math.asin(z2) / DEG };
    },
  };
}

export interface Grid {
  contains(lat: number, lon: number): boolean;
}

/** Regular lat/lon grid; replicates RegularGrid.findPointXy (round to nearest cell, reject outside). */
export function regularGrid(
  nx: number,
  ny: number,
  latMin: number,
  lonMin: number,
  dx: number,
  dy: number,
): Grid {
  return {
    contains(lat, lon) {
      const x = Math.round((lon - lonMin) / dx);
      const y = Math.round((lat - latMin) / dy);
      return x >= 0 && x < nx && y >= 0 && y < ny;
    },
  };
}

const GLOBAL_GRID: Grid = { contains: () => true };

/** Projected grid with explicit projected-metre origin (ProjectionGrid.findPointXy). */
export function projectionGrid(
  nx: number,
  ny: number,
  origin: { x: number; y: number },
  dx: number,
  dy: number,
  proj: Projection,
): Grid {
  return {
    contains(lat, lon) {
      const p = proj.forward(lat, lon);
      const x = Math.round((p.x - origin.x) / dx);
      const y = Math.round((p.y - origin.y) / dy);
      return x >= 0 && x < nx && y >= 0 && y < ny;
    },
  };
}

/** Projected grid initialised from SW/NE corner coordinates (the range-based Swift init). */
export function projectionGridFromCorners(
  nx: number,
  ny: number,
  latRange: [number, number],
  lonRange: [number, number],
  proj: Projection,
): Grid {
  const sw = proj.forward(latRange[0], lonRange[0]);
  const ne = proj.forward(latRange[1], lonRange[1]);
  return projectionGrid(nx, ny, sw, (ne.x - sw.x) / (nx - 1), (ne.y - sw.y) / (ny - 1), proj);
}

// --- Grids used by the best_match cascade (transcribed from the Swift `grid` properties) ---

const GRIDS = {
  icon_d2: regularGrid(1215, 746, 43.18, -3.94, 0.02, 0.02),
  icon_eu: regularGrid(1377, 657, 29.5, -23.5, 0.0625, 0.0625),
  arome_france_hd: regularGrid(2801, 1791, 37.5, -12.0, 0.01, 0.01),
  arome_france: regularGrid(1121, 717, 37.5, -12.0, 0.025, 0.025),
  arpege_europe: regularGrid(741, 521, 20, -32, 0.1, 0.1),
  jma_msm: regularGrid(481, 505, 22.4, 120, 0.0625, 0.05),
  knmi_netherlands: regularGrid(390, 390, 49, 0, 0.029, 0.018),
  hrrr: projectionGridFromCorners(
    1799,
    1059,
    [21.138, 47.8424],
    [-122.72, -60.918],
    lambertConformal(-97.5, 0, 38.5, 6371229),
  ),
  metno_nordic: projectionGridFromCorners(
    1796,
    2321,
    [52.30272, 72.18527],
    [1.9184653, 41.764282],
    lambertConformal(15, 63, 63, 6371229),
  ),
  dmi_europe: (() => {
    const proj = lambertConformal(352, 55.5, 55.5, 6371229);
    return projectionGrid(1906, 1606, proj.forward(39.671, -25.421997), 2000, 2000, proj);
  })(),
  ukmo_ukv: projectionGrid(
    1042,
    970,
    { x: -1158000, y: -1036000 },
    2000,
    2000,
    lambertAzimuthal(-2.5, 54.9, 6371229),
  ),
  gem_hrdps: projectionGridFromCorners(
    2540,
    1290,
    [39.626034, 47.876457],
    [-133.62952, -40.708557],
    rotatedLatLon(-36.0885, 245.305),
  ),
  // RDPS origin/dx are already in rotated-projection degrees (see the Swift comment)
  gem_rdps: projectionGrid(
    1140,
    1045,
    { x: 306.141 - 360, y: -48.806 },
    0.090298,
    0.090298,
    rotatedLatLon(31.7583, 87.597),
  ),
};

export interface ModelSpec {
  /** Open-Meteo `models=` parameter name, usable to fetch this model individually. */
  id: string;
  label: string;
  /**
   * Display name for UI segments/subtext. The AROME 15-min domains share their parent's short
   * label deliberately: they are the same model on a faster assimilation cycle, so adjacent
   * segments merge when rendered by shortLabel.
   */
  shortLabel: string;
  /** Approximate native resolution in km, for display. */
  resKm: number;
  grid: Grid;
  /** Forecast length (hours from run initialisation) of the longest runs. */
  horizonHours: number;
  /** Cadence of the runs that reach `horizonHours` (shorter interleaved runs only refresh near hours). */
  runIntervalHours: number;
  /** Approximate delay between run initialisation and the full run being live on the API. */
  delayHours: number;
}

const spec = (
  id: string,
  shortLabel: string,
  resKm: number,
  label: string,
  grid: Grid,
  horizonHours: number,
  runIntervalHours: number,
  delayHours: number,
): ModelSpec => ({ id, label, shortLabel, resKm, grid, horizonHours, runIntervalHours, delayHours });

// Horizons/cadences from the Swift domain definitions, with horizons/delays calibrated against
// live behaviour (2026-08-14 validation run): ECMWF now serves ~15 days on both feeds; UKMO
// global, ARPEGE, AROME, and JMA MSM reach their full horizon only on the 00z/12z runs. Past
// hours are always covered by every domain — the .om files are a continuous rolling archive.
export const MODELS = {
  ecmwf_ifs: spec("ecmwf_ifs", "IFS", 9, "ECMWF IFS HRES 9km", GLOBAL_GRID, 360, 12, 8),
  ecmwf_ifs025: spec("ecmwf_ifs025", "IFS 0.25°", 25, "ECMWF IFS 0.25°", GLOBAL_GRID, 360, 12, 8),
  icon_global: spec("icon_global", "ICON", 13, "DWD ICON 13km", GLOBAL_GRID, 180, 12, 4),
  icon_eu: spec("icon_eu", "ICON-EU", 7, "DWD ICON-EU 7km", GRIDS.icon_eu, 120, 6, 4),
  icon_d2: spec("icon_d2", "ICON-D2", 2, "DWD ICON-D2 2km", GRIDS.icon_d2, 48, 3, 3),
  gfs_global: spec("gfs_global", "GFS", 13, "NOAA GFS 13km", GLOBAL_GRID, 384, 6, 5),
  gfs_hrrr: spec("gfs_hrrr", "HRRR", 3, "NOAA HRRR 3km", GRIDS.hrrr, 48, 6, 2),
  jma_msm: spec("jma_msm", "MSM", 5, "JMA MSM 5km", GRIDS.jma_msm, 78, 12, 3),
  meteofrance_arome_france_hd_15min: spec(
    "meteofrance_arome_france_hd_15min",
    "AROME-HD",
    1.3,
    "Météo-France AROME HD (15-min run)",
    GRIDS.arome_france_hd,
    6,
    1,
    2,
  ),
  meteofrance_arome_france_15min: spec(
    "meteofrance_arome_france_15min",
    "AROME",
    2.5,
    "Météo-France AROME (15-min run)",
    GRIDS.arome_france,
    6,
    1,
    2,
  ),
  meteofrance_arome_france_hd: spec(
    "meteofrance_arome_france_hd",
    "AROME-HD",
    1.3,
    "Météo-France AROME HD 1.3km",
    GRIDS.arome_france_hd,
    51,
    12,
    4,
  ),
  meteofrance_arome_france: spec(
    "meteofrance_arome_france",
    "AROME",
    2.5,
    "Météo-France AROME 2.5km",
    GRIDS.arome_france,
    51,
    12,
    4,
  ),
  meteofrance_arpege_europe: spec(
    "meteofrance_arpege_europe",
    "ARPEGE",
    11,
    "Météo-France ARPEGE Europe 11km",
    GRIDS.arpege_europe,
    114,
    12,
    9,
  ),
  knmi_harmonie_arome_netherlands: spec(
    "knmi_harmonie_arome_netherlands",
    "KNMI",
    2,
    "KNMI Harmonie AROME NL 2km",
    GRIDS.knmi_netherlands,
    60,
    1,
    3,
  ),
  metno_nordic: spec("metno_nordic", "MetNo", 1, "MET Norway Nordic 1km", GRIDS.metno_nordic, 60, 1, 2),
  dmi_harmonie_arome_europe: spec(
    "dmi_harmonie_arome_europe",
    "DMI",
    2,
    "DMI Harmonie AROME Europe 2km",
    GRIDS.dmi_europe,
    60,
    3,
    3,
  ),
  ukmo_uk_deterministic_2km: spec(
    "ukmo_uk_deterministic_2km",
    "UKV",
    2,
    "UK Met Office UKV 2km",
    GRIDS.ukmo_ukv,
    54,
    1,
    5,
  ),
  ukmo_global_deterministic_10km: spec(
    "ukmo_global_deterministic_10km",
    "UKMO",
    10,
    "UK Met Office Global 10km",
    GLOBAL_GRID,
    168,
    12,
    9,
  ),
  // GEM cadences/horizons from GemDomain.swift: GDPS 00z/12z to 240h (full run live ~6h30 after
  // init); RDPS and HRDPS every 6h to 78h/48h (~3h delay).
  gem_hrdps_continental: spec(
    "gem_hrdps_continental",
    "HRDPS",
    2.5,
    "Canada HRDPS 2.5km",
    GRIDS.gem_hrdps,
    48,
    6,
    3,
  ),
  gem_regional: spec("gem_regional", "RDPS", 10, "Canada RDPS 10km", GRIDS.gem_rdps, 78, 6, 3),
  gem_global: spec("gem_global", "GDPS", 15, "Canada GDPS 15km", GLOBAL_GRID, 240, 12, 7),
} as const;

export interface BranchPrediction {
  /** Which cascade branch matched (mirrors the comments in ForecastapiController.swift). */
  branch: string;
  /** Surface-variable readers, highest priority first (probability/UV-only readers excluded). */
  models: ModelSpec[];
}

const inRect = (
  lat: number,
  lon: number,
  latRange: [number, number],
  lonRange: [number, number],
): boolean => lat >= latRange[0] && lat < latRange[1] && lon >= lonRange[0] && lon < lonRange[1];

/** RegionGeometry.isInUKVArea: UK rectangle minus the English-Channel triangle kept for France. */
export function isInUkvArea(lat: number, lon: number): boolean {
  if (!inRect(lat, lon, [49.9, 61], [-11, 1.8])) return false;
  const tri: Array<[number, number]> = [
    [49.9, -0.2],
    [49.9, 1.8],
    [51.1, 1.8],
  ];
  const cross = (a: [number, number], b: [number, number]) =>
    (lon - a[1]) * (b[0] - a[0]) - (lat - a[0]) * (b[1] - a[1]);
  const d1 = cross(tri[0], tri[1]);
  const d2 = cross(tri[1], tri[2]);
  const d3 = cross(tri[2], tri[0]);
  const inTriangle = !((d1 < 0 || d2 < 0 || d3 < 0) && (d1 > 0 || d2 > 0 || d3 > 0));
  return !inTriangle;
}

/**
 * The `best_match` cascade for hourly surface variables, branches in source order. Reader lists
 * in the Swift source are lowest-priority-first and consumed reversed; these are already
 * highest-first.
 */
export function predictBestMatch(lat: number, lon: number): BranchPrediction {
  const p = predictBranch(lat, lon);
  // Branch membership nearly always implies coverage, but filter regional grids anyway so a
  // point near a grid edge can't be attributed to a model whose reader would fail to init.
  return { branch: p.branch, models: p.models.filter((m) => m.grid.contains(lat, lon)) };
}

function predictBranch(lat: number, lon: number): BranchPrediction {
  const M = MODELS;
  // Netherlands/Belgium: KNMI + IFS + ICON
  if (inRect(lat, lon, [49.35, 53.79], [2.19, 7.66]) && GRIDS.knmi_netherlands.contains(lat, lon)) {
    return {
      branch: "netherlands-knmi",
      models: [M.knmi_harmonie_arome_netherlands, M.ecmwf_ifs, M.ecmwf_ifs025, M.icon_d2, M.icon_eu, M.icon_global],
    };
  }
  // Scandinavia: MetNo Nordic + IFS (via the metno_seamless mapping)
  if (lat >= 54.9 && GRIDS.metno_nordic.contains(lat, lon)) {
    return {
      branch: "nordic-metno",
      models: [M.metno_nordic, M.ecmwf_ifs, M.ecmwf_ifs025],
    };
  }
  // UK: UKV + UKMO global + IFS
  if (isInUkvArea(lat, lon)) {
    return {
      branch: "uk-ukmo",
      models: [M.ukmo_uk_deterministic_2km, M.ukmo_global_deterministic_10km, M.ecmwf_ifs, M.ecmwf_ifs025],
    };
  }
  // Central Europe: ICON-D2 available
  if (GRIDS.icon_d2.contains(lat, lon)) {
    return {
      branch: "central-europe-icon-d2",
      models: [M.icon_d2, M.icon_eu, M.icon_global, M.ecmwf_ifs, M.gfs_global],
    };
  }
  // Western Europe: AROME models (the 15-min domains DO serve hourly queries, aggregated,
  // for their first ~6 hours — they are added unconditionally in this branch)
  if (inRect(lat, lon, [42.1, 51.32], [-6.18, 8.35]) && GRIDS.arome_france_hd.contains(lat, lon)) {
    return {
      branch: "france-arome",
      models: [
        M.meteofrance_arome_france_hd_15min,
        M.meteofrance_arome_france_15min,
        M.meteofrance_arome_france_hd,
        M.meteofrance_arome_france,
        M.meteofrance_arpege_europe,
        M.ecmwf_ifs,
        M.icon_global,
        M.gfs_global,
      ],
    };
  }
  // Northern Europe / Iceland: DMI Harmonie
  if (lat >= 44 && lat < 66 && GRIDS.dmi_europe.contains(lat, lon)) {
    return {
      branch: "northern-europe-dmi",
      models: [M.dmi_harmonie_arome_europe, M.ecmwf_ifs, M.ecmwf_ifs025, M.icon_eu, M.icon_global, M.gfs_global],
    };
  }
  // North America: HRRR (note: no ECMWF in this branch)
  if (GRIDS.hrrr.contains(lat, lon)) {
    return {
      branch: "conus-hrrr",
      models: [M.gfs_hrrr, M.gfs_global, M.icon_global],
    };
  }
  // Japan: JMA MSM (surface; the msm_upper_level reader only carries pressure-level variables)
  if (inRect(lat, lon, [27.4, 37.65], [125, 145]) && GRIDS.jma_msm.contains(lat, lon)) {
    return {
      branch: "japan-jma-msm",
      models: [M.jma_msm, M.ecmwf_ifs, M.icon_global, M.gfs_global],
    };
  }
  // Remaining Europe: ICON-EU
  if (GRIDS.icon_eu.contains(lat, lon)) {
    return {
      branch: "europe-icon-eu",
      models: [M.icon_eu, M.icon_global, M.ecmwf_ifs, M.gfs_global],
    };
  }
  // Rest of the world
  return {
    branch: "global-fallback",
    models: [M.ecmwf_ifs, M.icon_global, M.gfs_global],
  };
}

/** The app's model-selector options (MODEL_BIT keys, lowercase). */
export type Center = "best" | "us" | "ca" | "eu" | "de";

/**
 * Predict the serving-model stack for any selector option. `best` runs the best_match cascade;
 * the centers mirror codec-server's MODEL_CONFIG: US = gfs_seamless (HRRR then GFS), CA =
 * gem_seamless (HRDPS > RDPS > GDPS), EU = ecmwf_ifs, DE = icon_seamless
 * (ICON-D2 > ICON-EU > ICON). Note EU pressure-level variables
 * (500/600/700 hPa winds) come from ecmwf_ifs025, not HRES — the one per-variable split among
 * the center stacks.
 */
export function predictCenter(center: Center, lat: number, lon: number): BranchPrediction {
  const M = MODELS;
  switch (center) {
    case "best":
      return predictBestMatch(lat, lon);
    case "us":
      return {
        branch: "us-gfs-seamless",
        models: [M.gfs_hrrr, M.gfs_global].filter((m) => m.grid.contains(lat, lon)),
      };
    case "ca":
      return {
        branch: "ca-gem-seamless",
        models: [M.gem_hrdps_continental, M.gem_regional, M.gem_global].filter((m) =>
          m.grid.contains(lat, lon),
        ),
      };
    case "eu":
      return { branch: "eu-ecmwf-ifs", models: [M.ecmwf_ifs] };
    case "de":
      return {
        branch: "de-icon-seamless",
        models: [M.icon_d2, M.icon_eu, M.icon_global].filter((m) => m.grid.contains(lat, lon)),
      };
  }
}

/** Estimated initialisation time (ms epoch) of the newest full-length run live on the API. */
export function estimatedLastFullRunMs(model: ModelSpec, nowMs: number): number {
  const intervalMs = model.runIntervalHours * 3600_000;
  return Math.floor((nowMs - model.delayHours * 3600_000) / intervalMs) * intervalMs;
}

export interface HourAttribution {
  /** Predicted serving model, or null when no model in the branch has data (past the last horizon). */
  model: ModelSpec | null;
  /** Model that takes over at the next transition (the seam blends the two over 3 hours). */
  next: ModelSpec | null;
  /** Hours by which this transition may drift (run-age uncertainty of `model`). */
  toleranceHours: number;
}

/**
 * Attribute one forecast timestamp: the first model in priority order whose data extends to it.
 * Past timestamps are covered by every model (the .om store is a continuous archive), so only
 * the forward horizon matters.
 */
export function attributeHour(
  models: ModelSpec[],
  timeMs: number,
  nowMs: number,
): HourAttribution {
  for (let i = 0; i < models.length; i++) {
    const m = models[i];
    const run = estimatedLastFullRunMs(m, nowMs);
    const end = run + m.horizonHours * 3600_000;
    if (timeMs <= end) {
      const next = models
        .slice(i + 1)
        .find((n) => estimatedLastFullRunMs(n, nowMs) + n.horizonHours * 3600_000 > end);
      return { model: m, next: next ?? null, toleranceHours: m.runIntervalHours };
    }
  }
  return { model: null, next: null, toleranceHours: 0 };
}
