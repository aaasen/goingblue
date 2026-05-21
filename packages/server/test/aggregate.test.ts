import { describe, it, expect } from "vitest";
import { maxOf, minOf, sumOf, dominantDirDeg } from "../src/forecast.js";

describe("maxOf", () => {
  it("returns max of non-null values", () => {
    expect(maxOf([1, 5, 3])).toBe(5);
  });

  it("ignores nulls", () => {
    expect(maxOf([null, 3, null, 7, null])).toBe(7);
  });

  it("returns null when all values are null", () => {
    expect(maxOf([null, null])).toBeNull();
  });

  it("returns null for empty array", () => {
    expect(maxOf([])).toBeNull();
  });

  it("handles negative values", () => {
    expect(maxOf([-10, -3, -7])).toBe(-3);
  });
});

describe("minOf", () => {
  it("returns min of non-null values", () => {
    expect(minOf([5, 1, 3])).toBe(1);
  });

  it("ignores nulls", () => {
    expect(minOf([null, 3, null, 1, null])).toBe(1);
  });

  it("returns null when all values are null", () => {
    expect(minOf([null, null])).toBeNull();
  });

  it("returns null for empty array", () => {
    expect(minOf([])).toBeNull();
  });

  it("handles negative values", () => {
    expect(minOf([-3, -10, -7])).toBe(-10);
  });
});

describe("sumOf", () => {
  it("sums non-null values", () => {
    expect(sumOf([1, 2, 3])).toBe(6);
  });

  it("treats nulls as zero", () => {
    expect(sumOf([1, null, 3])).toBe(4);
  });

  it("returns 0 for all-null array", () => {
    expect(sumOf([null, null])).toBe(0);
  });

  it("returns 0 for empty array", () => {
    expect(sumOf([])).toBe(0);
  });
});

describe("dominantDirDeg", () => {
  it("returns the direction when all hours blow the same way", () => {
    const result = dominantDirDeg([10, 10, 10], [90, 90, 90]);
    expect(result).toBeCloseTo(90, 0);
  });

  it("returns null when all speeds are zero", () => {
    expect(dominantDirDeg([0, 0], [90, 270])).toBeNull();
  });

  it("returns null when all speeds are null", () => {
    expect(dominantDirDeg([null, null], [90, 270])).toBeNull();
  });

  it("weights direction by speed — faster hours dominate", () => {
    // 1 hour blowing East at 20 mph, 1 hour blowing West at 5 mph → net East
    const result = dominantDirDeg([20, 5], [90, 270]);
    expect(result).toBeCloseTo(90, 0);
  });

  it("handles North (0°) correctly", () => {
    const result = dominantDirDeg([10], [0]);
    expect(result).toBeCloseTo(0, 0);
  });

  it("handles South (180°) correctly", () => {
    const result = dominantDirDeg([10], [180]);
    expect(result).toBeCloseTo(180, 0);
  });

  it("averages two equal winds at right angles", () => {
    // East (90°) and North (0°) at equal speed → NE (45°)
    const result = dominantDirDeg([10, 10], [90, 0]);
    expect(result).toBeCloseTo(45, 0);
  });

  it("treats null speeds as zero contribution", () => {
    // null speed + South → only South contributes
    const result = dominantDirDeg([null, 10], [0, 180]);
    expect(result).toBeCloseTo(180, 0);
  });

  it("returns 360-normalised result (0–360 range)", () => {
    const result = dominantDirDeg([10], [350]);
    expect(result).toBeGreaterThanOrEqual(0);
    expect(result!).toBeLessThan(360);
  });
});
