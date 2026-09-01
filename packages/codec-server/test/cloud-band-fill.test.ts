import { describe, expect, it } from "vitest";
import { CLOUD_BAND_LEVELS_HPA, CLOUD_COVER_MIN_PCT, quantCover } from "@weather/protocol";
import {
  fillCloudBand, repairCloudBand, rhCritical, sundqvistCover, type HourlyData,
} from "../src/forecast.js";

// One hour, one level stack. Every case here is a single hour: the fill is per-hour by
// construction (it runs before the maxOf aggregation), so an hour is the whole unit of behavior.
//
// Standard-atmosphere geopotential heights, used wherever a case isn't specifically about band
// assignment. 700 hPa sits at ~3010 m — just inside "mid" — which is exactly the coin-flip the
// per-hour height lookup exists to resolve; the flip case below moves it deliberately.
const STD_HEIGHT_M: Record<number, number> = {
  200: 11785, 250: 10360, 300: 9160, 400: 7185, 500: 5575, 600: 4205, 700: 3010, 850: 1460,
  925: 765, 1000: 110,
};

interface Case {
  rh?: Record<number, number | null>;
  height?: Record<number, number | null>;
  cover?: Record<number, number | null>; // pre-existing cloud_cover_XhPa, for the no-humidity path
  low?: number | null;
  mid?: number | null;
  high?: number | null;
}

function hourly(c: Case): HourlyData {
  const h: Record<string, unknown[]> = {
    time: ["2026-08-19T00:00"],
    cloud_cover_low: [c.low ?? null],
    cloud_cover_mid: [c.mid ?? null],
    cloud_cover_high: [c.high ?? null],
  };
  for (const l of CLOUD_BAND_LEVELS_HPA) {
    if (c.rh && l in c.rh) h[`relative_humidity_${l}hPa`] = [c.rh[l]];
    if (c.cover && l in c.cover) h[`cloud_cover_${l}hPa`] = [c.cover[l]];
    const z = c.height && l in c.height ? c.height[l] : STD_HEIGHT_M[l];
    h[`geopotential_height_${l}hPa`] = [z];
  }
  return h as unknown as HourlyData;
}

// The filled band for the single hour, indexed by pressure level. `elevM` keys the high
// placement's carried-level restriction (cloudBandLevelRange); the default sea level carries
// [300..1000], so 250/200 are cropped and the integral folds into 300.
function band(c: Case, elevM = 0): Record<number, number | null> {
  const out = fillCloudBand(hourly(c), elevM) as unknown as Record<string, (number | null)[]>;
  return Object.fromEntries(
    CLOUD_BAND_LEVELS_HPA.map((l) => [l, out[`cloud_cover_${l}hPa`]?.[0] ?? null]),
  );
}

const stack = (b: Record<number, number | null>) => CLOUD_BAND_LEVELS_HPA.map((l) => b[l]);

describe("Sundqvist port", () => {
  // Against the constants in open-meteo/Sources/App/Helper/Meteorology.swift: the threshold is
  // 0.9 at the 1013.25 hPa reference and decays to a1 = 0.7 aloft.
  it("reproduces the critical-humidity profile", () => {
    expect(rhCritical(1013.25)).toBeCloseTo(0.9, 10);
    expect(rhCritical(1000)).toBeCloseTo(0.8895, 4);
    expect(rhCritical(925)).toBeCloseTo(0.8288, 4);
    expect(rhCritical(850)).toBeCloseTo(0.7722, 4);
    expect(rhCritical(700)).toBeCloseTo(0.7067, 4);
    expect(rhCritical(300)).toBeCloseTo(0.7, 4);
  });

  // The hard floor at rhCrit is the whole reason the fill exists — reproduce it, don't soften it.
  it("clips to exactly zero at and below the critical humidity", () => {
    expect(sundqvistCover(88.9, rhCritical(1000))).toBe(0);
    expect(sundqvistCover(70, rhCritical(300))).toBe(0);
    expect(sundqvistCover(0, rhCritical(850))).toBe(0);
  });

  it("saturates at 100%", () => {
    expect(sundqvistCover(100, rhCritical(700))).toBeCloseTo(100, 10);
  });

  // 90.5% RH at 1000 hPa is the number in the plan: what it takes for the surface slot to light
  // a single pixel once the encoder's 3-bit deadband is stacked on the diagnostic's floor.
  it("needs 90.5% humidity at 1000 hPa to clear the encoder deadband", () => {
    expect(quantCover(sundqvistCover(90.4, rhCritical(1000)))).toBe(0);
    expect(quantCover(sundqvistCover(90.6, rhCritical(1000)))).toBe(1);
  });
});

