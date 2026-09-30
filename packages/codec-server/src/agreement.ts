/**
 * Model agreement scoring (README "Model Agreement"): how the served forecast's precipitation
 * agrees with each other center, per period, on the aggregated period values the reader
 * actually sees — the same rowsFromWindows output the wire encodes, never raw hourly data
 * (aggregate-then-score).
 *
 * Each side's period falls into a precip category:
 *   None   rain and snow both quantize to 0 on the wire
 *   Trace  mean hourly liquid-equivalent rate (snow at 0.7 cm/mm) below 0.25 mm/h
 *   Light  0.25 to 1 mm/h
 *   Heavy  1 mm/h or more
 * and the wire level is AGREEMENT_MATRIX[a][b] (protocol constants.ts).
 */
import {
  ACCUM_BITS, AGREEMENT_MATRIX, AGREEMENT_PRECIP_RATE_CUTS, RAIN_K, SNOW_K, compandSqrt,
} from "@weather/protocol";
import type { Row } from "./forecast.js";

// temperature_2m is the no-data sentinel (a window with no data aggregates to temp_c null) and
// feeds the phase correction.
export const AGREEMENT_FETCH_VARS = ["temperature_2m", "rain", "showers", "snowfall"];

const SNOW_CM_PER_MM = 0.7;

export const PRECIP_NONE = 0;
export const PRECIP_TRACE = 1;
export const PRECIP_LIGHT = 2;
export const PRECIP_HEAVY = 3;

export function precipCategory(row: Row, periodHours: number): number {
  if (compandSqrt(row.rain_mm, RAIN_K, ACCUM_BITS) === 0
      && compandSqrt(row.snow_cm, SNOW_K, ACCUM_BITS) === 0) return PRECIP_NONE;
  const rate = (row.rain_mm + row.snow_cm / SNOW_CM_PER_MM) / periodHours;
  if (rate < AGREEMENT_PRECIP_RATE_CUTS[0]) return PRECIP_TRACE;
  if (rate < AGREEMENT_PRECIP_RATE_CUTS[1]) return PRECIP_LIGHT;
  return PRECIP_HEAVY;
}

// One served/center period pair's wire level 0..3, or null when either side has no data (an
// upstream horizon gap — the wire's no-data symbol, never a low level).
export function agreementLevel(a: Row, b: Row, periodHours: number): number | null {
  if (a.temp_c == null || b.temp_c == null) return null;
  return AGREEMENT_MATRIX[precipCategory(a, periodHours)][precipCategory(b, periodHours)];
}

// One pair's per-period wire levels: 0..3, or null where a side has no data (encoded as the
// no-data symbol inside the pair's horizon clamp; wire.ts never asks past it).
export function computeAgreementLevels(
  served: Row[], center: Row[] | null, periodHours: number[],
): (number | null)[] {
  return served.map((row, p) => {
    const other = center?.[p];
    return other ? agreementLevel(row, other, periodHours[p]) : null;
  });
}
