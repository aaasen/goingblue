/**
 * Coverage-aware weathercode aggregation: one WMO code summarizing a period, from its hourly
 * codes. Called by rowsFromWindows (forecast.ts), which used to take `maxOf(hourly codes)` — the
 * numerically highest code in the window. Max over-reports badly at coarse resolutions: at 12h,
 * 95.9% of periods emitting a continuous rain code were NOT wet for the whole window, and one
 * hour of heavy snow in eleven clear ones summarized as "heavy snow".
 *
 * Shape of the rule: FORM comes from coverage (how much of the window was wet), INTENSITY from
 * accumulation (which agrees with the snow_cm/rain_mm shipped in the same period), and the swap is
 * ONE-DIRECTIONAL — a continuous code may downgrade to its shower form, a shower code never
 * upgrades. That last part makes the form swap a no-op at 1h resolution (a one-hour window is
 * either fully wet or fully dry) and means it never overrides the model's own convective call. It
 * mirrors adjustPrecipPhase, which is one-directional for the same reason. The one rule that CAN
 * rewrite a 1h code is the mixed-phase gate's amount arm (step 3): the model splits accumulation
 * by phase within a single hour but its weathercode cannot say "both", so a genuinely mixed hour
 * becomes 68/69 here.
 *
 * Why the shower codes are the target: 80/81/82 and 85/86 already ARE the alphabet's intermittent
 * form, and glyphSpec already renders them with the sun behind the cloud (`sky: shower ? 'partly'
 * : 'overcast'`, packages/mobile/weatherGlyph.ts). Total cloud cover left the wire when the `cc`
 * bit was reclaimed, so weathercode is the only carrier of sky state — the showery/continuous axis
 * is the only "there was sun in there" channel the format has.
 *
 * Thresholds are read off analyze-weathercode-aggregation.ts §E (accumulation rate per WET hour,
 * 1h rows as ground truth). Each reproduces its code's modal rate bin.
 *
 * COST, held-out 5-fold by location over 52.0M periods (analyze-wc-aggregation-heldout.ts):
 * +0.080 b/period vs max, ~0.9% of the body — +0.034 for the wet-side rule and +0.047 for the
 * dry-sky fix, which partition the periods and so sum. The three wet columns, whose codebooks key
 * on the same-period weathercode class, did not move (+0.001): their symbols are untouched and
 * only their conditioning changed.
 *
 * NOTE this is encoder-side policy, not wire format — the decoder only ever sees the symbol. The
 * one wire-format part is that 68/69 exist in WMO_CODES at all.
 */

// WMO 4677 mixed rain/snow — "rain or drizzle and snow, slight" / "...moderate or heavy". Real
// WMO codes that Open-Meteo never emits, so the alphabet has no way to say a window was BOTH.
// Sized at 2.3% of wet periods / 0.8% of all at 12h, which would rank ~14th of 30 symbols.
export const WMO_MIX_LIGHT = 68;
export const WMO_MIX_HEAVY = 69;

const THUNDER = new Set([95, 96, 99]);
const FREEZING = new Set([56, 57, 66, 67]);
const SNOW_CONT = new Set([71, 73, 75, 77]);
const SNOW_SHWR = new Set([85, 86]);
const RAIN_CONT = new Set([61, 63, 65]);
const RAIN_SHWR = new Set([80, 81, 82]);
const DRIZZLE = new Set([51, 53, 55]);
const FOG = new Set([45, 48]);

// Tunable knobs, all wire format if this ships.
export const CONT_COVERAGE = 0.5;  // ≥ this fraction wet → continuous form, else shower form
export const MIX_FRAC = 0.25;      // minority phase ≥ this fraction of wet hours OR of total WE → 68/69
export const FOG_COVERAGE = 0.25;  // fog needs this much of the window to beat the sky ladder
export const MIX_HEAVY_MM = 0.5;   // liquid-equivalent mm per wet hour splitting 68 from 69
export const MIX_MIN_WE_MM = 0.2;  // amount arm's trace floor: minority phase must clear this in WE mm
const SNOW_CM_PER_MM = 0.7;        // matches adjustPrecipPhase in src/forecast.ts

// Implied sky coverage 0..100 of a non-precipitating code — mirrors codeCoverage() in
// packages/mobile/Meteogram.tsx, which is where this ladder is already defined for the glyphs.
function skyCoverage(code: number): number {
  if (code === 0) return 0;
  if (code === 1) return 25;
  if (code === 2) return 55;
  if (code === 3) return 95;
  if (FOG.has(code)) return 90;
  return 85; // unrecognized: treat as heavily clouded (never fires on the corpus)
}
// Inverse of the ladder above, at the midpoints between its rungs.
function quantizeSky(c: number): number {
  return c < 12.5 ? 0 : c < 40 ? 1 : c < 75 ? 2 : 3;
}

/** True when no hour in the window was precipitating — the windows step 2 decides. */
export function isDryWindow(codes: number[]): boolean {
  return !codes.some((c) =>
    THUNDER.has(c) || FREEZING.has(c) || SNOW_CONT.has(c) || SNOW_SHWR.has(c) ||
    RAIN_CONT.has(c) || RAIN_SHWR.has(c) || DRIZZLE.has(c));
}

/** The dry-window sky code for a set of hours — step 2, exposed so the cost scan can attribute
 *  the dry-sky half of the change separately from the wet half. */
