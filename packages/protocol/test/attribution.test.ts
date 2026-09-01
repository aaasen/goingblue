import { describe, it, expect } from "vitest";
import {
  MODELS,
  attributeHour,
  isInUkvArea,
  predictBestMatch,
  predictCenter,
} from "../src/index.js";

// Branch assignments and grid containment below were verified against the live API on
// 2026-08-14 (scripts/validate-model-attribution.ts in codec-server: 99.85% of hours
// consistent, 0 branch failures). These tests freeze that verified geometry — a failure means
// a projection or cascade edit changed which model a location resolves to.

describe("best_match cascade", () => {
  const cases: Array<[string, number, number, string, string]> = [
    // name, lat, lon, expected branch, expected top model
    ["Netherlands", 52.705, 5.227, "netherlands-knmi", "knmi_harmonie_arome_netherlands"],
    ["Lom, Norway", 61.635, 8.313, "nordic-metno", "metno_nordic"],
    ["Wales", 52.366, -3.699, "uk-ukmo", "ukmo_uk_deterministic_2km"],
    ["Chamonix", 45.879, 6.888, "central-europe-icon-d2", "icon_d2"],
    ["Brittany", 48.392, -4.873, "france-arome", "meteofrance_arome_france_hd_15min"],
    ["Iceland", 64.097, -20.78, "northern-europe-dmi", "dmi_harmonie_arome_europe"],
    ["Romania (DMI reach)", 47.137, 22.024, "northern-europe-dmi", "dmi_harmonie_arome_europe"],
    ["WA Cascades", 48.515, -120.658, "conus-hrrr", "gfs_hrrr"],
    ["Honshu", 35.254, 137.297, "japan-jma-msm", "jma_msm"],
    ["Anatolia", 38.669, 32.147, "europe-icon-eu", "icon_eu"],
    ["Denali", 63.069, -151.003, "global-fallback", "ecmwf_ifs"],
    ["El Chaltén", -49.272, -73.042, "global-fallback", "ecmwf_ifs"],
  ];
  for (const [name, lat, lon, branch, top] of cases) {
    it(`routes ${name} to ${branch}`, () => {
      const p = predictBestMatch(lat, lon);
      expect(p.branch).toBe(branch);
      expect(p.models[0].id).toBe(top);
    });
  }

  it("cuts the English Channel out of the UKV area", () => {
    expect(isInUkvArea(52, -1)).toBe(true);
    // In the Channel triangle: excluded from UKV, and since the ICON-D2 branch precedes the
    // France branch in the cascade, the cutout falls to ICON-D2 (whose grid reaches -3.94°E).
    expect(isInUkvArea(50.3, 1.0)).toBe(false);
    expect(predictBestMatch(50.3, 1.0).branch).toBe("central-europe-icon-d2");
  });
});

describe("center stacks", () => {
  it("US is HRRR then GFS inside CONUS, GFS alone outside", () => {
    expect(predictCenter("us", 48.515, -120.658).models.map((m) => m.id)).toEqual([
      "gfs_hrrr",
      "gfs_global",
    ]);
    expect(predictCenter("us", 63.069, -151.003).models.map((m) => m.id)).toEqual(["gfs_global"]);
  });

  it("CA is the GEM ladder; RDPS (not HRDPS) reaches Denali", () => {
    expect(predictCenter("ca", 51.302, -117.52).models.map((m) => m.id)).toEqual([
      "gem_hrdps_continental",
      "gem_regional",
      "gem_global",
    ]);
    expect(predictCenter("ca", 63.069, -151.003).models.map((m) => m.id)).toEqual([
      "gem_regional",
      "gem_global",
    ]);
  });

  it("EU is IFS HRES everywhere", () => {
    expect(predictCenter("eu", -49.272, -73.042).models.map((m) => m.id)).toEqual(["ecmwf_ifs"]);
  });

  it("DE is the ICON ladder in the Alps, ICON global alone at Denali", () => {
    expect(predictCenter("de", 45.923, 6.87).models.map((m) => m.id)).toEqual([
      "icon_d2",
      "icon_eu",
      "icon_global",
    ]);
    expect(predictCenter("de", 63.069, -151.003).models.map((m) => m.id)).toEqual(["icon_global"]);
  });
});

describe("attributeHour", () => {
  // Fixed clock: 2026-08-14 20:00 UTC. HRRR's last full run (48h, every 6h, ~2h delay) is 18z,
  // so its data ends 18z + 48h; GFS (384h) carries the tail.
  const now = Date.UTC(2026, 7, 14, 20);
  const stack = [MODELS.gfs_hrrr, MODELS.gfs_global];

  it("serves the near range from the local model and hands off at its horizon", () => {
    const nearTerm = attributeHour(stack, Date.UTC(2026, 7, 15, 12), now);
    expect(nearTerm.model?.id).toBe("gfs_hrrr");
    expect(nearTerm.next?.id).toBe("gfs_global");
    const hrrrEnd = Date.UTC(2026, 7, 14, 18) + 48 * 3600_000;
    expect(attributeHour(stack, hrrrEnd, now).model?.id).toBe("gfs_hrrr");
    expect(attributeHour(stack, hrrrEnd + 3600_000, now).model?.id).toBe("gfs_global");
  });

  it("covers past hours with the top model and runs dry past every horizon", () => {
    expect(attributeHour(stack, now - 18 * 3600_000, now).model?.id).toBe("gfs_hrrr");
    expect(attributeHour(stack, now + 500 * 3600_000, now).model).toBeNull();
  });
});
