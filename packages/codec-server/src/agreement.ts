/**
 * Model agreement scoring (README "Model Agreement"): how the served forecast agrees with each
 * other center, per period, on the aggregated period values the reader actually sees — the same
 * rowsFromWindows output the wire encodes, never raw hourly data (aggregate-then-score).
 *
 * Components (each a similarity 0..1) and the frozen constants that give the wire levels their
 * meaning:
 *   temp    |Δ| of the representative samples, linear to 0 at 5 °C
 *   wind    min(speed, direction): speed |Δ| in continuous Beaufort forces with a 0.5-force
 *           deadband (the pair-identity floor is not signal) then linear to 0 over 2.5 more;
 *           direction (1+cos Δθ)/2, scored only when both periods reach force 2 (6 kph)
 *   precip  wet/dry vote on total water equivalent (rain + snow at 0.7 cm/mm) with a
 *           period-scaled trace floor; both wet → sqrt(min/max) of the totals; split vote →
 *           0.55 falling to 0 as the wet side's mean rate reaches 2 mm/h
 * combined by a weighted soft-min (power mean, p = -2) at precip .60 / wind .30 / temp .10
 * — near the worst component, not the average — then cut into the four wire levels by
 * AGREEMENT_CUTS (protocol constants.ts). Cloud cover was a fourth component (clear/cloudy
 * vote at 5% weight) and was removed 2026-09-01: its hourly contradictions are dominated by
 * parameterization noise and it bound disagreement at every lead without any lead structure —
 * a constant tax, not confidence signal.
 */
import { BEAUFORT_KPH_LOWER, BEAUFORT_MAX, quantAgreement } from "@weather/protocol";
import type { Row } from "./forecast.js";

export const AGREEMENT_FETCH_VARS = [
  "temperature_2m", "wind_speed_10m", "wind_direction_10m",
  "rain", "showers", "snowfall",
];

const D_TEMP_C = 5.0;
const SPEED_DEADBAND_F = 0.5;
const D_SPEED_F = 2.5;
const DIR_GATE_KPH = BEAUFORT_KPH_LOWER[2]; // both at force 2+ or direction is dither
const SNOW_CM_PER_MM = 0.7;
const WET_FLOOR_BASE_MM = 0.2;
const WET_FLOOR_PER_HOUR_MM = 0.05;
const SPLIT_BASE = 0.55;
const SPLIT_FULL_MM_PER_H = 2.0;
const W_TEMP = 0.10;
const W_WIND = 0.30;
const W_PRECIP = 0.60;
const SOFTMIN_P = -2;
const S_EPS = 0.02;

const clamp01 = (v: number) => Math.min(Math.max(v, 0), 1);

// Continuous extended-Beaufort force: the band index plus the linear position inside the band,
// so a speed delta measures in perceptible force steps rather than raw kph.
export function forceContinuous(kph: number): number {
  const v = Math.max(kph, 0);
  let f = 0;
  while (f < BEAUFORT_MAX && v >= BEAUFORT_KPH_LOWER[f + 1]) f++;
  if (f >= BEAUFORT_MAX) return BEAUFORT_MAX;
  const lo = BEAUFORT_KPH_LOWER[f];
  const hi = BEAUFORT_KPH_LOWER[f + 1];
  return f + (v - lo) / (hi - lo);
}

// The continuous 0..1 agreement of one served/center period pair, or null when either side is
// missing an input (an upstream horizon gap — the wire's no-data symbol, never a low score).
export function agreementScore(a: Row, b: Row, periodHours: number): number | null {
  if (a.temp_c == null || b.temp_c == null) return null;
  if (a.wind_speed_10m == null || b.wind_speed_10m == null) return null;

  const sTemp = clamp01(1 - Math.abs(a.temp_c - b.temp_c) / D_TEMP_C);

  const df = Math.abs(forceContinuous(a.wind_speed_10m) - forceContinuous(b.wind_speed_10m));
  const sSpeed = clamp01(1 - Math.max(0, df - SPEED_DEADBAND_F) / D_SPEED_F);
  let sWind = sSpeed;
  if (a.wind_speed_10m >= DIR_GATE_KPH && b.wind_speed_10m >= DIR_GATE_KPH
      && a.wind_direction_10m != null && b.wind_direction_10m != null) {
    const dd = Math.abs((((a.wind_direction_10m - b.wind_direction_10m) + 180) % 360 + 360) % 360 - 180);
    const sDir = (1 + Math.cos((dd * Math.PI) / 180)) / 2;
    sWind = Math.min(sSpeed, sDir);
  }

  const totalA = a.rain_mm + a.snow_cm / SNOW_CM_PER_MM;
  const totalB = b.rain_mm + b.snow_cm / SNOW_CM_PER_MM;
  const floor = Math.max(WET_FLOOR_BASE_MM, WET_FLOOR_PER_HOUR_MM * periodHours);
  const wetA = totalA >= floor;
  const wetB = totalB >= floor;
  let sPrecip: number;
  if (!wetA && !wetB) {
    sPrecip = 1;
  } else if (wetA && wetB) {
    const mx = Math.max(totalA, totalB);
    sPrecip = mx > 0 ? Math.sqrt(Math.min(totalA, totalB) / mx) : 1;
  } else {
    const rate = Math.max(totalA, totalB) / periodHours;
    sPrecip = SPLIT_BASE * clamp01(1 - rate / SPLIT_FULL_MM_PER_H);
  }

  const term = (w: number, s: number) => w * Math.max(s, S_EPS) ** SOFTMIN_P;
  return (term(W_TEMP, sTemp) + term(W_WIND, sWind)
    + term(W_PRECIP, sPrecip)) ** (1 / SOFTMIN_P);
}

// One pair's per-period wire levels: 0..3, or null where a side has no data (encoded as the
// no-data symbol inside the pair's horizon clamp; wire.ts never asks past it).
export function computeAgreementLevels(
  served: Row[], center: Row[] | null, periodHours: number[],
): (number | null)[] {
  return served.map((row, p) => {
    const other = center?.[p];
    if (!other) return null;
    const score = agreementScore(row, other, periodHours[p]);
    return score === null ? null : quantAgreement(score);
  });
}