export function drySkyCode(codes: number[]): number {
  const fog = codes.filter((c) => FOG.has(c));
  if (fog.length / codes.length >= FOG_COVERAGE) return fog.includes(48) ? 48 : 45;
  return quantizeSky(codes.reduce((a, c) => a + skyCoverage(c), 0) / codes.length);
}

/**
 * One period's weathercode from its hourly codes plus the window's accumulation totals.
 * `codes` are the post-adjustPrecipPhase hourly codes with nulls already dropped; `snowCm` and
 * `rainMm` are the window sums (Row.snow_cm / Row.rain_mm). Returns 0 for an empty window, the
 * same no-data value toFullPeriod already substitutes.
 *
 * `drySkyMax` reverts step 2 to today's `max` for dry windows, leaving the wet-side rule intact —
 * used only by the cost scan to price the two halves of the change independently. `noAmountMix`
 * disables the amount arm of the mixed-phase gate — used only by its cost scan
 * (analyze-wc-amount-mix-heldout.ts) to price that arm against the code-count arm alone.
 */
export function aggregateWeathercode(
  codes: number[], snowCm: number, rainMm: number, drySkyMax = false, noAmountMix = false,
): number {
  const N = codes.length;
  if (N === 0) return 0;

  const thunder = codes.filter((c) => THUNDER.has(c));
  const freezing = codes.filter((c) => FREEZING.has(c));
  const snow = codes.filter((c) => SNOW_CONT.has(c) || SNOW_SHWR.has(c));
  const rain = codes.filter((c) => RAIN_CONT.has(c) || RAIN_SHWR.has(c));
  const drizzle = codes.filter((c) => DRIZZLE.has(c));
  const fog = codes.filter((c) => FOG.has(c));

  // 1. ESCAPES. Both stay winner-take-all: a thunderstorm is the story of its window however
  // brief, and freezing precipitation is the one phase where being wrong is a safety problem —
  // it is also never "showery" in any useful sense. Thunder first only to match the client's
  // codeSeverity (≥95 → 100); the two co-occur too rarely for the order to matter.
  if (thunder.length > 0) return Math.max(...thunder);          // 95 < 96 < 99
  if (freezing.length > 0) return Math.max(...freezing);        // 56 < 57 < 66 < 67

  const nWet = snow.length + rain.length + drizzle.length;

  // 2. DRY. 0/1/2/3 are a cloud-FRACTION ladder, so max is the wrong operator on them — it costs
  // clear sky two thirds of its mass (code 0 is 31.0% of 1h emissions but 12.1% at 12h) and
  // inflates fog ~3x. Average the implied coverage instead and quantize back.
  if (nWet === 0) return drySkyMax ? Math.max(...codes) : drySkyCode(codes);

  const coverage = nWet / N;
  const liquid = rain.length + drizzle.length;

  // 3. PHASE. Mixed first — with no 68/69 the alphabet resolves these to pure snow 98.9% of the
  // time, which reads as powder when half the window was rain. Two arms, OR-ed:
  //   codes:   the minority phase holds ≥ MIX_FRAC of the wet hours' CODES.
  //   amounts: an hourly weathercode is single-valued — the model tags each borderline hour with
  //            only its dominant phase — so a window of "mostly snow, some rain" hours can carry
  //            zero rain codes while rain_mm accumulates visibly in the same period's own row.
  //            Compare the phases in water equivalent instead: minority ≥ MIX_FRAC of total WE,
  //            above a trace floor. Catches ~0.85% of wet periods at every resolution (67-72%
  //            of them rain-under-snow, emitted as pure snow before), including 1h, where the
  //            code arm structurally cannot fire (analyze-wc-amount-mix.ts).
  const snowWE = snowCm / SNOW_CM_PER_MM;
  const minorityWE = Math.min(rainMm, snowWE);
  const codeMix = Math.min(liquid, snow.length) / nWet >= MIX_FRAC;
  const amountMix = !noAmountMix &&
    minorityWE >= MIX_MIN_WE_MM && minorityWE / (rainMm + snowWE) >= MIX_FRAC;
  if (codeMix || amountMix) {
    const rate = (rainMm + snowWE) / nWet;
    return rate < MIX_HEAVY_MM ? WMO_MIX_LIGHT : WMO_MIX_HEAVY;
  }

  // 4/5. FORM from coverage, INTENSITY from accumulation per wet hour of the phase.
  if (snow.length > liquid) {
    const rate = snowCm / snow.length;
    // One-directional: if the model only ever said "snow showers" here, it stays showers.
    const shower = coverage < CONT_COVERAGE || snow.every((c) => SNOW_SHWR.has(c));
    if (shower) return rate < 0.5 ? 85 : 86;
    return rate < 0.1 ? 71 : rate < 0.5 ? 73 : 75;
  }

  const rate = rainMm / liquid;
  // Pure drizzle has no shower form in the alphabet, so it never swaps — 51/53/55 already read as
  // light and intermittent. Promoting it to 80 would overstate intensity fourfold on the rate
  // ladder, and demoting it to cloud would delete the fact that it was wet at all.
  if (rain.length === 0) return rate < 0.5 ? 51 : rate < 1 ? 53 : 55;

  // Rain family beats drizzle family when both are present. The continuous and shower ladders are
  // identical because 61/63/65 and 80/81/82 have the same accumulation-rate distributions — the
  // swap is a pure family swap with no intensity distortion.
  const shower = coverage < CONT_COVERAGE || rain.every((c) => RAIN_SHWR.has(c));
  if (shower) return rate < 2 ? 80 : rate < 5 ? 81 : 82;
  return rate < 2 ? 61 : rate < 5 ? 63 : 65;
}