describe("fillCloudBand", () => {
  it("leaves a band the diagnostic already sees alone", () => {
    // 90% at 850 hPa is well above its 77.2% threshold, so the low band is not empty and the
    // trio never gets consulted — the levels are the recomputed diagnostic, unchanged.
    const b = band({ rh: { 850: 90, 925: 60, 1000: 60 }, low: 100 });
    expect(b[850]).toBeCloseTo(sundqvistCover(90, rhCritical(850)), 10);
    expect(b[925]).toBe(0);
    expect(b[1000]).toBe(0);
  });

  it("places by humidity deficit, not raw humidity, when every level is clipped to zero", () => {
    // Raw humidity ranks 1000 (81%) above 850 (76%); the deficit ranks 850 (−1.2 pt) far above
    // 1000 (−8.0 pt), which is the surface bias the deficit exists to remove. Every in-band
    // cover is exactly 0.0, so the covers themselves carry no ranking information at all.
    const c: Case = { rh: { 850: 76, 925: 70, 1000: 81 }, low: 40 };
    expect(stack(band({ ...c, low: null })))
      .toEqual([null, null, null, null, null, null, null, 0, 0, 0]);
    const b = band(c);
    expect(b[850]).toBeCloseTo(40, 10); // one level lit → it carries the whole band value
    expect(b[925]).toBe(0);
    expect(b[1000]).toBe(0);
  });

  it("splits the band value across the levels within the placement window", () => {
    // Three levels inside 5 pt of the best deficit. Random-overlap normalization: three levels at
    // v combine to 1 − (1 − v)³ = the band's 60%.
    const b = band({ rh: { 850: 76, 925: 81, 1000: 87 }, low: 60 });
    const v = (1 - Math.pow(0.4, 1 / 3)) * 100;
    expect(b[850]).toBeCloseTo(v, 10);
    expect(b[925]).toBeCloseTo(v, 10);
    expect(b[1000]).toBeCloseTo(v, 10);
    expect(1 - Math.pow(1 - v / 100, 3)).toBeCloseTo(0.6, 10);
  });

  describe("700 hPa band flip", () => {
    // Same hour twice, only 700 hPa's geopotential moves across the 3 km line. Its 75% humidity
    // clears the 70.7% threshold there, so wherever it lands, that band is not empty.
    const c: Case = { rh: { 700: 75, 850: 76, 925: 70, 1000: 81 }, low: 40, mid: 40 };

    it("counts 700 in the low band below 3 km, which suppresses the low fill", () => {
      const b = band({ ...c, height: { 700: 2900 } });
      expect(quantCover(b[700] as number)).toBeGreaterThan(0);
      expect(b[850]).toBe(0); // low band non-empty via 700 — nothing synthesized
      expect(b[925]).toBe(0);
      expect(b[1000]).toBe(0);
    });

    it("counts 700 in the mid band above 3 km, which lets the low fill run", () => {
      const b = band({ ...c, height: { 700: 3100 } });
      expect(quantCover(b[700] as number)).toBeGreaterThan(0);
      expect(b[850]).toBeCloseTo(40, 10); // low band now empty → filled from the trio
      expect(b[925]).toBe(0);
      expect(b[1000]).toBe(0);
    });
  });

  describe("the high-band placement", () => {
    it("carries the model's high cloud into the only level with humidity", () => {
      // 40% humidity at 300 hPa is far under its 70% threshold, so the diagnostic reads clear
      // while the model reports 55% high cloud. With 300 the only placeable level, it carries
      // the whole layer integral.
      expect(band({ rh: { 300: 40 }, high: 55 })[300]).toBe(55);
    });

    it("overwrites the diagnostic even when it already saw cloud", () => {
      // Unconditional, unlike low/mid: up here the diagnostic scores worse than a constant
      // against the model's own high cloud, so there is nothing to preserve.
      expect(band({ rh: { 300: 95 }, high: 20 })[300]).toBe(20);
    });

    it("places the integral on the best-deficit cirrus level a summit band carries", () => {
      // A 6200 m point carries [200..600], so all three cirrus levels compete: 250 hPa clears
      // its ~70% threshold (+2 pt) while 200 and 300 sit 30 pt under it, far outside the 5 pt
      // window — so 250 alone carries the layer integral and the other two read clear, cirrus
      // placed at its own altitude.
      const b = band({ rh: { 200: 40, 250: 72, 300: 40 }, high: 55 }, 6200);
      expect(b[250]).toBe(55);
      expect(b[200]).toBe(0);
      expect(b[300]).toBe(0);
    });

    it("folds the integral into 300 hPa when the band tops out there", () => {
      // The same sky from low country: the wire carries [300..1000], so 250 — the level the
      // humidity would pick — is cropped, and the whole integral lands on the carried top
      // instead of vanishing with it.
      const b = band({ rh: { 200: 40, 250: 72, 300: 40 }, high: 55 }, 0);
      expect(b[300]).toBe(55);
    });

    it("falls back to a slab when the band has cover but no humidity to place with", () => {
      // Served diagnostic covers, no humidity at any cirrus level: nothing ranks them, so every
      // carried member gets the integral.
      const b = band({ rh: { 850: 76 }, cover: { 200: 5, 250: 5, 300: 5 }, high: 60 }, 6200);
      expect(b[200]).toBe(60);
      expect(b[250]).toBe(60);
      expect(b[300]).toBe(60);
    });

    it("reports clear when the model says clear", () => {
      expect(band({ rh: { 300: 95 }, high: 0 })[300]).toBe(0);
    });

    it("leaves the band alone when the model has no high cloud to place", () => {
      const b = band({ rh: { 300: 95 }, high: null });
      expect(b[300]).toBeCloseTo(sundqvistCover(95, rhCritical(300)), 10);
    });
  });

  describe("encoder survival", () => {
    it("does not fill when the band value cannot clear the deadband", () => {
      // 7.0% is under 50/7 ≈ 7.14: it would quantize to 0 even placed on a single level, so a
      // fill could only add noise below the deadband.
      expect(quantCover(7.0)).toBe(0);
      const b = band({ rh: { 850: 76, 925: 70, 1000: 81 }, low: 7.0 });
      expect(stack(b)).toEqual([null, null, null, null, null, null, null, 0, 0, 0]);
    });

    it("fills a band value that just clears the deadband", () => {
      const b = band({ rh: { 850: 76, 925: 70, 1000: 81 }, low: CLOUD_COVER_MIN_PCT });
      expect(quantCover(b[850] as number)).toBe(1);
    });

    it("sheds the weakest level until what is left survives quantization", () => {
      // Four levels in the window (700 pulled below 3 km), band value 20%. Spread over four,
      // each is 5.4% and quantizes to 0; over three, 7.2% and each encodes as 1. The level shed
      // is 1000 hPa — the weakest deficit of the four.
      const c: Case = {
        rh: { 700: 68, 850: 75, 925: 80, 1000: 86 },
        height: { 700: 2900 },
        low: 20,
      };
      expect(quantCover((1 - Math.pow(0.8, 1 / 4)) * 100)).toBe(0);
      const b = band(c);
      const v = (1 - Math.pow(0.8, 1 / 3)) * 100;
      for (const l of [700, 850, 925]) {
        expect(b[l]).toBeCloseTo(v, 10);
        expect(quantCover(b[l] as number)).toBe(1);
      }
      expect(b[1000]).toBe(0);
    });
  });

  describe("ECMWF's missing levels", () => {
    // The 0.25° IFS has no 600/400, and cover, humidity and height ride the same request — so
    // all three go null together at exactly those levels.
    const ECMWF: Case = {
      rh: { 300: 40, 400: null, 500: 45, 600: null, 700: 60, 850: 76, 925: 70, 1000: 81 },
      height: { 400: null, 600: null },
      low: 40, mid: 50, high: 55,
    };

    it("keeps a null level out of its band's emptiness test and out of the placement", () => {
      // The mid band's only served levels are 500 (45% against a 70% threshold) and 700 (60%
      // against 70.7%) — both clipped, so the band is empty and gets filled. 700's deficit
      // (−10.7 pt) beats 500's (−25.0) by well over the 5 pt window, so 700 alone carries the
      // band value. The null 600 in between neither blocks the fill nor takes a share of it.
      const b = band(ECMWF);
      expect(b[400]).toBeNull();
      expect(b[600]).toBeNull();
      expect(b[300]).toBe(55);            // the high placement, 300 the only placeable level
      expect(b[700]).toBeCloseTo(50, 10); // mid band, on the level the deficit picked
      expect(b[500]).toBe(0);
      expect(b[850]).toBeCloseTo(40, 10); // low band, unaffected by the holes above it
    });

    it("bridges the holes after the fill, between the placed top slots and the levels below", () => {
      // repairCloudBand runs downstream of the fill (via toFullPeriod), so it interpolates filled
      // values, not raw ones. 400 lands between the 300 slot — carrying its placed share of the
      // layer integral — and the point diagnostic at 500: the accepted semantic mush. The unserved
      // 200/250 clamp-extend from 300.
      const repaired = repairCloudBand(stack(band(ECMWF)));
      expect(repaired[0]).toBe(55);   // 200, clamp-extended from 300
      expect(repaired[1]).toBe(55);   // 250, bridged 300→300
      expect(repaired[2]).toBe(55);   // 300, the placed integral
      expect(repaired[3]).toBe(28);   // 400, bridged halfway 300→500: 55 → 0
      expect(repaired[4]).toBe(0);    // 500
      expect(repaired[5]).toBe(25);   // 600, bridged halfway 500→700: 0 → 50
      expect(repaired[6]).toBe(50);   // 700
      expect(repaired.some((v) => v == null)).toBe(false);
    });
  });

  describe("degenerate inputs", () => {
    it("returns the input untouched when no level humidity is present", () => {
      // An offline cell that carries only the diagnostic: nothing to recompute or place with, so
      // the band it already has is what it keeps.
      const h = hourly({ cover: { 850: 42 }, low: 90 });
      expect(fillCloudBand(h, 0)).toBe(h);
    });

    it("falls back to the served cover for a level with height but no humidity", () => {
      const b = band({ rh: { 850: 76, 1000: 81 }, cover: { 925: 42 }, low: 90 });
      expect(b[925]).toBe(42);     // low band is not empty, so nothing is synthesized
      expect(b[850]).toBe(0);
      expect(b[1000]).toBe(0);
    });

    it("skips a band whose levels are all absent", () => {
      // No 300 hPa at all: the high band has no member to fold onto, so the fold is skipped
      // rather than inventing a level. repairCloudBand clamps the hole afterwards.
      const b = band({ rh: { 300: null, 850: 76 }, height: { 300: null }, low: 40, high: 80 });
      expect(b[300]).toBeNull();
    });

    it("skips a band whose model value is missing", () => {
      expect(stack(band({ rh: { 850: 76, 925: 70, 1000: 81 }, low: null })))
        .toEqual([null, null, null, null, null, null, null, 0, 0, 0]);
    });
  });
});
