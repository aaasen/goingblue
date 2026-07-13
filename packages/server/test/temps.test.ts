import { describe, expect, it } from "vitest";
import { representativeTemps } from "../src/forecast.js";

// representativeTemps picks one real hourly sample per window such that min/max over a local
// day's reported values recover the daily extremes (see the function's comment in forecast.ts).

// Hourly ISO labels (UTC) starting at an epoch hour.
function isoHours(startUtcHour: number, n: number): string[] {
  return Array.from({ length: n }, (_, i) =>
    new Date((startUtcHour + i) * 3600000).toISOString().slice(0, 16));
}

// Midnight-justified windows of `span` hours over n hours of data starting at index 0.
function uniformWindows(n: number, span: number): number[][] {
  const out: number[][] = [];
  for (let s = 0; s + span <= n; s += span)
    out.push(Array.from({ length: span }, (_, i) => s + i));
  return out;
}

const START = Date.UTC(2026, 6, 12) / 3600000; // a UTC midnight

describe("representativeTemps", () => {
  it("reports the daily extremes from their windows and midpoint samples elsewhere (6h)", () => {
    // One local day: unique extremes (after 1°C rounding) at 05 and 15.
    const temps = Array.from({ length: 24 }, (_, h) => 2 - 8 * Math.cos(((h - 3) / 24) * 2 * Math.PI));
    temps[5] = -6.9;
    temps[15] = 10.6;
    const windows = uniformWindows(24, 6);
    const out = representativeTemps(temps, isoHours(START, 24), windows, 0);
    expect(out[0]).toBe(-6.9);        // window 00–06 holds the daily min
    expect(out[2]).toBe(10.6);        // window 12–18 holds the daily max
    expect(out[1]).toBe(temps[9]);    // midpoint sample (4th hour of 06–12)
    expect(out[3]).toBe(temps[21]);   // midpoint sample of 18–24
    // The client's recovery rule: min/max over the day's reported values.
    expect(Math.min(...(out as number[]))).toBe(-6.9);
    expect(Math.max(...(out as number[]))).toBe(10.6);
  });

  it("keeps the cheaper extreme on a 12h collision and patches from the other window", () => {
    // Rise to an afternoon max, then fall past the morning low: both extremes land in the
    // 12–24 window. The 00–12 window's own max (9) patches the lost daily max better (err 3)
    // than its min (-2) patches the lost daily min (err 4), so the colliding window keeps
    // the min and the other window reports its max.
    const temps = [
      -2, -1, 0, 1, 2, 3, 4, 5, 6, 7, 8, 9,            // 00–12: -2 .. 9
      10, 11, 12, 10, 8, 6, 4, 2, 0, -2, -4, -6,       // 12–24: max 12 at 14h, min -6 at 23h
    ];
    const out = representativeTemps(temps, isoHours(START, 24), uniformWindows(24, 12), 0);
    expect(out).toEqual([9, -6]);
  });

  it("keeps the max on a collision when the other window patches the min better", () => {
    // Same shape, but the morning stays near the nightly low: patching the min costs 1,
    // patching the max costs 3 → keep the max.
    const temps = [
      -5, -4, -3, -2, -1, 0, 2, 4, 6, 7, 8, 9,
      10, 11, 12, 10, 8, 6, 4, 2, 0, -2, -4, -6,
    ];
    const out = representativeTemps(temps, isoHours(START, 24), uniformWindows(24, 12), 0);
    expect(out).toEqual([-5, 12]);
  });

  it("uses 1°C tie freedom to separate extremes that recur across windows", () => {
    // The daily max (rounded) occurs in both windows; the min only in the first. Separable:
    // window 0 reports the min, window 1 reports the max — no collision handling.
    const temps = [
      8.2, 6, 4, 2, 0, -3.4, 0, 2, 4, 6, 7, 8,         // min -3.4 at 05, 8.2 rounds to 8
      7.8, 8.4, 7, 6, 5, 4, 3, 2, 1, 0, -1, -2,        // 8.4 rounds to 8 too
    ];
    const out = representativeTemps(temps, isoHours(START, 24), uniformWindows(24, 12), 0);
    expect(out[0]).toBe(-3.4);
    expect(out[1]).toBe(8.4);
  });

  it("reports the window max for a single-window (partial) day", () => {
    const temps = [1, 3, 7, 5, 2, 0, -1, -2, -3, -4, -5, -6];
    const out = representativeTemps(temps, isoHours(START + 12, 12), [uniformWindows(12, 12)[0]], 0);
    expect(out).toEqual([7]);
  });

  it("groups windows into local days using the UTC offset", () => {
    // UTC-9: local midnight is 09:00 UTC. Two local 12h windows over one local day, with the
    // min in the first (local 00–12) and the max in the second (local 12–24).
    const temps = [
      -8, -7, -6, -5, -4, -3, -2, -1, 0, 1, 2, 3,      // local 00–12: min -8
      4, 5, 6, 7, 8, 9, 10, 9, 7, 5, 3, 1,             // local 12–24: max 10
    ];
    const times = isoHours(START + 9, 24);              // first hour = 09:00 UTC = local midnight
    const out = representativeTemps(temps, times, uniformWindows(24, 12), -9);
    expect(out).toEqual([-8, 10]);
  });

  it("passes 1h windows through as their own samples", () => {
    const temps = [3.1, 4.2, 2.7, 5.9];
    const windows = temps.map((_, i) => [i]);
    const out = representativeTemps(temps, isoHours(START, 4), windows, 0);
    expect(out).toEqual(temps);
  });

  it("returns null for windows with no temperature data", () => {
    const temps = [null, null, 5, 6];
    const out = representativeTemps(temps, isoHours(START, 4), [[0, 1], [2, 3]], 0);
    expect(out[0]).toBeNull();
    expect(out[1]).not.toBeNull();
  });
});
