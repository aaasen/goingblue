import { Fragment, memo, useCallback, useEffect, useMemo, useRef, useState, type ReactNode, type RefObject } from 'react';
import { Animated, View, Text as RNText, StyleSheet, FlatList, PanResponder, Pressable, useWindowDimensions } from 'react-native';
import {
  Canvas, DashPathEffect, Group, Paint, Rect, RoundedRect, Circle, Line, Path, Text,
  LinearGradient, Skia, vec, matchFont, type SkFont,
  FillType,
} from '@shopify/react-native-skia';
import {
  CARDINALS, RAIN_K, modelsFromMask, startDatetime, predictCenter, attributeHour,
  AQ_DOMINANT_US, AQ_DOMINANT_EU, CLOUD_BAND_LEVELS_HPA, WIND_LEVELS_HPA, quantWind,
  type Center, type ForecastMessage, type ModelSpec, type Period,
} from '@weather/protocol';
import type { AltitudeUnit, TimeFormat, UnitPrefs } from './settings';
import {
  bandScale, ladderLabel, pressureToMeters, metersToPressure,
  BAND_TOP_HPA, GRID_STEP_HPA, type BandScale,
} from './cloudBand';
import MaterialCommunityIcons from '@expo/vector-icons/MaterialCommunityIcons';
import { precipMark, weatherGlyph, wmoName, type MoonPhase, type Prim, type PrecipMarkKind } from './weatherGlyph';
import { pageInsets } from './insets';

// ── Layout constants ───────────────────────────────────────────────────────
// Rows are named by a narrow unit rail fixed to the left of the drawing (RowLegend). It sits
// BESIDE the scrolling canvas rather than over it — the scene's own content starts at column 0 —
// so no data column is ever hidden behind it at any scroll offset. The rail is also the only
// thing naming a row once the forecast is scrolled past its first day, which is what the label
// column it replaces could not do: that column lived inside the drawing and scrolled away with
// the data.

const LEGEND_W = 44;
// Line box for one rail token, and for one cloud-band altitude label. Both are centered by
// placing this box on the row's midline rather than by stretching lineHeight to the row height:
// where a tall line box puts its glyphs is a platform question, and the rail's rows run from 26px
// to 175px. The level box is the tighter of the two because the band's levels are 25px apart
// (ROW_H.CLOUD_BAND split evenly between them).
const LEGEND_LINE_H = 13;
const LEGEND_LEVEL_H = 11;
// Rail symbols, and the line box they occupy when stacked over a unit.
const LEGEND_ICON_SIZE = 13;
const LEGEND_ICON_H = 14;
// A precip row's mark — the SAME drop or flake the overview strip stamps across its wet stretches
// (precipMark), so the rail names the row with a shape the reader already learned rather than with
// a second set that means the same thing. One mark per row, over that row's own unit: the snow row
// is a flake over "cm", the rain row a drop over "mm". Both in the rail's grey (LEGEND_MARK_COLORS)
// and both centered in it — the drop is narrow (DROP_ASPECT) and the flake as wide as it is tall,
// but each is alone on its row, so each is centered on its own.
const LEGEND_MARK_H = 12;
const LEGEND_MARK_CX = LEGEND_W / 2;
const CELL_W = 34;
// The weather glyphs have fixed natural geometry, extending up to ±26.5px around their center
// (widest: partly-cloudy and shower codes). They are shrunk into their column by this factor;
// keep GLYPH_SCALE ≤ CELL_W / 53 so neighboring columns don't overlap.
const GLYPH_SCALE = 0.64;
// Clip bound for a glyph in its own (unscaled) coordinates, covering the widest glyph.
const GLYPH_NATURAL_W = 56;
// A Canvas is backed by a CAMetalLayer whose drawable size is measured in physical
// pixels. A single canvas spanning a long hourly forecast can exceed Metal's maximum
// texture width on Retina devices and abort the entire process. Keep each drawable
// narrow and let FlatList virtualize the off-screen tiles. Wider tiles mean fewer seams
// to paint mid-scroll (smoother) while staying well under the texture limit (16×34×3px).
const CANVAS_TILE_W = CELL_W * 16;

// Where the temperature numbers sit inside their row, measured from its top. They ride high
// rather than centered: the row is tall because the temperature area sweeps through it, and the
// curve needs the space under the digits. The rail reads this too, so "°F" lines up with the
// numbers it names instead of floating a dozen pixels below them.
const TEMP_VALUE_Y = 14;

// Where the hour labels sit in the header block, from the top of the drawing. The rail puts its
// clock on this line, so the symbol reads as naming that row of times.
const HOUR_LABEL_Y = 44;

const ROW_H = {
  DATE: 58,
  SECTION: 22,
  CLOUD: 58,
  TEMP: 52,
  // Snow and rain each get their own row, so one is shorter than the single stacked area they
  // replace: each carries one number rather than two lines of them, and the pair still ends up
  // taller than the stack did — which is the point, since two areas on one baseline could only be
  // told apart by which color was on top.
  PRECIP: 38,
  DATA: 42,
  // The freezing level is a graph rather than a bare number, so it needs room for the isotherm to
  // move in under its band of column labels.
  FREEZE: 66,
  // The vertical cloud band runs 300 hPa down to the message's own floor on an even ladder —
  // one equal slice per wire-level gap, edge to edge with nothing padded outside them
  // (bandScale) — at this height per slice. A slice is what a deck confined to a single level
  // is drawn in, and 25px still reads as its own streak rather than blurring into its
  // neighbors; every slice spent above that is one the reader scrolls past to reach the rows
  // below. The row's height therefore follows the level count: a sea-level forecast carries
  // all 8 levels (7 slices, 175px), a summit forecast fewer — the wire truncates the stack at
  // one level below the forecast point, and the row shrinks with it instead of stretching a
  // shorter ladder over a full-height band.
  CLOUD_BAND_SLICE: 25,
  // Wind speeds are a single short number on a colored ground, so they need less room than the
  // other data rows — and there are up to five of them stacked (surface, gust, three upper levels).
  WIND: 26,
  // Upper-level rows stack an inline direction arrow under the speed, so they get extra padding.
  WIND_UPPER: 30,
  DIR: 30,
  // The serving-model band: one line of text on a colored ground, like the wind rows.
  MODEL: 26,
} as const;

// What counts as a FULL-SCALE period, from which everything about the two accumulation areas
// follows. Fixing it in millimetres of liquid equivalent — the row was pinned to the codec's own
// top level, 144 mm — spent nearly the whole row on rates no forecast in the window reached: a wet
// 6 hours at 5 mm drew a fifth of it, and a drizzle and a downpour landed a few pixels apart.
//
// Full scale is stated for a SIX-HOUR period, at 20 of the wire's 64 sqrt-companded steps
// (RAIN_K), and read off in the same companding the areas always used — sqrt(mm / 144) is exactly
// level / 63, so this is that curve with its top moved down.
const PRECIP_FULL_SCALE_LEVELS = 20;
const PRECIP_FULL_SCALE_6H = (PRECIP_FULL_SCALE_LEVELS / RAIN_K) ** 2; // ≈ 14.5 mm eq
const PRECIP_REF_HOURS = 6;
// Duration then moves that scale, because the same depth is a different event over a different
// span: an inch of snow in an hour is a squall, and an inch of snow in a day is a flurry that
// never stopped. It moves as the SQUARE ROOT of the period's length rather than in proportion to
// it — the depth–duration shape real precipitation follows, since nothing holds its peak rate for
// a whole day. Proportional would be plotting a bare rate, which pins full scale for a 6-hour
// period at six times an hourly one and flattens every ordinary wet day back into the floor;
// leaving duration out is what put an hour of snow and a day of it at the same height.
const precipFullScale = (stepHours: number) =>
  PRECIP_FULL_SCALE_6H * Math.sqrt(Math.max(1, stepHours) / PRECIP_REF_HOURS);
// A period as a fraction of what its own duration counts as full: 1 is a full-scale period.
const precipNorm = (mmEq: number, stepHours: number) =>
  Math.max(0, mmEq) / precipFullScale(stepHours);
// The window's own peak takes the top back over once it passes full scale, so a genuine storm is
// never clipped — it just compresses everything under it, which is what a storm does to a row.
const precipScaleOf = (peakNorm: number) => Math.max(1, peakNorm);
const accumFrac = (norm: number, scale: number) => Math.min(1, Math.sqrt(norm / scale));
// Where a precip row's amount sits, from the row's top — the MIDDLE of the digits, which is what
// centerText takes (it works the baseline out from the font). Down near the floor of the row, so
// the number reads as a label lying on the area rather than as a value floating over it. The rail
// reads this too (legendCy), so "in" sits on the same line as the amounts it names.
const PRECIP_VALUE_Y = ROW_H.PRECIP - 10;
// Headroom over a full-scale period, so an area at the top of its scale still reads as an area
// with a top edge rather than as a filled row.
const PRECIP_PLOT_PAD = 4;
// The hairline along that top edge (C.rainEdge / C.snowEdge). Under a pixel: at a full one the
// edge read as a curve drawn over the wash rather than as the boundary of it. Weight is width
// times contrast, and the contrast is the half doing the work at night, so it is the width that
// comes off — a sub-pixel stroke antialiases to a fainter line of the same color rather than to a
// thinner one, which is exactly the softening wanted here.
const PRECIP_EDGE_W = 0.75;

// The freezing-level row plots the 0°C isotherm over the full row height, with its per-column
// altitudes centered on the row — the curve passes behind them. Like the temperature area, the plot
// is normalized to this forecast's own range — but floored at a minimum span, since a level that
// holds within a couple of hundred metres should read as flat rather than as amplified noise, and
// with headroom so the curve doesn't ride either edge of the row.
const FREEZE_PAD = 4;
const FREEZE_MIN_SPAN_M = 700;
const FREEZE_HEADROOM = 1.2;

// Overview-strip band heights, stacked top to bottom: a per-day calendar header (day of
// month) over the mini temperature / precip / wind graphs.
// Each header band is taller than its text so the rows breathe; the row tops are derived here so
// the draw sites don't repeat the arithmetic.
const STRIP_PAD_T = 8;
const STRIP_DATE_H = 18;
const STRIP_GLYPH_H = 20;
const STRIP_TVAL_H = 14;
const STRIP_DATE_Y = STRIP_PAD_T;
const STRIP_HEAD_H = STRIP_DATE_Y + STRIP_DATE_H;
// The day's summary glyph and high sit *on* the temperature silhouette rather than in a band of
// their own: they annotate the curve, and stacking them above it spent 34px of a 132px strip on
// what the graph could carry underneath. The silhouette gets that space instead — near twice the
// amplitude it had in a band of its own, which is what makes a shape legible at strip scale. The
// zone is deep enough that the curve still has room to move below the two lines of text.
const STRIP_GLYPH_Y = STRIP_HEAD_H;
const STRIP_TVAL_Y = STRIP_GLYPH_Y + STRIP_GLYPH_H;
// Trimmed under the day's high rather than sized to the glyph stack alone: the glyph (20) and
// high (14) end 34px in, leaving 8px of curve-only zone at the bottom of the band.
const STRIP_TEMP_H = 42;
const STRIP_PRECIP_H = 13;
// Height of one precip mark, and the grid the marks sit on: every six hours that carry any
// precipitation get a mark, whatever resolution the fill used there. The grid is fixed in time
// rather than in periods, so how many marks an event draws is how many hours it lasts — a 12h
// period of rain spans two segments and draws two drops. Six hours rather than three because at
// three the segments fall to ~4px on a 12-day forecast and the marks pile into each other; six
// leaves them just touching there, and comfortably apart on a short one.
const STRIP_MARK_H = 8;
const STRIP_SEGMENT_H = 6;
// The wind band sits on a white panel of its own rather than on the strip's dark ground: the ribbon
// fades to transparent under a light breeze, and on the dark ground a calm stretch was
// indistinguishable from a stretch with no wind data at all. On white a calm stretch reads as
// deliberately empty. Its corners are eased rather than fully rounded — a half-height radius made a
// pill, which at 9px tall pinched the ribbon's first and last columns to a sliver.
const STRIP_WIND_H = 9;
const STRIP_WIND_R = 2;
// The resolution band along the very bottom: one block per period on the strip's time-linear axis.
const STRIP_RES_H = 7;
// Gap between adjacent resolution blocks, in px. Small enough that hourly periods — a couple of
// px wide at strip scale — still leave something to draw.
const STRIP_RES_GAP = 1;
// The graph bands below the calendar header — the span the viewport window brackets. The
// temperature zone is one of them now, so the window brackets the glyph and high along with it.
const STRIP_GRAPH_H = STRIP_TEMP_H + STRIP_PRECIP_H + STRIP_WIND_H + STRIP_RES_H;
const STRIP_H = STRIP_HEAD_H + STRIP_GRAPH_H;
// Height of the docked assembly that floats beneath the parked location map: the overview strip
// plus the pinned date plate. HomeScreen uses it to end the map's park at exactly the scroll
// offset where this assembly's own clamp ends, so the whole stack — map slice, strip, plate —
// starts riding off the screen together as a block's last rows run out.
export const PINNED_STACK_H = STRIP_H + ROW_H.DATE;

// ── Palette ──────────────────────────────────────────────────────────────--

const C = {
  night: '#eceef3',
  grid: '#f0f1f4',
  // A step darker than the grid: the day divider crosses shaded cells and fill-encoded rows, where
  // the grid's near-white disappears.
  divider: '#d9dade',
  keyBg: '#e5e5ea',
  section: '#eef1f6',
  sectionText: '#8a8f99',
  label: '#2c2c2e',
  unit: '#9aa0aa',
  date: '#48484a',
  hour: '#8e8e93',
  nil: '#d1d1d6',
  dirArrow: '#5b7a9d',
  // The two sides of the 0°C isotherm: sub-freezing air above the level, above-freezing air below
  // it. Both washes are faint — the row still carries its altitude labels, and the day dividers and
  // column highlight cross it — so they read as a tint on white rather than as a filled chart.
  freezeCold: 'rgba(74, 144, 214, 0.16)',
  freezeWarm: 'rgba(214, 82, 62, 0.14)',
  // The isotherm itself, dark enough to hold its shape against both washes.
  freezeLine: '#7e8896',
  // The two precip inks, for the numbers each precip row prints (the rail's marks stay grey — see
  // LEGEND_MARK_COLORS). Snow is the lighter of the pair, matching the two areas: it kept its color
  // from the stacked area the two rows replaced, where snow lay over rain as the paler band.
  rainInk: '#1d5182',
  snowInk: '#4f82ae',
  // The areas themselves, each a wash well clear of its own ink. Rain used to be plotted in the
  // mid-blue it carried as the lower band of the stacked area, where nothing was written on it —
  // as its own row it has numbers lying across it, and dark blue on that blue was about 2:1. The
  // numbers sit low and a shallow period's fill doesn't reach them, so that was fixed by lightening
  // the ground rather than the text, which would then be white on white.
  //
  // The pair is then set as far apart as those numbers allow: rain as blue as it can be under a
  // legible ink (3.9:1), snow as close to white. Side by side they separate 1.8:1, where the first
  // pass at this left them a barely-there 1.3:1 — two washes of the same water.
  rainArea: '#7fb8e6',
  snowArea: '#e3f1fb',
  // A hairline along the top of each area, a step darker than the wash under it. It is what draws
  // the shape where the ground behind it changes: night shading tints the row's white a grey that
  // the snow wash cannot be told from (1.01:1), and an area with no edge simply disappears into
  // the small hours. Both edges also clear the night tint itself — 1.8:1 for snow, 2.8:1 for rain
  // — so the curve holds its line across a day/night boundary instead of fading at it.
  rainEdge: '#4f95cf',
  snowEdge: '#8fbade',
  // The chance curve. Grey rather than either precip ink, and unfilled: the row is a probability,
  // and anything blue and filled under it would be read as the water the two rows below it carry.
  chanceLine: '#7b8ea6',
  // The forecast point's own elevation, drawn across the cloud band: the band's floor is 1000 hPa
  // everywhere, so on high ground a good part of the plot is air that is underground there. Red is
  // the one warm ink among the band's greys, and the dashes keep it reading as a reference line
  // laid over the contours rather than as another cloud edge.
  groundLine: 'rgba(198, 60, 44, 0.85)',
  // Its label, in the same red at full strength: at 10.5px the line's alpha would thin the text to
  // a blush, and the number has to hold against the cloud fill it may be lying on.
  groundText: '#c63c2c',
} as const;

// The overview strip runs on a dark ground: at strip scale the graphs are a few pixels tall, and a
// dark backdrop makes the temperature silhouette, precip area and wind ribbon read as one lit
// graphic above the light meteogram. Text and clouds lighten to suit. The strip carries neither
// day/night shading nor day separators — at this scale both fought the silhouette; the main canvas
// below still shows them.
const SC = {
  bg: '#4d4d4d',
  label: '#ffffff',
  window: '#ff3b30',
  rung: 'rgba(255,255,255,0.45)',
  // Precip marks sit a step off the ground rather than in the icon set's rain blue: there can be
  // dozens of them across the band, and at that count a saturated blue outshouts the temperature
  // silhouette and wind ribbon it's meant to annotate. Shape says rain or snow; color says little.
  // Opaque, not translucent white: heavy rates deliberately overlap the marks, and alpha would
  // compound in the overlaps and blotch a drift that should read as one flat mass. These are the
  // colors a 50%/68% white wash over `bg` resolves to. The flake is drawn in sub-pixel strokes
  // where the drop is a solid fill, so it takes the lighter of the two to carry the same weight.
  precipRain: '#a6a6a6',
  precipSnow: '#c6c6c6',
  windBg: '#ffffff',
} as const;

// Bundled for precipMark, whose mixed mark needs both at once — plus the ground it strokes against
// to hold the two halves of the split apart. The precip band sits on flat `bg`, below the
// temperature silhouette and above the wind ribbon, so nothing else shows through there.
const STRIP_MARK_COLORS = { rain: SC.precipRain, snow: SC.precipSnow, ground: SC.bg };

const MODEL_COLORS: Record<string, string> = {
  'Auto': '#2a6bb5',
  'American (NOAA)': '#2a8f5a',
  'Canadian (GEM)': '#c0102a',
  'European (ECMWF)': '#7040b0',
};

// The selector option each display name stands for, which is what the model row is attributed
// against (MODEL_NAMES, by MODEL_BIT order).
const MODEL_CENTERS: Record<string, Center> = {
  'Auto': 'best',
  'American (NOAA)': 'us',
  'Canadian (GEM)': 'ca',
  'European (ECMWF)': 'eu',
};

// ── Weather code classification ──────────────────────────────────────────--

// 68/69 (rain and snow mixed) rank with snow: they carry the same wcClass on the wire, and a
// mixed period is the one you want treated as wintry when a day glyph has to pick one sky.
const SNOW_CODES = new Set([56, 57, 66, 67, 68, 69, 71, 73, 75, 77, 85, 86]);
const RAIN_CODES = new Set([51, 53, 55, 61, 63, 65, 80, 81, 82, 95, 96, 99]);

// Coverage (0–100) implied by a weather code, for the cloud glyph shading.
function codeCoverage(code: number): number {
  if (code === 0) return 0;
  if (code === 1) return 25;
  if (code === 2) return 55;
  if (code === 3) return 95;
  if (code === 45 || code === 48) return 90; // fog
  return 85; // anything precipitating is heavily clouded
}

// Day-summary severity, so a day's overview glyph shows its most eventful sky rather than the
// first period's. Precipitating and thundery skies outrank fog, which outranks plain cloud cover.
function codeSeverity(code: number): number {
  if (code >= 95) return 100;
  if (SNOW_CODES.has(code)) return 90;
  if (RAIN_CODES.has(code)) return 80;
  if (code === 45 || code === 48) return 40;
  return codeCoverage(code) / 10;
}

// Arrows point in the direction the wind blows toward.
const ARROWS: Record<string, string> = {
  N: '↓', NE: '↙', E: '←', SE: '↖',
  S: '↑', SW: '↗', W: '→', NW: '↘',
};

type ColorStop = [number, [number, number, number]];

// Temperature → color stops (°C), interpolated for a smooth blue→red scale.
const TEMP_STOPS: ColorStop[] = [
  [-15, [91, 58, 158]],
  [-5, [58, 95, 191]],
  [3, [42, 134, 200]],
  [11, [38, 158, 122]],
  [18, [122, 158, 42]],
  [24, [212, 144, 32]],
  [30, [212, 96, 42]],
  [38, [192, 48, 42]],
];

function lerp(a: number, b: number, t: number): number {
  return Math.round(a + (b - a) * t);
}

function rgb([r, g, b]: [number, number, number], alpha = 1): string {
  return alpha < 1 ? `rgba(${r}, ${g}, ${b}, ${alpha})` : `rgb(${r}, ${g}, ${b})`;
}

// Piecewise-linear interpolation over color stops, clamped past either end.
function rampRgb(stops: ColorStop[], v: number): [number, number, number] {
  const last = stops[stops.length - 1];
  if (!(v > stops[0][0])) return stops[0][1];
  if (v >= last[0]) return last[1];
  for (let i = 0; i < stops.length - 1; i++) {
    const [v0, c0] = stops[i];
    const [v1, c1] = stops[i + 1];
    if (v <= v1) {
      const t = (v - v0) / (v1 - v0);
      return [lerp(c0[0], c1[0], t), lerp(c0[1], c1[1], t), lerp(c0[2], c1[2], t)];
    }
  }
  return last[1];
}

function tempColor(c: number, alpha = 1): string {
  return rgb(rampRgb(TEMP_STOPS, c), alpha);
}

function hexRgb(hex: string): [number, number, number] {
  const n = parseInt(hex.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

// Wind speed → color stops (mph), interpolated: a hue sweep from azure through green and amber to
// hot pink. Fit to a sampled reference ribbon — that ribbon blends in value space, so reading it
// across the gradient recovers the scale at sub-mph resolution rather than one point per column.
// Stops up to 41 mph track that sample to ~2/255 mean channel error.
//
// Above 41 mph the scale nearly stalls — a second reference reaching 98 mph shows the hue drifting
// only ~13° further into magenta while brightness eases off. That reference renders the whole scale
// desaturated (S≈0.77 against 0.97 here) but agrees on hue to within a degree at the join, so the
// tail is its measured drift replayed at this scale's saturation. Past 98 mph the same slow drift
// is extrapolated on.
const WIND_STOPS: ColorStop[] = ([
  [8, '#07cef6'], [10, '#09d5d7'], [11, '#03e1a0'], [11.5, '#04e960'],
  [13.5, '#07e915'], [15, '#10e804'], [18.5, '#7ad702'], [21, '#d8bb01'],
  [22.5, '#f6af02'], [26.5, '#ff890a'], [31.5, '#ff5b29'], [35, '#ff3553'],
  [41, '#ff0790'],
  [52, '#fd0794'], [60, '#f90799'], [75, '#f407a4'], [91, '#eb06af'],
  [98, '#e806b4'], [130, '#d806c6'], [170, '#b305c5'],
] as [number, string][]).map(([mph, hex]) => [mph, hexRgb(hex)]);

// The ribbon fades out under a light breeze: invisible at WIND_FADE_LO, fully saturated at
// WIND_FADE_HI. A calm stretch reads as blank rather than as a band of color, so the eye lands on
// the columns that are actually windy. The value labels do not fade — they stay black throughout.
const WIND_FADE_LO = 6;
const WIND_FADE_HI = 10;
const WIND_INK = '#000000';

// ── Air quality ────────────────────────────────────────────────────────────
// Two scales, two palettes, kept in separate tables on purpose: the US index puts its first break
// at 50 and its worst category above 300, the European index breaks every 20 and calls anything
// over 100 extremely poor. Running one through the other's thresholds would paint clean air
// orange, or a genuinely bad day green.
//
// The OFFICIAL palettes, not approximations of them — these exact colors are what a reader has
// already learned to read on AirNow, on the EEA's map, and in every phone weather app, and that
// recognition is most of what the row is for. Boundaries, names and colors all come from the
// publishers:
//   US  — EPA/AirNow, https://docs.airnowapi.org/aq101 (breaks at 50/100/150/200/300)
//   EU  — the EEA's European AQI, as documented in Google's Air Quality API reference
//         (https://developers.google.com/maps/documentation/air-quality/laqis); breaks every 20
//         to 100, matching Open-Meteo's european_aqi definition, which is what we decode.
//
// Ink per band, dark on the light fills and white on the dark ones — chosen by measured luminance
// at the draw site, except where `ink` pins it.
interface AqBand { max: number; color: string; name: string; ink?: string }
const AQ_BANDS: Record<'us' | 'eu', AqBand[]> = {
  us: [
    { max: 50, color: '#00e400', name: 'Good' },
    { max: 100, color: '#ffff00', name: 'Moderate' },
    { max: 150, color: '#ff7e00', name: 'Unhealthy for sensitive groups' },
    // The one band where the measurement and the eye disagree. Black clears 5.25:1 on pure red
    // and white only 4.00:1, but black on saturated red reads muddy and vibrates at 11.5px, so
    // white is pinned here deliberately: below AA for normal text on this band alone, well clear
    // of the 3:1 floor, and the reading is repeated in the detail panel. Delete `ink` to go back
    // to the measured choice.
    { max: 200, color: '#ff0000', name: 'Unhealthy', ink: '#ffffff' },
    { max: 300, color: '#8f3f97', name: 'Very unhealthy' },
    { max: Infinity, color: '#7e0023', name: 'Hazardous' },
  ],
  // Cyan-to-purple where the US ramp is green-to-maroon, which is the two scales' own doing and
  // happens to be exactly what keeps the rows from reading as one scale when both are shown.
  eu: [
    { max: 20, color: '#50f0e6', name: 'Good' },
    { max: 40, color: '#50ccaa', name: 'Fair' },
    { max: 60, color: '#f0e641', name: 'Moderate' },
    { max: 80, color: '#ff5050', name: 'Poor' },
    { max: 100, color: '#960032', name: 'Very poor' },
    { max: Infinity, color: '#7d2181', name: 'Extremely poor' },
  ],
};
const aqBand = (value: number, scale: 'us' | 'eu'): AqBand =>
  AQ_BANDS[scale].find((b) => value < b.max) ?? AQ_BANDS[scale][AQ_BANDS[scale].length - 1];

// Which CAMS domain served, predicted from the location the way the model row predicts the
// weather centers — the response carries no domain id, and it isn't worth wire bits. Open-Meteo's
// `domains=auto` takes the European ensemble where it reaches and the global model everywhere
// else, and the two differ enough to be worth naming: 0.1° hourly against 0.4° three-hourly, which
// at a 38px column is the difference between a forecast that resolves a valley and one that
// averages a county. Bounds are the CAMS regional domain, 25W/30N/45E/72N since June 2019.
// Europe's horizon is 4 days and the global model's 5 — both at or past the wire's own 96h clamp,
// so the row's length doesn't depend on which one answered.
const CAMS_EUROPE_BOUNDS = { west: -25, east: 45, south: 30, north: 72 };
function camsDomain(lat: number, lon: number): string {
  const b = CAMS_EUROPE_BOUNDS;
  return lat >= b.south && lat <= b.north && lon >= b.west && lon <= b.east
    ? 'CAMS Europe 11km'
    : 'CAMS Global 45km';
}

function windAlpha(mph: number): number {
  const t = Math.min(1, Math.max(0, (mph - WIND_FADE_LO) / (WIND_FADE_HI - WIND_FADE_LO)));
  return Number((t * t * (3 - 2 * t)).toFixed(3)); // smoothstep, so both ends ease
}

function windColor(kph: number): string {
  const mph = kph / 1.60934;
  return rgb(rampRgb(WIND_STOPS, mph), windAlpha(mph));
}

// Serving-model bands are shaded by the model's grid spacing rather than by its identity: what a
// reader wants off this row at a glance is how fine the forecast under a stretch of columns is,
// and the km number the band carries then reads as its own legend. Deep for a convective-scale
// model, pale for a global one. It also keeps the row honest where a chain's resolution is not
// monotonic — over the Alps Open-Meteo runs the whole DWD ladder (2 › 7 › 13 km) before falling
// back to IFS at 9 km, and the band lightens and re-darkens exactly as the numbers do.
//
// The ramp steps across its middle rather than sweeping through it: between 3 and 5 km it jumps
// the luminance band where neither a white nor a black label clears 4.5:1 (see bandInk). Nothing
// Open-Meteo serves has a grid spacing in that gap — the short-range models sit at 1–3 km and the
// regional and global ones at 5 km and up — so the jump costs no distinction that exists.
const MODEL_RES_STOPS: ColorStop[] = [
  [1, [40, 78, 126]],
  [3, [72, 112, 160]],
  [5, [126, 163, 200]],
  [13, [172, 197, 220]],
  [25, [206, 220, 233]],
];

function modelBandRgb(spec: ModelSpec | null): [number, number, number] {
  // No model reaches a period only past the last horizon in the chain — Canada's stack ends at
  // GDPS's 240h inside a longer window. The band takes the key column's own gray there: the row
  // has nothing to name, which is different from naming a coarse model.
  return spec ? rampRgb(MODEL_RES_STOPS, spec.resKm) : hexRgb(C.keyBg);
}

// Ink for a band: white on the deep near-term colors, near-black on the pale far-term ones.
// Whichever of the two contrasts better, which is the WCAG relative luminance either side of
// √(0.05 · 1.05) − 0.05 — the point where a white and a black label read equally well. Worth
// computing rather than eyeballing: a mid blue reads as a dark ground and takes white text at
// barely 4.4:1, where black on the same ground is 11.5:1.
const INK_CROSSOVER = Math.sqrt(0.05 * 1.05) - 0.05;
function bandInk(channels: [number, number, number]): string {
  const [r, g, b] = channels.map((c) => {
    const s = c / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b > INK_CROSSOVER ? '#1c1c1e' : '#ffffff';
}

// Runs of consecutive columns that have a value, so gaps stay gaps.
function valueRuns(n: number, has: (i: number) => boolean): number[][] {
  const runs: number[][] = [];
  let run: number[] = [];
  for (let i = 0; i < n; i++) {
    if (has(i)) run.push(i);
    else if (run.length) { runs.push(run); run = []; }
  }
  if (run.length) runs.push(run);
  return runs;
}

// A run of consecutive periods reporting the same dominant pollutant. Held apart from the scene
// for the same reason model bands are: the label is drawn as RN text outside the canvas so it can
// stick to the visible edge, and a run can be wider than the screen.
interface DominantSegment { start: number; end: number; label: string }
function dominantSegments(periods: Period[], kind: AqDominantKind): DominantSegment[] {
  const { field, value, scale } = AQ_DOMINANT_KEYS[kind];
  const nameOf = (i: number) => pollutantName(scale, periods[i][field] as number | undefined);
  const aqiOf = (i: number) => periods[i][value] as number | undefined;
  const segs: DominantSegment[] = [];
  for (let i = 0; i < periods.length; ) {
    const label = nameOf(i);
    if (aqiOf(i) == null || label == null) { i++; continue; }
    let j = i;
    while (j + 1 < periods.length && aqiOf(j + 1) != null && nameOf(j + 1) === label) j++;
    segs.push({ start: i, end: j + 1, label });
    i = j + 1;
  }
  return segs;
}

type Slot = { left: number; center: number; right: number };

// A run of wind columns painted as one horizontal gradient rather than a rect per column: the
// color is exact at each column's center, blends between centers, and holds flat out to the
// run's outer edges. No vertical seams, and the shade under a number still means that number.
function windRibbon(
  key: string, run: number[], slotOf: (i: number) => Slot, colorAt: (i: number) => string,
  top: number, height: number,
): ReactNode {
  const x0 = slotOf(run[0]).left;
  const x1 = slotOf(run[run.length - 1]).right;
  const span = x1 - x0;
  const first = colorAt(run[0]);
  const lastColor = colorAt(run[run.length - 1]);
  return (
    <Rect key={key} x={x0} y={top} width={span} height={height}>
      <LinearGradient
        start={vec(x0, top)} end={vec(x1, top)}
        colors={[first, ...run.map(colorAt), lastColor]}
        positions={[0, ...run.map((i) => (slotOf(i).center - x0) / span), 1]} />
    </Rect>
  );
}

// ── Unit-aware formatting (no suffix; unit lives in the row label) ──────────--

function fmtTemp(c: number | undefined, u: UnitPrefs): string {
  if (c == null) return '';
  return u.temp === 'f' ? `${Math.round((c * 9) / 5 + 32)}°` : `${Math.round(c)}°`;
}
// Below the resolution the column can print, a measurable amount says so rather than printing
// nothing: the area is visibly off the floor in those periods, and a blank under a raised curve
// reads as data the message didn't carry instead of as a trace. Only ever below — an amount that
// rounds to the smallest printable figure prints that figure, and a period with nothing in it
// prints nothing at all.
function fmtSnow(cm: number, u: UnitPrefs): string {
  if (u.snow === 'in') {
    const inches = cm / 2.54;
    if (inches >= 0.1) return `${inches.toFixed(inches < 1 ? 1 : 0)}`;
    return cm > 0 ? '<0.1' : '';
  }
  if (cm >= 0.5) return `${Math.round(cm)}`;
  return cm > 0 ? '<0.5' : '';
}
function fmtRain(mm: number, u: UnitPrefs): string {
  if (u.rain === 'in') {
    const inches = mm / 25.4;
    if (inches >= 0.01) return `${inches.toFixed(2)}`;
    return mm > 0 ? '<0.01' : '';
  }
  if (mm >= 0.5) return `${mm < 10 ? mm.toFixed(1) : Math.round(mm)}`;
  return mm > 0 ? '<0.5' : '';
}
// Column labels are abbreviated to thousands ("14k", "13.5k") — a grouped "14,000" outgrows the
// cell. Metric already fits at 100 m granularity.
function fmtFreeze(m: number | undefined, u: UnitPrefs): string {
  if (m == null) return '';
  if (u.altitude === 'ft') {
    const ft = Math.round((m * 3.28084) / 500) * 500;
    return ft < 1000 ? `${ft}` : `${(ft / 1000).toFixed(ft % 1000 === 0 ? 0 : 1)}k`;
  }
  return `${Math.round(m / 100) * 100}`;
}
// Whole numbers in every unit: the wire carries wind as Beaufort forces and the decoder hands
// back band midpoints, so a decimal would be precision the message never had. Beaufort itself
// reads the force straight back off the midpoint — the only display with nothing rounded.
function fmtWind(kph: number | undefined, u: UnitPrefs): string {
  if (kph == null) return '';
  switch (u.wind) {
    case 'mph': return `${Math.round(kph / 1.60934)}`;
    case 'kmh': return `${Math.round(kph)}`;
    case 'ms': return `${Math.round(kph / 3.6)}`;
    case 'kt': return `${Math.round(kph / 1.852)}`;
    case 'bft': return `${quantWind(kph)}`;
  }
}

// Detail-panel variants: unit-suffixed and never blanked — the panel must show the trace
// amounts the column labels drop below their display thresholds.
function fmtRainFull(mm: number, u: UnitPrefs): string {
  if (u.rain === 'in') {
    if (mm <= 0) return '0 in';
    const inches = mm / 25.4;
    return inches < 0.01 ? '<0.01 in' : `${inches.toFixed(2)} in`;
  }
  if (mm <= 0) return '0 mm';
  return `${mm < 10 ? mm.toFixed(1) : Math.round(mm)} mm`;
}
function fmtSnowFull(cm: number, u: UnitPrefs): string {
  if (u.snow === 'in') {
    if (cm <= 0) return '0 in';
    const inches = cm / 2.54;
    return inches < 0.1 ? '<0.1 in' : `${inches.toFixed(1)} in`;
  }
  if (cm <= 0) return '0 cm';
  return `${cm < 10 ? cm.toFixed(1) : Math.round(cm)} cm`;
}
// A height above sea level to the nearest 500 ft / 100 m, with its unit.
function fmtAltitudeFull(m: number, unit: AltitudeUnit): string {
  const v = unit === 'ft' ? Math.round((m * 3.28084) / 500) * 500 : Math.round(m / 100) * 100;
  return `${v.toLocaleString()} ${unit}`;
}
function fmtFreezeFull(m: number | undefined, u: UnitPrefs): string {
  if (m == null) return '—';
  return fmtAltitudeFull(m, u.altitude);
}
// A pressure level in full, on the reader's level unit and only that: its standard-atmosphere
// height ("18,000 ft") or the pressure itself ("500 hPa"). One reading, the one they asked for —
// the rail names the same level in the same unit, in its short rung form (ladderLabel).
function fmtLevelFull(hpa: number, u: UnitPrefs): string {
  return u.level === 'hpa' ? pressureLabel(hpa) : fmtAltitudeFull(pressureToMeters(hpa), u.level);
}
// The cloud band's ground line names its own altitude. A straight conversion of the header's
// meters, to the foot — the SAME arithmetic the decoder's forecast summary does (elevationLabel),
// so one message's elevation reads the same in both places. The wire quantizes it to 100 m steps,
// which is coarser than either reading suggests; rounding the feet to the hundred here doesn't
// recover that (100 m is 328 ft), it only makes the band and the summary disagree about one field.
function fmtElevation(m: number, u: UnitPrefs): string {
  const v = u.altitude === 'ft' ? Math.round(m * 3.28084) : Math.round(m);
  return `${v.toLocaleString()} ${u.altitude}`;
}
function fmtWindFull(kph: number | undefined, dir: number | undefined, u: UnitPrefs): string {
  if (kph == null) return '—';
  const cardinal = dir != null ? CARDINALS[dir] : undefined;
  const dirText = cardinal ? ` ${ARROWS[cardinal] ?? ''} ${cardinal}` : '';
  return `${fmtWind(kph, u)} ${windUnit(u)}${dirText}`;
}

function tempUnit(u: UnitPrefs) { return u.temp === 'f' ? '°F' : '°C'; }
const WIND_UNIT_LABELS: Record<UnitPrefs['wind'], string> = { mph: 'mph', kmh: 'km/h', ms: 'm/s', kt: 'kt', bft: 'bft' };
function windUnit(u: UnitPrefs) { return WIND_UNIT_LABELS[u.wind]; }

// Every label below reads a ZONED date: a Date displaced by the forecast point's UTC offset, so
// that its UTC fields spell out the wall clock at the forecast point rather than at the device (see
// `zonedDates`). They are only ever labels — the instants themselves stay absolute, in `dates`.
const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
function dayLabel(d: Date): string { return `${DAYS[d.getUTCDay()]} ${d.getUTCDate()}`; }

// The detail panel names the day in full — it has a line to itself there, and the bare date the
// header column is reduced to reads as a number without a month beside it.
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December'];
function ordinal(n: number): string {
  const teen = n % 100;
  if (teen >= 11 && teen <= 13) return `${n}th`;
  return `${n}${['th', 'st', 'nd', 'rd'][n % 10] ?? 'th'}`;
}
function fullDateLabel(d: Date): string {
  return `${DAYS[d.getUTCDay()]} ${MONTHS[d.getUTCMonth()]} ${ordinal(d.getUTCDate())}`;
}

// A day's header has only that day's columns to sit in, and the first and last days of a forecast
// are usually partial — a day that starts at 10pm gets two hourly columns, 76px, where "Wednesday
// 24" needs around 90. So the label steps down through shorter forms until one fits: the weekday
// abbreviates, then drops out entirely. The date is what identifies the column either way, and the
// weekday of a partial day is readable from the full day beside it.
function fitDayLabel(d: Date, available: number, font: SkFont): string {
  const forms = [dayLabel(d), `${DAYS[d.getUTCDay()].slice(0, 3)} ${d.getUTCDate()}`, `${d.getUTCDate()}`];
  return forms.find((f) => font.getTextWidth(f) <= available) ?? forms[forms.length - 1];
}
// The hour splits into the number and its meridiem so the two can be drawn at different sizes.
function hourParts(d: Date, step: number, timeFormat: TimeFormat): { num: string; suffix: string } {
  if (step >= 24) return { num: '', suffix: '' };
  const hour = d.getUTCHours();
  if (timeFormat === '24h') return { num: `${hour}`, suffix: '' };
  return { num: `${hour % 12 || 12}`, suffix: hour < 12 ? 'AM' : 'PM' };
}
function hourLabel(d: Date, step: number, timeFormat: TimeFormat): string {
  const { num, suffix } = hourParts(d, step, timeFormat);
  return num + suffix;
}
// Wall clock to the minute, for instants that don't land on the column grid — the rise and set
// times. `d` is zoned, like every other label here.
function clockLabel(d: Date, timeFormat: TimeFormat): string {
  const hour = d.getUTCHours();
  const minute = `${d.getUTCMinutes()}`.padStart(2, '0');
  if (timeFormat === '24h') return `${`${hour}`.padStart(2, '0')}:${minute}`;
  return `${hour % 12 || 12}:${minute} ${hour < 12 ? 'AM' : 'PM'}`;
}

const RAD = Math.PI / 180;
// Apparent horizons, as altitudes of the body's center. The sun's -0.833° accounts for refraction
// and its visible radius; the moon's +0.125° is the same pair of corrections against its mean
// horizontal parallax, which lifts the geometric horizon rather than lowering it.
const SUN_HORIZON = -0.833 * RAD;
const MOON_HORIZON = 0.125 * RAD;

// Altitude above the horizon of a body at ecliptic longitude/latitude, seen from lat/lon.
// `days` is the time in days since J2000.
function horizonAltitude(days: number, lat: number, lon: number, eclipticLongitude: number, eclipticLatitude: number): number {
  const obliquity = (23.439 - 0.0000004 * days) * RAD;
  const rightAscension = Math.atan2(
    Math.sin(eclipticLongitude) * Math.cos(obliquity) - Math.tan(eclipticLatitude) * Math.sin(obliquity),
    Math.cos(eclipticLongitude),
  );
  const declination = Math.asin(
    Math.sin(eclipticLatitude) * Math.cos(obliquity)
      + Math.cos(eclipticLatitude) * Math.sin(obliquity) * Math.sin(eclipticLongitude),
  );
  const siderealTime = (280.46061837 + 360.98564736629 * days + lon) * RAD;
  const hourAngle = siderealTime - rightAscension;
  const latitude = lat * RAD;
  return Math.asin(
    Math.sin(latitude) * Math.sin(declination)
      + Math.cos(latitude) * Math.cos(declination) * Math.cos(hourAngle),
  );
}

function julianDays(time: number): number {
  return time / 86400000 + 2440587.5 - 2451545;
}

// Solar altitude using the standard low-precision solar-position equations — good to about a
// minute of arc, which places sunrise within a few seconds.
function sunAltitude(time: number, lat: number, lon: number): number {
  const days = julianDays(time);
  const meanLongitude = (280.46 + 0.9856474 * days) * RAD;
  const anomaly = (357.528 + 0.9856003 * days) * RAD;
  const eclipticLongitude = meanLongitude + (1.915 * Math.sin(anomaly) + 0.02 * Math.sin(2 * anomaly)) * RAD;
  return horizonAltitude(days, lat, lon, eclipticLongitude, 0);
}

// Lunar altitude from the leading terms of the lunar theory: mean longitude with the evection-free
// principal equation of the center, and the principal term of the ecliptic latitude. Good to a few
// arcminutes, which is a couple of minutes of moonrise — well inside what a forecast panel claims.
function moonAltitude(time: number, lat: number, lon: number): number {
  const days = julianDays(time);
  const meanLongitude = (218.316 + 13.176396 * days) * RAD;
  const anomaly = (134.963 + 13.064993 * days) * RAD;
  const argumentOfLatitude = (93.272 + 13.229350 * days) * RAD;
  const eclipticLongitude = meanLongitude + 6.289 * RAD * Math.sin(anomaly);
  const eclipticLatitude = 5.128 * RAD * Math.sin(argumentOfLatitude);
  return horizonAltitude(days, lat, lon, eclipticLongitude, eclipticLatitude);
}

function isNight(time: number, lat: number, lon: number): boolean {
  return sunAltitude(time, lat, lon) < SUN_HORIZON;
}

// Position in the synodic cycle at `time`, as a 0–1 fraction from one new moon to the next,
// anchored to the 2000-01-06 new moon. This mean cycle runs up to about half a day off a true
// phase instant — precise enough for a phase name, an illuminated fraction, and the compact glyph,
// and it avoids another astronomy dependency in the mobile bundle.
function moonCycleAt(time: number): number {
  const synodicMonthMs = 29.530588853 * 86400000;
  const knownNewMoon = Date.UTC(2000, 0, 6, 18, 14);
  const elapsed = (((time - knownNewMoon) % synodicMonthMs) + synodicMonthMs) % synodicMonthMs;
  return elapsed / synodicMonthMs;
}

// The eight the cycle quantizes to. MoonPhase carries two further legacy aliases that nothing
// produces, so this narrower union — not MoonPhase — is what a phase name has to be written for.
const MOON_PHASES = [
  'new', 'waxing-crescent', 'first-quarter', 'waxing-gibbous',
  'full', 'waning-gibbous', 'last-quarter', 'waning-crescent',
] as const satisfies readonly MoonPhase[];
type CyclePhase = (typeof MOON_PHASES)[number];

function moonPhaseAt(time: number): CyclePhase {
  return MOON_PHASES[Math.floor(moonCycleAt(time) * 8 + 0.5) % MOON_PHASES.length];
}

// Times in [start, end] where `above` flips. A short scan brackets each crossing — no body clears
// and re-crosses the horizon inside half an hour — then binary search places it to within roughly
// one second.
function horizonCrossings(start: number, end: number, above: (time: number) => boolean): number[] {
  const crossings: number[] = [];
  const scanStep = 30 * 60000;
  let previousTime = start;
  let previousAbove = above(start);
  for (let time = Math.min(start + scanStep, end); previousTime < end; time = Math.min(time + scanStep, end)) {
    const nowAbove = above(time);
    if (nowAbove !== previousAbove) {
      let low = previousTime;
      let high = time;
      for (let i = 0; i < 16; i++) {
        const mid = (low + high) / 2;
        if (above(mid) === previousAbove) low = mid;
        else high = mid;
      }
      crossings.push((low + high) / 2);
    }
    previousTime = time;
    previousAbove = nowAbove;
  }
  return crossings;
}

// When a body crosses the horizon within a span, and whether it was up at all. `rise` and `set` are
// null when that crossing doesn't fall inside the span: the sun's polar summer and winter, but also
// the ordinary lunar month, where the moon's 24h50m day slides one of its two crossings past
// midnight roughly once a month. `everUp` disambiguates a span with no crossings at all.
interface RiseSet { rise: number | null; set: number | null; everUp: boolean }
function riseSet(start: number, end: number, altitude: (time: number) => number, horizon: number): RiseSet {
  const above = (time: number) => altitude(time) >= horizon;
  const crossings = horizonCrossings(start, end, above);
  let rise: number | null = null;
  let set: number | null = null;
  for (const time of crossings) {
    // The crossing sits on the boundary itself, so sample a moment past it to name the direction.
    if (above(time + 1000)) rise ??= time;
    else set ??= time;
  }
  return { rise, set, everUp: above(start) || crossings.length > 0 };
}

// Night portions of an arbitrary forecast period, as 0–1 fractions.
function nightSegments(start: number, end: number, lat: number, lon: number): [number, number][] {
  const crossings = horizonCrossings(start, end, (time) => isNight(time, lat, lon));
  const boundaries = [start, ...crossings, end];
  const segments: [number, number][] = [];
  for (let i = 0; i < boundaries.length - 1; i++) {
    const a = boundaries[i];
    const b = boundaries[i + 1];
    if (isNight((a + b) / 2, lat, lon)) segments.push([(a - start) / (end - start), (b - start) / (end - start)]);
  }
  return segments;
}

// Each period's start displaced by the forecast point's UTC offset, so that reading the result
// with getUTC* getters yields the wall clock a person standing at that point would keep. The
// forecast's own grid is built on those hours — the periods align to the location's midnight (see
// layout.ts) — so this is the axis the columns were laid out on, not a presentation choice.
// Absolute instants stay in `dates`: solar position, the now marker, and period midpoints are all
// answered in real time, not wall-clock time.
function zonedDates(dates: Date[], utcOffsetHours: number): Date[] {
  return dates.map((d) => new Date(d.getTime() + utcOffsetHours * 3600000));
}
// Identity of the zoned wall-clock day a column belongs to. Compared, never ordered or shown.
function zonedDayKey(d: Date): string {
  return `${d.getUTCFullYear()}-${d.getUTCMonth()}-${d.getUTCDate()}`;
}
// Midnight of a zoned date's own day, in the same displaced frame.
function zonedMidnight(d: Date): number {
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
}

// Contiguous columns that fall on the same calendar day at the forecast point. `dates` here is
// zoned, not absolute.
interface DayGroup { start: number; end: number; date: Date }
function buildDayGroups(dates: Date[]): DayGroup[] {
  const groups: DayGroup[] = [];
  dates.forEach((d, i) => {
    const previous = groups[groups.length - 1];
    if (!previous || zonedDayKey(previous.date) !== zonedDayKey(d)) {
      groups.push({ start: i, end: i + 1, date: d });
    } else {
      previous.end = i + 1;
    }
  });
  return groups;
}

function pressureLabel(level: number): string {
  return `${level} hPa`;
}

// Which WIND_LEVELS_HPA levels a message carries: those with a value on any period. Unrequested
// levels are null throughout.
function windLevelsPresent(periods: Period[]): number[] {
  return WIND_LEVELS_HPA.flatMap((_, li) => (periods.some((p) => p.wind_aloft?.[li] != null) ? [li] : []));
}

// ── Row model ──────────────────────────────────────────────────────────────

type RowKind =
  | 'clouds' | 'temp' | 'precip-chance' | 'snow' | 'rain' | 'freeze' | 'wind-sfc' | 'wind-gust' | 'wind-dir'
  | 'cloud-high' | 'cloud-mid' | 'cloud-low'
  | 'aqi' | 'aqi-pm25' | 'aqi-o3' | 'aqi-pm10' | 'aqi-no2' | 'aqi-so2'
  | 'aqi-dominant' | 'aqi-eu-dominant'
  | 'aqi-eu' | 'aqi-eu-pm25' | 'aqi-eu-o3' | 'aqi-eu-pm10' | 'aqi-eu-no2' | 'aqi-eu-so2'
  | 'wind-aloft' | 'model' | 'section' | 'cloud-band';

interface Row {
  kind: RowKind;
  height: number;
  // Section bands only — the one row kind that still carries prose, drawn across the full width.
  label: string;
  // The WORD the fixed rail writes against this row: the unit where the unit identifies the row,
  // and a short name where it doesn't — two rows both reading "mph" (wind and gust) or five all
  // reading "AQI" would name nothing. Empty where the row's own content already says what it is
  // (the weather glyphs, the dominant-pollutant bracket), where a symbol says it instead
  // (LEGEND_ICONS), and on the cloud band, which gets an altitude ladder rather than a single
  // entry.
  legend: string;
  // wind-aloft rows only: the WIND_LEVELS_HPA index the row draws.
  level?: number;
}

// The rows that make up the precip block, in the order they are drawn. They are grouped for the
// seams between them (buildScene) — they read as one block, and each one plots from a baseline the
// row under it also plots from.
const PRECIP_BLOCK = new Set<RowKind>(['snow', 'rain', 'precip-chance']);

// The cloud-cover rows and the field each one reads. Shared by the scene, which shades the cells,
// and by the selection readout, which labels them.
const CLOUD_KEYS = {
  'cloud-high': 'cloud_high',
  'cloud-mid': 'cloud_mid',
  'cloud-low': 'cloud_low',
} as const satisfies Record<string, keyof Period>;
type CloudKind = keyof typeof CLOUD_KEYS;

// The air-quality rows, each naming its pollutant and nothing else. The scale used to ride in
// every label, back when a request could ask for both indices at once and a bare "42" on adjacent
// rows would have invited exactly the comparison that doesn't hold. The scale is now a preference,
// so a forecast carries one index and the section header can say which once, for all of them.
// Order runs headline first, then its components, US before Europe. The two particulate rows sit
// together (PM2.5 then PM10, fine before coarse) because a reader comparing them is reading one
// thing — how much of what is in the air — and splitting them around ozone made that a scroll.
// This is DISPLAY order only; the wire encodes PM2.5, ozone, PM10 (see AQ_DELTA_COLUMNS in v3.ts,
// where the three residual-keyable constituents lead so both headlines can read them).
const AQ_KEYS = {
  'aqi': { field: 'aqi', label: 'AQI', scale: 'us' },
  'aqi-pm25': { field: 'aqi_pm25', label: 'PM2.5', scale: 'us' },
  'aqi-pm10': { field: 'aqi_pm10', label: 'PM10', scale: 'us' },
  'aqi-o3': { field: 'aqi_o3', label: 'O₃', scale: 'us' },
  'aqi-no2': { field: 'aqi_no2', label: 'NO₂', scale: 'us' },
  'aqi-so2': { field: 'aqi_so2', label: 'SO₂', scale: 'us' },
  'aqi-eu': { field: 'aqi_eu', label: 'AQI', scale: 'eu' },
  'aqi-eu-pm25': { field: 'aqi_eu_pm25', label: 'PM2.5', scale: 'eu' },
  'aqi-eu-pm10': { field: 'aqi_eu_pm10', label: 'PM10', scale: 'eu' },
  'aqi-eu-o3': { field: 'aqi_eu_o3', label: 'O₃', scale: 'eu' },
  'aqi-eu-no2': { field: 'aqi_eu_no2', label: 'NO₂', scale: 'eu' },
  'aqi-eu-so2': { field: 'aqi_eu_so2', label: 'SO₂', scale: 'eu' },
} as const satisfies Record<string, { field: keyof Period; label: string; scale: 'us' | 'eu' }>;

// How the header names each scale. "European" rather than "EU" because it's read as prose there,
// not as the tag on a row.
const AQ_SCALE_WORD = { us: 'US', eu: 'European' } as const;
type AqKind = keyof typeof AQ_KEYS;
const AQ_KINDS = Object.keys(AQ_KEYS) as AqKind[];

// The dominant-pollutant row: which constituent the headline above it is reporting. It sits
// directly under its headline and shares that row's colored ground — the fill is the HEADLINE's
// band, not a category of its own, so the pair reads as one block: how bad, and what it is.
const AQ_DOMINANT_KEYS = {
  'aqi-dominant': { field: 'aqi_dominant', value: 'aqi', scale: 'us' },
  'aqi-eu-dominant': { field: 'aqi_eu_dominant', value: 'aqi_eu', scale: 'eu' },
} as const satisfies Record<string, { field: keyof Period; value: keyof Period; scale: 'us' | 'eu' }>;
type AqDominantKind = keyof typeof AQ_DOMINANT_KEYS;
const AQ_DOMINANT_KINDS = Object.keys(AQ_DOMINANT_KEYS) as AqDominantKind[];
// Which headline row each dominant row follows.
const AQ_DOMINANT_FOR: Partial<Record<AqKind, AqDominantKind>> = {
  'aqi': 'aqi-dominant',
  'aqi-eu': 'aqi-eu-dominant',
};
// The wire carries a position in the scale's constituent list (AQ_DOMINANT_US/_EU in the
// protocol); these are the same pollutants written the way the rows above them are labelled.
const POLLUTANT_LABEL: Record<string, string> = {
  'pm2.5': 'PM2.5', ozone: 'O₃', pm10: 'PM10', no2: 'NO₂', so2: 'SO₂', co: 'CO',
};
const pollutantName = (scale: 'us' | 'eu', idx: number | undefined): string | undefined => {
  const ids = scale === 'us' ? AQ_DOMINANT_US : AQ_DOMINANT_EU;
  if (idx == null || idx < 0 || idx >= ids.length) return undefined;
  return POLLUTANT_LABEL[ids[idx]] ?? ids[idx];
};

function buildRows(periods: Period[], u: UnitPrefs, lat: number, lon: number): Row[] {
  const rows: Row[] = [];
  const has = (fn: (p: Period) => unknown) => periods.some((p) => fn(p) != null);
  // A precip row earns its place by carrying an amount, not by the variable being requested. The
  // decoder hands back a column of zeros for a variable that was asked for and never happened, and
  // where the stacked area could absorb that — the other half of it still had something to draw —
  // two rows cannot: a requested-but-dry snow column would stand as a blank band the height of the
  // rain row beside it.
  const hasAmount = (fn: (p: Period) => number | undefined) => periods.some((p) => (fn(p) ?? 0) > 0);
  const tU = tempUnit(u), frU = u.altitude, wU = windUnit(u);
  // A precip row's token is the unit its OWN numbers are in — the two rows don't share one in
  // metric, and that is most of why they are two rows. Neither is the unit of the area under it:
  // both areas are drawn in liquid equivalent (accumFrac).
  const snowU = u.snow;
  const rainU = u.rain;

  rows.push({ kind: 'clouds', height: ROW_H.CLOUD, label: '', legend: '' });

  const hasSurface =
    has((p) => p.precip) || has((p) => p.temp_c) ||
    has((p) => p.snow_cm) || has((p) => p.rain_mm) ||
    has((p) => p.wind_sfc_kph) || has((p) => p.wind_gust_kph);
  if (hasSurface) {
    if (has((p) => p.temp_c))
      rows.push({ kind: 'temp', height: ROW_H.TEMP, label: '', legend: tU });
    // Snow over rain, the order the freezing level's washes and the old stacked area both used:
    // frozen above liquid.
    if (hasAmount((p) => p.snow_cm)) rows.push({ kind: 'snow', height: ROW_H.PRECIP, label: '', legend: snowU });
    if (hasAmount((p) => p.rain_mm)) rows.push({ kind: 'rain', height: ROW_H.PRECIP, label: '', legend: rainU });
    // Chance closes the precip block, under the two amounts it is the odds of. Unlike them it is
    // kept on presence rather than on carrying a value above zero — a flat 0% line across the
    // window is a forecast of a dry week, where a flat zero AMOUNT is only the absence of one.
    if (has((p) => p.precip))
      rows.push({ kind: 'precip-chance', height: ROW_H.PRECIP, label: '', legend: '%' });
    // The gust row inherits the wind row's unit from the row directly above it and spends its
    // token naming itself instead — "mph" twice running says which scale, but not which row.
    if (has((p) => p.wind_sfc_kph)) rows.push({ kind: 'wind-sfc', height: ROW_H.WIND, label: '', legend: wU });
    if (has((p) => p.wind_gust_kph)) rows.push({ kind: 'wind-gust', height: ROW_H.WIND, label: '', legend: 'gust' });
    // No word: the rail draws a windsock here (LEGEND_ICONS).
    if (has((p) => p.wind_sfc_dir)) rows.push({ kind: 'wind-dir', height: ROW_H.DIR, label: '', legend: '' });
  }

  // Which model the numbers came from. Unconditional: unlike every other row this one isn't read
  // off the message — it is predicted from the location and the forecast's start, so there is
  // always something to draw.
  //
  // It sits under the always-on surface rows and above every optional group, where it reads as
  // the attribution for everything below it until something else claims otherwise — which is
  // exactly what the air-quality section header does, naming the CAMS domain for its own rows.
  // Freezing level, cloud cover and the pressure levels all come from this same center, so a band
  // above them attributes them correctly; air quality does not, and is the one block that has to
  // say so for itself.
  rows.push({ kind: 'model', height: ROW_H.MODEL, label: '', legend: 'model' });

  // Freezing level is an altitude, not a surface reading, so it heads a section of its own. The
  // unit rides in the rail with the row rather than in this header.
  if (has((p) => p.freeze_m)) {
    rows.push({ kind: 'section', height: ROW_H.SECTION, label: 'Freezing level', legend: '' });
    rows.push({ kind: 'freeze', height: ROW_H.FREEZE, label: '', legend: frU });
  }

  // The Windy-style vertical cloud band — v3 messages carry it in place of the low/mid/high
  // trio below, so exactly one of these two cloud blocks renders for any given message. Its axis
  // is the ladder of wire levels the rail draws, each rung carrying its own unit.
  // The wire clamps the band to the leading ≤3h periods, so a message can carry it on some
  // periods and not others (never the reverse of that shape); presence anywhere is what makes
  // the row. The row's height follows the message's level count — the decoded array's length,
  // which the wire truncates at one level below the forecast point.
  const bandStack = periods.find((p) => p.cloud_band)?.cloud_band;
  if (bandStack) {
    rows.push({ kind: 'section', height: ROW_H.SECTION, label: 'Clouds by altitude', legend: '' });
    rows.push({
      kind: 'cloud-band', height: ROW_H.CLOUD_BAND_SLICE * (bandScale(bandStack.length).levels.length - 1),
      label: '', legend: '',
    });
  }

  const hasCloud = has((p) => p.cloud_high) || has((p) => p.cloud_mid) || has((p) => p.cloud_low);
  if (hasCloud) {
    rows.push({ kind: 'section', height: ROW_H.SECTION, label: 'Cloud cover', legend: '' });
    if (has((p) => p.cloud_high)) rows.push({ kind: 'cloud-high', height: ROW_H.DATA, label: '', legend: 'high' });
    if (has((p) => p.cloud_mid)) rows.push({ kind: 'cloud-mid', height: ROW_H.DATA, label: '', legend: 'mid' });
    if (has((p) => p.cloud_low)) rows.push({ kind: 'cloud-low', height: ROW_H.DATA, label: '', legend: 'low' });
  }

  // One row per carried pressure level, highest first, on the cloud band's altitude ladder: each
  // row's rail token is the level's rung ("18k ft", "5.5km" — ladderLabel), the same rough band
  // the band's axis names, so a reader lines a wind row up with the cloud layer beside it. The
  // header carries the speed unit, as the surface wind rows do.
  const aloftLevels = windLevelsPresent(periods);
  if (aloftLevels.length) {
    rows.push({ kind: 'section', height: ROW_H.SECTION, label: `Pressure-level winds (${wU})`, legend: '' });
    for (const li of aloftLevels) {
      rows.push({ kind: 'wind-aloft', height: ROW_H.WIND_UPPER, label: '', legend: ladderLabel(WIND_LEVELS_HPA[li], u.level), level: li });
    }
  }

  // Air quality, below the model line and carrying its own attribution in its header: the CAMS
  // domain serving this location, then the index its numbers are on. Any subset of the variables
  // can be present — they are separate request variables — and the rows stop at the CAMS horizon,
  // roughly four days out, past which every cell is empty rather than zero.
  //
  // Grouped by scale rather than assuming one, which is only true of forecasts requested since the
  // scale became a preference. A stored message from before that can hold both indices, and one
  // header can't speak for rows on two of them.
  const aqRows = AQ_KINDS.filter((k) => has((p) => p[AQ_KEYS[k].field]));
  for (const scale of ['us', 'eu'] as const) {
    const scaleRows = aqRows.filter((k) => AQ_KEYS[k].scale === scale);
    if (!scaleRows.length) continue;
    rows.push({
      kind: 'section',
      height: ROW_H.SECTION,
      label: `Air quality (${camsDomain(lat, lon)}, ${AQ_SCALE_WORD[scale]} scale)`,
      legend: '',
    });
    for (const kind of scaleRows) {
      // Every one of these rows is in index points, so the rail names the pollutant instead —
      // the unit is the one thing they all share.
      rows.push({ kind, height: ROW_H.WIND, label: '', legend: AQ_KEYS[kind].label });
      // A headline brings its dominant-pollutant row with it — it rides the same request bit,
      // so if the headline has values this does too. Its rail token is empty: the row is a
      // caption on the headline above it and writes the pollutant's name into its own bracket.
      const dom = AQ_DOMINANT_FOR[kind];
      if (dom && has((p) => p[AQ_DOMINANT_KEYS[dom].field] as unknown))
        rows.push({ kind: dom, height: ROW_H.WIND, label: '', legend: '' });
    }
  }

  return rows;
}

// ── Serving-model attribution ──────────────────────────────────────────────

// Runs of consecutive periods served by the same model. `spec` is null past the last horizon in
// the chain.
interface ModelSegment { start: number; end: number; spec: ModelSpec | null }

/**
 * Attribute each period to the model that serves it, collapsed into runs.
 *
 * `refMs` is the instant the horizons are measured from — the forecast's own start, not the
 * clock. Which model covers a given hour depends on how old the newest full-length run is, so
 * reading it off the wall clock would let the row drift while a message sits on screen, and
 * would re-attribute a forecast pulled up days later to models that never touched it.
 *
 * A period is attributed by its midpoint. A 12h period can straddle a handoff, and the seam
 * blends the two models over three hours in any case, so no single answer is exactly right
 * there; the midpoint is the one that speaks for the most of the period.
 */
function modelSegments(
  dates: Date[], steps: number[], chain: ModelSpec[], refMs: number,
): ModelSegment[] {
  const segments: ModelSegment[] = [];
  dates.forEach((d, i) => {
    const spec = attributeHour(chain, d.getTime() + steps[i] * 1800000, refMs).model;
    const previous = segments[segments.length - 1];
    if (previous && previous.spec === spec) previous.end = i + 1;
    else segments.push({ start: i, end: i + 1, spec });
  });
  return segments;
}

// The name and grid spacing of the model behind a band, stepping down to the bare name and then
// to nothing as the band narrows. A model can serve a single period — AROME HD's 15-minute domain
// reaches about six hours, which is one column of a 12h fill — and there a clipped name would say
// less than a colored band the reader can compare against a labelled one.
function fitModelLabel(spec: ModelSpec | null, available: number, font: SkFont): string {
  const forms = spec ? [`${spec.shortLabel} ${spec.resKm}km`, spec.shortLabel] : ['—'];
  return forms.find((f) => font.getTextWidth(f) <= available) ?? '';
}

// ── Drawing helpers ────────────────────────────────────────────────────────

// Baseline offset to vertically center text of a given size at a y coordinate.
function baseline(cy: number, size: number) { return cy + size * 0.35; }

interface Fonts {
  data: SkFont; small: SkFont; date: SkFont;
  hour: SkFont; hourSuffix: SkFont;
  // The strip's header text is light-weight — at header size a thin face keeps the day columns
  // legible without competing with the glyphs below them.
  strip: SkFont;
  // Wind speeds sit on the ribbon's colored ground; a small light face keeps the numbers from
  // shouting over it in a short row.
  wind: SkFont;
  // Model names are drawn as RN text over the canvas, so this face is only ever measured — it
  // must match styles.stickyModelText for the sticky arithmetic to hold.
  model: SkFont;
}

function centerText(key: string, text: string, cx: number, cy: number, font: SkFont, color: string): ReactNode {
  if (!text) return null;
  const w = font.getTextWidth(text);
  return <Text key={key} x={cx - w / 2} y={baseline(cy, font.getSize())} text={text} font={font} color={color} />;
}

// Hour label: the number carries the reading and the meridiem only disambiguates it, so AM/PM rides
// a couple of sizes down. Both sit on the number's baseline, and the pair centers as one run.
function centerHour(
  key: string, parts: { num: string; suffix: string }, cx: number, cy: number,
  font: SkFont, suffixFont: SkFont, color: string,
): ReactNode {
  if (!parts.num) return null;
  const numW = font.getTextWidth(parts.num);
  const w = numW + (parts.suffix ? suffixFont.getTextWidth(parts.suffix) : 0);
  const x = cx - w / 2;
  const y = baseline(cy, font.getSize());
  return (
    <Group key={key}>
      <Text x={x} y={y} text={parts.num} font={font} color={color} />
      {parts.suffix
        ? <Text x={x + numW} y={y} text={parts.suffix} font={suffixFont} color={color} />
        : null}
    </Group>
  );
}

// Smooth polyline (quadratic through segment midpoints) appended to an existing path.
function smoothTo(path: ReturnType<typeof Skia.Path.Make>, pts: { x: number; y: number }[], reverse = false) {
  const p = reverse ? [...pts].reverse() : pts;
  if (p.length === 0) return;
  if (reverse) path.lineTo(p[0].x, p[0].y);
  else path.moveTo(p[0].x, p[0].y);
  for (let i = 0; i < p.length - 1; i++) {
    const mx = (p[i].x + p[i + 1].x) / 2;
    const my = (p[i].y + p[i + 1].y) / 2;
    path.quadTo(p[i].x, p[i].y, mx, my);
  }
  path.lineTo(p[p.length - 1].x, p[p.length - 1].y);
}

function glyphColor(color: string, onDark: boolean): string {
  return onDark && (color === '#ffffff' || color === C.night) ? SC.bg : color;
}

function glyphPrimitive(key: string, prim: Prim, onDark: boolean): ReactNode {
  switch (prim.kind) {
    case 'circle':
      return <Circle key={key} cx={prim.cx} cy={prim.cy} r={prim.r} color={glyphColor(prim.fill, onDark)} />;
    case 'line':
      return (
        <Line key={key} p1={vec(prim.x1, prim.y1)} p2={vec(prim.x2, prim.y2)}
          color={prim.role === 'symbol-separator' ? '#000000' : glyphColor(prim.stroke, onDark)}
          blendMode={prim.role === 'symbol-separator' ? 'clear' : undefined}
          strokeWidth={prim.width} strokeCap={prim.cap ?? 'butt'} />
      );
    case 'rrect':
      return (
        <RoundedRect key={key} x={prim.x} y={prim.y} width={prim.w} height={prim.h} r={prim.r}
          color={glyphColor(prim.fill, onDark)} />
      );
    case 'path': {
      const clearsLayer = prim.role?.endsWith('separator') ?? false;
      const parts: ReactNode[] = [];
      if (prim.fill && prim.fill !== 'none') {
        parts.push(
          <Path key={`${key}-fill`} path={prim.d}
            color={clearsLayer ? '#000000' : glyphColor(prim.fill, onDark)}
            blendMode={clearsLayer ? 'clear' : undefined} />,
        );
      }
      if (prim.stroke && prim.stroke !== 'none') {
        parts.push(
          <Path key={`${key}-stroke`} path={prim.d} style="stroke"
            color={clearsLayer ? '#000000' : glyphColor(prim.stroke, onDark)}
            blendMode={clearsLayer ? 'clear' : undefined} strokeWidth={prim.width ?? 1}
            strokeCap={prim.cap ?? 'butt'} strokeJoin="round" />,
        );
      }
      return <Group key={key}>{parts}</Group>;
    }
  }
}

// Adapter from the shared renderer-independent icon geometry to the Skia scene graph.
function cloudGlyph(
  key: string,
  cx: number,
  top: number,
  h: number,
  code: number,
  night = false,
  moonPhase: MoonPhase = 'full',
  onDark = false,
): ReactNode {
  const prims = weatherGlyph(code, night, cx, top, h, moonPhase);
  const hasTransparentOutline = prims.some((prim) => 'role' in prim && prim.role?.endsWith('separator'));
  return (
    <Group key={key} layer={hasTransparentOutline ? <Paint /> : undefined}
      clip={hasTransparentOutline ? { x: cx - GLYPH_NATURAL_W / 2, y: top - 4, width: GLYPH_NATURAL_W, height: h + 8 } : undefined}>
      {prims.map((prim, i) => glyphPrimitive(`${key}-${i}`, prim, onDark))}
    </Group>
  );
}

// ── Overview strip (per-model minimap + scrubber) ────────────────────────--

type Tile = { offset: number; width: number };

// A coarse, screen-width overview whose x-axis is linear in time, so full days come out equal
// width regardless of how many periods they hold. Each day column shows its weekday and date over
// a summary weather glyph and its high, both riding a mini temperature silhouette, then a band of
// drop and flake marks stamped across the wet stretches, a Beaufort wind ribbon, and a band of one
// block per forecast period showing where the fill's resolution changes. A viewport window tracks the
// meteogram's scroll on the native driver, and touching the strip scrubs the meteogram to that
// position.
// Memoized for the same reason as CanvasTile: every prop is identity-stable while a selection
// changes, and an unchecked re-render rebuilds the strip's elements and repaints its canvas.
const OverviewStrip = memo(function OverviewStrip({ periods, dates, zoned, steps, units, now, width, viewportW, flatListRef, scrollX, fonts, paint }: {
  // `dates` are absolute instants; `zoned` is the same series on the forecast point's wall clock,
  // for the day columns and their labels.
  periods: Period[]; dates: Date[]; zoned: Date[]; steps: number[]; units: UnitPrefs; now: number;
  // Two different widths, and mixing them up puts the viewport window in the wrong place: `width`
  // is how many pixels the strip DRAWS across (it spans the screen, rail included), `viewportW` is
  // how much of the meteogram below is visible at once (the screen less the fixed rail). The
  // window's position and the scrub target are answers about the viewport; everything the strip
  // paints is in its own pixels.
  width: number; viewportW: number;
  flatListRef: RefObject<FlatList<Tile> | null>; scrollX: Animated.Value; fonts: Fonts;
  // Epoch that remounts the canvas after this tab was hidden — see Meteogram.
  paint: number;
}) {
  const n = periods.length;
  const W = width;
  const VW = viewportW;
  const dayGroups = buildDayGroups(zoned);

  // Time-linear columns: each period's width is proportional to the hours it spans. Full days come
  // out equal width whatever their resolution — a coarse far-term day is no wider than an hourly
  // near-term one — so same-resolution periods (and the viewport window over them) render the same
  // size on every day. The axis starts at the first period, not at that day's midnight, so the
  // graphs use the full width; the cost is that a forecast starting mid-day gets a short first day
  // column, narrower than the ones after it.
  const cum = new Float64Array(n + 1);
  for (let i = 0; i < n; i++) cum[i + 1] = cum[i] + steps[i];
  const pxPerHour = W / cum[n];
  const timeX = (h: number) => h * pxPerHour;
  // Hours from the first day's midnight at the forecast point to the start of the forecast. Not
  // part of the axis — only the precip grid needs it, to keep its segments on wall-clock
  // boundaries.
  const originHours = (zoned[0].getTime() - zonedMidnight(zoned[0])) / 3600000;
  const slot = (i: number) => {
    const left = timeX(cum[i]);
    const right = timeX(cum[i + 1]);
    return { left, center: (left + right) / 2, right };
  };

  const graphTop = STRIP_HEAD_H;
  const els: ReactNode[] = [];

  // Temperature silhouette. It runs the full depth of the temperature zone, under the day's summary
  // glyph and high.
  const temps: number[] = [];
  periods.forEach((p) => { if (p.temp_c != null) temps.push(p.temp_c); });
  const tMin = temps.length ? Math.min(...temps) - 1 : 0;
  const tMax = temps.length ? Math.max(...temps) + 1 : 1;
  const plottedTemps = periods.map((p) => p.temp_c);
  const silTop = graphTop + 2;
  const silBottom = graphTop + STRIP_TEMP_H;
  if (temps.length && plottedTemps.some((t) => t != null)) {
    const yOf = (t: number) => silTop + ((tMax - t) / (tMax - tMin)) * (silBottom - silTop);
    const first = plottedTemps.find((t): t is number => t != null)!;
    const last = [...plottedTemps].reverse().find((t): t is number => t != null)!;
    const points = [
      { x: timeX(0), y: yOf(first) },
      ...plottedTemps.flatMap((t, i) => t == null ? [] : [{ x: slot(i).center, y: yOf(t) }]),
      { x: W, y: yOf(last) },
    ];
    const area = Skia.Path.Make();
    smoothTo(area, points);
    area.lineTo(W, silBottom);
    area.lineTo(timeX(0), silBottom);
    area.close();
    els.push(
      <Path key="strip-temp" path={area}>
        {/* The fill also eases off toward the top of the zone, where the white glyph and high are.
            The warm end of the scale is its lightest, and at full strength white text on it fell to
            ~2.7:1 — under the fade it holds ~5:1 while the curve's own shape still reads. */}
        <LinearGradient start={vec(0, silTop)} end={vec(0, silBottom)}
          colors={[tempColor(tMax, 0.5), tempColor((tMax + tMin) / 2, 0.68), tempColor(tMin, 0.85)]}
          positions={[0, 0.5, 1]} />
      </Path>,
    );
  }

  // Precipitation marks. An area graph is illegible in a 13px band — a heavy day and a trace one
  // differ by a couple of pixels — so the band is stamped with drops and flakes instead, on a fixed
  // six-hour grid: every segment holding any precipitation gets a mark. Working in wall-clock hours
  // rather than in periods keeps the marks honest across a mixed-resolution fill, where one 12h
  // far-term period covers as much time as twelve hourly near-term ones — it draws two drops to
  // their one apiece.
  const markCy = silBottom + STRIP_PRECIP_H / 2;
  // Hours here are measured from the first day's local midnight rather than from the axis origin,
  // so segment boundaries land on 00:00 / 06:00 / 12:00 rather than on the request hour. Positions
  // convert back through timeX, which counts from the first period.
  const startHour = originHours;
  const endHour = originHours + cum[n];
  let firstInSegment = 0;
  for (let k = Math.floor(startHour / STRIP_SEGMENT_H); k * STRIP_SEGMENT_H < endHour; k++) {
    const from = Math.max(k * STRIP_SEGMENT_H, startHour);
    const to = Math.min((k + 1) * STRIP_SEGMENT_H, endHour);
    if (to <= from) continue;
    // Periods are in time order, so the scan start only ever moves forward.
    while (firstInSegment < n && originHours + cum[firstInSegment + 1] <= from) firstInSegment++;
    let rain = false;
    let snow = false;
    for (let i = firstInSegment; i < n && originHours + cum[i] < to; i++) {
      rain ||= (periods[i].rain_mm ?? 0) > 0;
      snow ||= (periods[i].snow_cm ?? 0) > 0;
    }
    if (!rain && !snow) continue;
    // A segment carrying both gets the mixed mark rather than two marks side by side, which at
    // strip scale is a few pixels of mush.
    const kind = rain && snow ? 'mix' : rain ? 'rain' : 'snow';
    const cx = timeX((from + to) / 2 - originHours);
    els.push(...precipMark(kind, cx, markCy, STRIP_MARK_H, STRIP_MARK_COLORS)
      .map((prim, pi) => glyphPrimitive(`sprecip${k}-${pi}`, prim, true)));
  }

  // Wind ribbon, on the same blended scale as the main canvas, over a white panel. Gusts rather than
  // the sustained surface wind: the strip is scanned for "which days do I care about", and the gust
  // is what decides that — a 20 mph day gusting to 45 has to look different from a steady 20. The
  // whole ribbon falls back to surface wind when the message carries no gust column at all, rather
  // than switching per period, so one band never mixes the two scales.
  const windTop = STRIP_H - STRIP_RES_H - STRIP_WIND_H;
  const hasGust = periods.some((p) => p.wind_gust_kph != null);
  const stripWind = (i: number) => hasGust ? periods[i].wind_gust_kph : periods[i].wind_sfc_kph;
  const windPanel = Skia.RRectXY(
    Skia.XYWHRect(0, windTop, W, STRIP_WIND_H), STRIP_WIND_R, STRIP_WIND_R);
  els.push(
    <RoundedRect key="swind-bg" x={0} y={windTop} width={W} height={STRIP_WIND_H}
      r={STRIP_WIND_R} color={SC.windBg} />,
  );
  // Clipped to the panel so a run reaching either end follows the eased corner instead of squaring
  // it off.
  const windEls: ReactNode[] = [];
  valueRuns(n, (i) => stripWind(i) != null).forEach((run) => {
    windEls.push(windRibbon(`swind${run[0]}`, run, slot,
      (i) => windColor(stripWind(i)!), windTop, STRIP_WIND_H));
  });
  els.push(<Group key="swind" clip={windPanel}>{windEls}</Group>);

  // Resolution band along the very bottom: one block per period. On the time-linear axis a block's
  // width *is* its span, so the fill's shape reads directly — a dense run of slivers is the hourly
  // near term, a handful of wide blocks the coarse far term, and the seams between them are where
  // the resolution steps down. One color throughout: the rung's own value is already legible from
  // the width, and tinting per resolution would compete with the graphs above.
  const resTop = STRIP_H - STRIP_RES_H;
  for (let i = 0; i < n; i++) {
    const s = slot(i);
    els.push(
      <RoundedRect key={`sres${i}`} x={s.left} y={resTop + 1}
        width={Math.max(1, s.right - s.left - STRIP_RES_GAP)} height={STRIP_RES_H - 2} r={1}
        color={SC.rung} />,
    );
  }

  // Current-time marker across the graph bands, drawn before the per-day summaries so it passes
  // behind the glyph and high rather than slicing through them.
  const cur = dates.findIndex((date, i) => now >= date.getTime() && now < date.getTime() + steps[i] * 3600000);
  if (cur >= 0) {
    const s = slot(cur);
    const frac = (now - dates[cur].getTime()) / (steps[cur] * 3600000);
    const mx = s.left + frac * (s.right - s.left);
    els.push(<Line key="strip-now" p1={vec(mx, graphTop)} p2={vec(mx, STRIP_H)} color="rgba(255,69,58,0.85)" strokeWidth={1} />);
  }

  // Per-day header: day of month in the calendar band, summary glyph and daily high
  // over the temperature silhouette. The day columns are read from the header text alone — no
  // separators, so nothing cuts across the graphs below.
  //
  // The header runs on its own axis: every day gets an equal slice of the width, whatever hours it
  // actually holds, and always draws its summary in full. On the graphs' time-linear axis a partial
  // first or last day is narrower than the rest, which is right for the data but would leave the
  // summary — a glyph and three lines of text, all of fixed size — with nowhere to go on exactly
  // the day the user is most likely to be reading. The two axes agree on the order of the days and
  // roughly on where each one sits; they do not agree edge to edge, and a partial day's header sits
  // wider than its own graph data.
  const headDayW = W / dayGroups.length;
  const glyphScale = STRIP_GLYPH_H / ROW_H.CLOUD;
  dayGroups.forEach((g, d) => {
    const cx = (d + 0.5) * headDayW;
    let code = periods[g.start].weathercode;
    let hi: number | undefined;
    for (let i = g.start; i < g.end; i++) {
      if (codeSeverity(periods[i].weathercode) > codeSeverity(code)) code = periods[i].weathercode;
      const t = periods[i].temp_c;
      if (t != null) hi = hi == null ? t : Math.max(hi, t);
    }
    // The glyph is drawn at its natural meteogram size, then scaled into the small header slot.
    els.push(
      <Group key={`gly${d}`} transform={[{ translateX: cx }, { translateY: STRIP_GLYPH_Y }, { scale: glyphScale }]}>
        {cloudGlyph(`glyi${d}`, 0, 0, ROW_H.CLOUD, code, false, 'full', true)}
      </Group>,
    );
    els.push(centerText(`sdm${d}`, String(g.date.getUTCDate()), cx, STRIP_DATE_Y + STRIP_DATE_H / 2, fonts.strip, SC.label));
    if (hi != null) {
      els.push(centerText(`shi${d}`, fmtTemp(hi, units), cx, STRIP_TVAL_Y + STRIP_TVAL_H / 2, fonts.strip, SC.label));
    }
  });

  const contentW = n * CELL_W;
  const maxOffset = Math.max(0, contentW - VW);

  // Scrub: map the touched time position back to a fractional period index, then center the
  // viewport on it.
  const scrub = (xMini: number) => {
    if (maxOffset <= 0) return;
    const clampedX = Math.max(0, Math.min(W, xMini));
    const hours = clampedX / pxPerHour;
    let i = 0;
    while (i < n - 1 && cum[i + 1] <= hours) i++;
    const t = i + (hours - cum[i]) / steps[i];
    const offset = Math.max(0, Math.min(maxOffset, t * CELL_W - VW / 2));
    flatListRef.current?.scrollToOffset({ offset, animated: false });
  };
  const pan = useMemo(() => PanResponder.create({
    onStartShouldSetPanResponder: () => true,
    onMoveShouldSetPanResponder: () => true,
    onPanResponderTerminationRequest: () => false,
    onPanResponderGrant: (e) => scrub(e.nativeEvent.locationX),
    onPanResponderMove: (e) => scrub(e.nativeEvent.locationX),
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }), [steps, maxOffset, W, VW]);

  // The main canvas scrolls by equal-width period columns while the strip is linear in time, so
  // map BOTH viewport edges through the resolution boundaries — piecewise-linear, on the native
  // driver — rather than with a single affine factor. Where the period span changes, the two edges
  // move at different rates, so the window resizes as it crosses resolution changes, not just
  // translates.
  const resBoundaries = [0];
  for (let i = 1; i < n; i++) if (steps[i] !== steps[i - 1]) resBoundaries.push(i);
  resBoundaries.push(n);
  const inputRange = resBoundaries.map((i) => i * CELL_W);
  const outputRange = resBoundaries.map((i) => timeX(cum[i]));
  const stripXOf = (contentX: number) => {
    if (contentX <= inputRange[0]) return outputRange[0];
    for (let i = 1; i < inputRange.length; i++) {
      if (contentX <= inputRange[i]) {
        const t = (contentX - inputRange[i - 1]) / (inputRange[i] - inputRange[i - 1]);
        return outputRange[i - 1] + t * (outputRange[i] - outputRange[i - 1]);
      }
    }
    return outputRange[outputRange.length - 1];
  };

  // Knots where either edge changes slope: each resolution boundary as it meets the viewport's left
  // (offset = boundary) or right (offset = boundary − W) edge. Between consecutive knots both
  // edges are linear in the scroll offset, so the window's center and width are too. Layout width
  // can't ride the native driver, so the fill is a full-width view squeezed with scaleX (about its
  // center: translate to the window center, scale to the window width) and the 1.5px side edges
  // are separate views translated independently so they stay crisp at any window size.
  const knots = new Set([0, maxOffset]);
  for (const x of inputRange) {
    if (x > 0 && x < maxOffset) knots.add(x);
    if (x - VW > 0 && x - VW < maxOffset) knots.add(x - VW);
  }
  const offsets = [...knots].sort((a, b) => a - b);
  const lefts = offsets.map((o) => stripXOf(o));
  const rights = offsets.map((o) => stripXOf(o + VW));
  const interp = (values: number[]) =>
    scrollX.interpolate({ inputRange: offsets, outputRange: values, extrapolate: 'clamp' });
  const win = maxOffset > 0
    ? {
        fillX: interp(offsets.map((_, i) => (lefts[i] + rights[i]) / 2 - W / 2)),
        fillScale: interp(offsets.map((_, i) => Math.max(rights[i] - lefts[i], 1) / W)),
        leftX: interp(lefts),
        rightX: interp(rights.map((r) => r - 1.5)),
      }
    : { fillX: 0, fillScale: 1, leftX: 0, rightX: W - 1.5 };

  return (
    <View style={styles.overviewStrip} {...pan.panHandlers}>
      <View style={{ width: W, height: STRIP_H, overflow: 'hidden' }}>
        <Canvas key={paint} style={{ width: W, height: STRIP_H }} pointerEvents="none">{els}</Canvas>
        <Animated.View pointerEvents="none"
          style={[styles.overviewWindowFill, { width: W, transform: [{ translateX: win.fillX }, { scaleX: win.fillScale }] }]} />
        <Animated.View pointerEvents="none"
          style={[styles.overviewWindowEdge, { transform: [{ translateX: win.leftX }] }]} />
        <Animated.View pointerEvents="none"
          style={[styles.overviewWindowEdge, { transform: [{ translateX: win.rightX }] }]} />
      </View>
    </View>
  );
});

// ── Meteogram canvas (one per model) ─────────────────────────────────────--

// The vertical cloud band, contoured the way Windy actually draws it: filled iso-coverage
// bands. Marching squares runs over the (periods × pressure-grid) field once per threshold,
// the per-cell segments are stitched into closed loops, and each loop is smoothed with the
// same midpoint-quad curve the freeze isotherm uses. The fills stack — a point above the k-th
// threshold is painted k times — so coverage still reads as a ramp, but with the banded,
// blobbed geometry of a real contour plot instead of a texture gradient.
const CLOUD_BAND_INK: [number, number, number] = [100, 106, 118];
// Coverage thresholds and each band's fill opacity. The wire quantizes coverage to the 3-bit
// ladder (0/14/29/43/57/71/86/100), and there is one threshold per ladder gap so the display
// distinguishes all 8 transmitted steps — fewer bands would merge values the message paid bits
// to separate. Each threshold sits mid-gap: a threshold one step off a ladder value makes
// contours cross a few percent into a cell, and those sub-cell slivers render as specks
// (half-integer endings keep them off the resampler's integer rounding too). Fills stack under
// source-over, so the alphas are solved to make the CUMULATIVE ink ramp linearly to ~0.7:
// aₖ = 0.1 / (1 − 0.1(k−1)).
const CLOUD_BAND_STEPS: [threshold: number, alpha: number][] = [
  [7.5, 0.10], [21.5, 0.11], [36.5, 0.125], [50.5, 0.14],
  [64.5, 0.17], [78.5, 0.20], [93.5, 0.25],
];

// The ground line's label: inset from the drawing's left edge, and the gap between the text box
// and the line it names.
const GROUND_LABEL_X = 4;
const GROUND_LABEL_GAP = 3;

// Coverage 0..100 at every (grid row, period): row-major, scale.gridRows × periods.length.
// The caller passes only the periods that carry a band — the wire clamps band symbols to the
// leading ≤3h periods, and a period without the field is "not forecast", which must never be
// resampled into the 0 that draws as clear sky.
function buildCloudField(periods: Period[], scale: BandScale): Uint8Array {
  const n = periods.length;
  const field = new Uint8Array(scale.gridRows * n);
  for (let i = 0; i < n; i++) scale.resampleColumn(periods[i].cloud_band, field, i, n);
  return field;
}

// Marching squares over a W×H point grid (v(i,j) is the sampled value; the caller pads the
// border with a below-every-threshold sentinel so every contour is a closed loop). Returns
// loops in fractional grid coordinates. Crossing points are keyed by the grid edge they sit
// on, so segments from neighboring cells stitch exactly — each key has degree 2 by
// construction, which is what makes the chain walk below terminate in loops.
type IsoPt = { x: number; y: number; key: string };
function isoLoops(
  v: (i: number, j: number) => number, W: number, H: number, t: number,
): { x: number; y: number }[][] {
  const segments: [IsoPt, IsoPt][] = [];
  const above = (i: number, j: number) => v(i, j) >= t;
  const hCross = (i: number, j: number): IsoPt => {
    const a = v(i, j), b = v(i + 1, j);
    return { x: i + (t - a) / (b - a), y: j, key: `h${i},${j}` };
  };
  const vCross = (i: number, j: number): IsoPt => {
    const a = v(i, j), b = v(i, j + 1);
    return { x: i, y: j + (t - a) / (b - a), key: `v${i},${j}` };
  };
  for (let j = 0; j < H - 1; j++) {
    for (let i = 0; i < W - 1; i++) {
      const c = (above(i, j) ? 1 : 0) | (above(i + 1, j) ? 2 : 0)
        | (above(i + 1, j + 1) ? 4 : 0) | (above(i, j + 1) ? 8 : 0);
      if (c === 0 || c === 15) continue;
      const T = () => hCross(i, j), B = () => hCross(i, j + 1);
      const L = () => vCross(i, j), R = () => vCross(i + 1, j);
      const add = (p: IsoPt, q: IsoPt) => segments.push([p, q]);
      switch (c) {
        case 1: case 14: add(L(), T()); break;
        case 2: case 13: add(T(), R()); break;
        case 3: case 12: add(L(), R()); break;
        case 4: case 11: add(R(), B()); break;
        case 6: case 9: add(T(), B()); break;
        case 7: case 8: add(L(), B()); break;
        // The two saddles: resolved by the cell-center average, matching the bilinear surface.
        case 5: case 10: {
          const joined = (v(i, j) + v(i + 1, j) + v(i, j + 1) + v(i + 1, j + 1)) / 4 >= t;
          if ((c === 5) === joined) { add(T(), R()); add(B(), L()); }
          else { add(L(), T()); add(R(), B()); }
          break;
        }
      }
    }
  }
  const byKey = new Map<string, number[]>();
  segments.forEach(([p, q], si) => {
    for (const k of [p.key, q.key]) {
      const list = byKey.get(k);
      if (list) list.push(si); else byKey.set(k, [si]);
    }
  });
  const used = new Array<boolean>(segments.length).fill(false);
  const loops: { x: number; y: number }[][] = [];
  for (let s = 0; s < segments.length; s++) {
    if (used[s]) continue;
    used[s] = true;
    const [p0, q0] = segments[s];
    const loop: IsoPt[] = [p0, q0];
    let curKey = q0.key;
    while (curKey !== p0.key) {
      const nextIdx = byKey.get(curKey)?.find((x) => !used[x]);
      if (nextIdx === undefined) break; // open chain — can't happen with the sentinel border
      used[nextIdx] = true;
      const [a, b] = segments[nextIdx];
      const nxt = a.key === curKey ? b : a;
      loop.push(nxt);
      curKey = nxt.key;
    }
    if (loop[loop.length - 1].key === p0.key) loop.pop(); // closing point duplicates the start
    if (loop.length >= 3) loops.push(loop);
  }
  return loops;
}

// Closed midpoint-quad smoothing — the loop analog of smoothTo: the curve starts at an edge
// midpoint, treats every vertex as a quad control point, and closes on itself. Quads stay in
// their control points' hull, so a loop hugging the band's edge never overshoots it.
function smoothClosed(path: ReturnType<typeof Skia.Path.Make>, pts: { x: number; y: number }[]) {
  const nPts = pts.length;
  if (nPts < 3) return;
  const start = { x: (pts[nPts - 1].x + pts[0].x) / 2, y: (pts[nPts - 1].y + pts[0].y) / 2 };
  path.moveTo(start.x, start.y);
  for (let i = 0; i < nPts; i++) {
    const nxt = pts[(i + 1) % nPts];
    path.quadTo(pts[i].x, pts[i].y, (pts[i].x + nxt.x) / 2, (pts[i].y + nxt.y) / 2);
  }
  path.close();
}

// The visible part of a smooth polyline, for a tile spanning [xLo, xHi]. smoothTo's curve is
// local — the segment around point k is a quad controlled by k and bounded by its midpoints with
// k−1 and k+1 — so keeping one point past the last midpoint outside the range on either side
// reproduces the full curve exactly across [xLo, xHi]; everything the trim changes (the
// degenerate first and last segments, an area's closing edge) lands outside the range, where the
// tile clips. Points must be in ascending x, which every caller's column walk already yields.
function slicePoints<T extends { x: number }>(pts: T[], xLo: number, xHi: number): T[] {
  let s = 0;
  while (s + 1 < pts.length && pts[s + 1].x <= xLo) s++;
  let e = pts.length - 1;
  while (e - 1 > 0 && pts[e - 1].x >= xHi) e--;
  return pts.slice(Math.max(0, s - 1), Math.min(pts.length, e + 2));
}

// The night shading stops at the first row that encodes its value as a fill — wind ribbons and
// cloud-cover alpha — since a tinted backdrop would make identical speeds or percentages look
// different by night than by day. Everything above reads as text or glyphs and is unharmed by
// the tint.
const TINTABLE_STOP = new Set<RowKind>([
  'wind-sfc', 'wind-gust', 'wind-dir', 'freeze', 'cloud-band', 'cloud-high', 'cloud-mid', 'cloud-low',
  ...AQ_KINDS, // air-quality cells carry their category as a fill, same as the wind ribbon
  ...AQ_DOMINANT_KINDS, // and the dominant row is painted with its headline's fill
  'wind-aloft', 'model',
]);

// The rows the current-time marker runs through: the date/time header and visual weather rows
// down to precip, excluding wind and the sections below it.
const MARKER_ROWS = new Set<RowKind>(['clouds', 'temp', 'precip-chance', 'snow', 'rain']);

// Scene quantities computed over the WHOLE forecast, whatever slice of it a tile draws: the
// domains and scales that keep columns comparable across the window — a tile that fit its own
// temperature range would disagree with its neighbor at the seam — plus the one piece of
// geometry that is genuinely global, the cloud-band contours, a handful of path elements every
// tile shares as-is (each tile's canvas clips them to its own bounds).
interface SceneStatics {
  tMin: number; tMax: number; tempRowBottom: number;
  maxSnow: number; maxRain: number;
  snowNorm: number[]; rainNorm: number[]; precipScale: number;
  freezeValues: (number | undefined)[]; freezeBase: number; freezeSpan: number;
  // The current-time marker's row span. The marker itself is in no slice — it moves with the
  // clock, so ModelCanvas splices it into the one tile it crosses (see markerIndex), and the
  // minute tick re-renders that tile alone.
  markerTop: number | undefined; markerBottom: number | undefined;
  cloudBandEls: ReactNode[];
  dominantSegs: Partial<Record<AqDominantKind, DominantSegment[]>>;
}

function buildSceneStatics({ periods, rows, steps, elevation, units, fonts }: {
  // `elevation` is the forecast point's height in meters, off the message header — the cloud band
  // draws it as its ground line, and `units`/`fonts` are what that line's label is written with.
  periods: Period[]; rows: Row[]; steps: number[]; elevation: number; units: UnitPrefs; fonts: Fonts;
}): SceneStatics {
  const n = periods.length;
  const width = n * CELL_W;
  const colLeft = (i: number) => i * CELL_W;
  const colCenter = (i: number) => i * CELL_W + CELL_W / 2;

  // Temperature domain across all periods.
  const temps: number[] = [];
  periods.forEach((p) => { if (p.temp_c != null) temps.push(p.temp_c); });
  const tMin = temps.length ? Math.min(...temps) - 1 : 0;
  const tMax = temps.length ? Math.max(...temps) + 1 : 1;
  let tempRowBottom = ROW_H.DATE;
  for (const row of rows) {
    tempRowBottom += row.height;
    if (row.kind === 'temp') break;
  }

  // The shared precip scale — see the area builder in buildScene for why it is ONE scale over
  // both rows. Each period is normalized by its OWN step first (precipNorm), so a window that
  // drops from 6h to 12h partway through doesn't step up an area that is only carrying twice as
  // many hours of the same weather.
  const maxSnow = Math.max(0, ...periods.map((p) => p.snow_cm ?? 0));
  const maxRain = Math.max(0, ...periods.map((p) => p.rain_mm ?? 0));
  const snowNorm = periods.map((period, i) => precipNorm(period.snow_cm ?? 0, steps[i]));
  const rainNorm = periods.map((period, i) => precipNorm(period.rain_mm ?? 0, steps[i]));
  const precipScale = precipScaleOf(Math.max(0, ...snowNorm, ...rainNorm));

  // Freezing-level domain, shared by the isotherm curve and the two washes either side of it.
  // The bottom is pinned to ground level once the level comes near it, so a freezing level at
  // the surface reads as one with no above-freezing air under it rather than as one floating a
  // row's worth of red above the ground.
  const freezeValues = periods.map((p) => p.freeze_m);
  const freezePresent = freezeValues.filter((m): m is number => m != null);
  let freezeBase = 0;
  let freezeSpan = FREEZE_MIN_SPAN_M;
  if (freezePresent.length) {
    const lo = Math.min(...freezePresent);
    const hi = Math.max(...freezePresent);
    freezeSpan = Math.max((hi - lo) * FREEZE_HEADROOM, FREEZE_MIN_SPAN_M);
    freezeBase = Math.max(0, (lo + hi) / 2 - freezeSpan / 2);
  }

  let markerTop: number | undefined;
  let markerBottom: number | undefined;
  let markerY = ROW_H.DATE;
  rows.forEach((row) => {
    if (MARKER_ROWS.has(row.kind)) {
      markerTop ??= markerY;
      markerBottom = markerY + row.height;
    }
    markerY += row.height;
  });

  // Runs of one dominant pollutant, shared by every tile's bracket pass and computed once —
  // the runs are a property of the whole window, not of a slice of it.
  const dominantSegs: Partial<Record<AqDominantKind, DominantSegment[]>> = {};
  for (const row of rows) {
    if (row.kind === 'aqi-dominant' || row.kind === 'aqi-eu-dominant')
      dominantSegs[row.kind] = dominantSegments(periods, row.kind);
  }

  // The vertical cloud band: Windy-style cloud cross-section from the message's cloud_band
  // stacks, as real filled contours (see isoLoops above). The y axis runs 300 hPa (top) to the
  // message's own floor (bottom) on an even ladder — one equal slice per wire level, see
  // bandScale — so every level shows a deck at the same size. Grid points sit at column
  // centers; a sentinel ring pads the field so every contour closes, with the ring's
  // coordinates clamped onto the band's edges so loops hug them.
  //
  // The wire clamps band symbols to the leading ≤3h periods, so the drawing spans only the
  // columns that carry data and stops at their boundary — the rest of the row stays empty,
  // which is "not forecast" exactly the way an empty air-quality cell is. The level count is
  // read off the decoded array (the wire truncates the stack at one level below the forecast
  // point), and the row's height in buildRows follows the same count.
  //
  // Marching squares runs over the whole field, and its loops cross tiles freely — so the band
  // is built HERE, once, into elements every tile includes and clips for itself.
  const cloudBandEls: ReactNode[] = [];
  let bandY = ROW_H.DATE;
  rows.forEach((row, ri) => {
    const top = bandY;
    bandY += row.height;
    if (row.kind !== 'cloud-band') return;
    let nCb = 0;
    while (nCb < n && periods[nCb].cloud_band) nCb++;
    if (nCb === 0) return; // the row only exists when some period carries a band
    const scale = bandScale(periods[0].cloud_band!.length);
    const bandRight = colLeft(0) + nCb * CELL_W;
    const yOfHpa = (hpa: number) => top + scale.hpaToFrac(hpa) * row.height;
    const field = buildCloudField(periods.slice(0, nCb), scale);
    const W = nCb + 2, H = scale.gridRows + 2;
    const val = (i: number, j: number) =>
      i === 0 || j === 0 || i === W - 1 || j === H - 1 ? -1 : field[(j - 1) * nCb + (i - 1)];
    const xs = [colLeft(0), ...periods.slice(0, nCb).map((_, i) => colCenter(i)), bandRight];
    // The field's rows are uniform in pressure; the axis is not (hpaToFrac), so each row is
    // placed by its own pressure. The contour walk works in grid coordinates and reads its
    // pixels back through these tables, so the ladder bends the loops with it. Both sentinel
    // rows sit ON the outermost data rows: cloud meets the ground squarely at the bottom, and
    // stops dead at 300 hPa on top. A ring standing off either edge would have every contour
    // interpolate into the gap, painting cloud past the levels the message carries.
    const gridYs = Array.from({ length: scale.gridRows }, (_, j) =>
      top + scale.hpaToFrac(BAND_TOP_HPA + j * GRID_STEP_HPA) * row.height);
    const ys = [gridYs[0], ...gridYs, gridYs[scale.gridRows - 1]];
    const px = (g: number) => {
      const f = Math.floor(g);
      return lerp(xs[f], xs[Math.min(f + 1, xs.length - 1)], g - f);
    };
    const py = (g: number) => {
      const f = Math.floor(g);
      return lerp(ys[f], ys[Math.min(f + 1, ys.length - 1)], g - f);
    };
    // Loops smaller than half a grid cell are quantization noise, not weather — a lone
    // point one ladder step over a threshold, or the resampler's integer rounding — and a
    // filled contour would render them as crisp specks. Shoelace area, in pixels. Measured
    // against the SHORTEST row gap the ladder produces (its slices hold 3 to 6 grid rows
    // apiece), so the threshold stays under half a cell everywhere rather than eating real
    // one-cell blobs wherever the rows run closest together.
    let minRowGap = Infinity;
    for (let j = 1; j < scale.gridRows; j++) minRowGap = Math.min(minRowGap, ys[j + 1] - ys[j]);
    const minLoopArea = 0.5 * CELL_W * minRowGap;
    const loopArea = (pts: { x: number; y: number }[]) => {
      let a = 0;
      for (let i = 0; i < pts.length; i++) {
        const q = pts[(i + 1) % pts.length];
        a += pts[i].x * q.y - q.x * pts[i].y;
      }
      return Math.abs(a) / 2;
    };
    for (const [threshold, alpha] of CLOUD_BAND_STEPS) {
      const loops = isoLoops(val, W, H, threshold);
      if (!loops.length) continue;
      const path = Skia.Path.Make();
      path.setFillType(FillType.EvenOdd); // an inner loop is a hole in its surrounding band
      for (const loop of loops) {
        const mapped = loop.map((p) => ({ x: px(p.x), y: py(p.y) }));
        if (loopArea(mapped) < minLoopArea) continue;
        smoothClosed(path, mapped);
      }
      cloudBandEls.push(<Path key={`cb${ri}-${threshold}`} path={path}
        color={rgb(CLOUD_BAND_INK, alpha)} />);
    }

    // Where the band stops short of the window (coarser periods follow), the rest of the row is
    // filled in the day divider's grey: left white, those columns would read as a
    // clear sky — the same white a 0% contour field paints — when the message simply carries no
    // band for them. The divider grey is already the drawing's "not content" tone, a step darker
    // than the grid, so it reads as blank rather than as a pale cloud. On the data side of the
    // seam the contours dissolve to white over the last half column instead of hitting the grey
    // as a sheer face — the sentinel column already tapers them, and this wash softens what
    // remains. Over the contours only: the gridlines and ground line draw after it, ending
    // crisply at the boundary, so the SCALE reads as ending while the CLOUD reads as passing out
    // of view.
    if (nCb < n) {
      cloudBandEls.push(
        <Rect key={`cbnone${ri}`} x={bandRight} y={top} width={width - bandRight}
          height={row.height} color={C.divider} />,
      );
      cloudBandEls.push(
        <Rect key={`cbfade${ri}`} x={bandRight - CELL_W / 2} y={top}
          width={CELL_W / 2} height={row.height}>
          <LinearGradient start={vec(bandRight - CELL_W / 2, 0)} end={vec(bandRight, 0)}
            colors={['rgba(255,255,255,0)', '#ffffff']} />
        </Rect>,
      );
    }

    // One gridline per wire level — the axis lists exactly what the message carries, and runs
    // exactly as far as the message carries it (bandRight). The altitudes those lines stand
    // for are written in the fixed rail (see RowLegend), not here: they are the scale of a
    // 220px plot, and drawn into the scene they scrolled off with the first day.
    for (const hpa of scale.levels) {
      // Both end levels sit on the row's own edges, where a line would only redraw a boundary
      // the section header above and the row below already draw — 300 hPa against the header's
      // ground, the floor level against the row under it. The edges ARE those two rungs; the
      // rail's labels land on them, and the rungs between them are what needs a line of its own.
      if (hpa === BAND_TOP_HPA || hpa === scale.bottomHpa) continue;
      cloudBandEls.push(
        <Line key={`cbg${ri}-${hpa}`} p1={vec(0, yOfHpa(hpa))} p2={vec(bandRight, yOfHpa(hpa))}
          color={C.grid} strokeWidth={1}>
          <DashPathEffect intervals={[3, 4]} />
        </Line>,
      );
    }

    // The ground: the forecast point's elevation, placed on the same pressure ladder as the cloud
    // (standard atmosphere — the band is a scale, not a sounding). With the wire truncating the
    // stack at one level below the forecast point, the line sits inside the bottom slice — the
    // slice that exists precisely so an undercast below the point has somewhere to show. Drawn
    // last, so it lies over both the contours and the gridlines.
    //
    // Skipped at and below the band's floor: from low country the floor is 1000 hPa and an
    // elevation under ~110 m clamps onto the row's bottom edge, where the line would only redraw
    // the boundary the row below already draws — and 0 is also what the wire reports when it has
    // no elevation to carry, so there would be nothing to stand for. The same reasoning skips the
    // two end gridlines above.
    const groundHpa = metersToPressure(elevation);
    if (elevation > 0 && groundHpa < scale.bottomHpa) {
      const groundY = yOfHpa(groundHpa);
      cloudBandEls.push(
        <Line key={`cbgnd${ri}`} p1={vec(0, groundY)} p2={vec(bandRight, groundY)}
          color={C.groundLine} strokeWidth={1.25}>
          <DashPathEffect intervals={[5, 4]} />
        </Line>,
      );
      // The altitude the line stands for, at its left end. The rail beside the canvas labels the
      // wire's levels and nothing else, so this reading has to travel with the line — which means
      // it scrolls away with the first day, like every other label drawn into the scene. That is
      // the right trade here: the ground is a fixed altitude, read once, and a value repeated down
      // the forecast would sit on cloud in every column instead of just the first.
      //
      // Above the line by preference, so the dashes underline it; below when the line runs too
      // near the top of the band for the text to fit over it (an elevation up near 300 hPa).
      const size = fonts.small.getSize();
      const cy = groundY - size - GROUND_LABEL_GAP >= top
        ? groundY - size / 2 - GROUND_LABEL_GAP
        : groundY + size / 2 + GROUND_LABEL_GAP;
      cloudBandEls.push(
        <Text key={`cbgndl${ri}`} x={GROUND_LABEL_X} y={baseline(cy, size)}
          text={fmtElevation(elevation, units)} font={fonts.small} color={C.groundText} />,
      );
    }
  });

  return {
    tMin, tMax, tempRowBottom, maxSnow, maxRain, snowNorm, rainNorm, precipScale,
    freezeValues, freezeBase, freezeSpan, markerTop, markerBottom, cloudBandEls, dominantSegs,
  };
}

// Skia scene for one TILE of a model's drawing: columns [from, to), in the drawing's own
// absolute coordinates — the tile translates, it doesn't re-project. Building per tile is what
// keeps a tile mount affordable: the full scene at maximum fill is tens of thousands of
// elements, and a tile that mounts all of them to show its own sixteen columns pays for the
// whole forecast on every mount — which is what made the first paint slow and left blank tiles
// trailing a fast scroll.
//
// A slice carries its columns plus a margin: one column of per-column elements either side
// (nothing a column draws reaches past its neighbor), one further POINT on every smooth curve
// (slicePoints), and one gradient stop past each ribbon edge — each exactly what pins the
// visible pixels to what the full-scene build drew there. Range geometry that is cheap and
// awkward to split — full-width rules, section grounds, the shared cloud-band contours — is
// included whole and clipped by the canvas.
//
// Pure, and called through useMemo: overlay-only state like the selected column must not
// rebuild the elements, since any rebuild repaints every mounted tile.
function buildScene({ periods, rows, dates, zoned, steps, units, timeFormat, lat, lon, fonts, dayGroups, modelBands, statics, from, to }: {
  // `dates` are absolute instants — what the sun answers to. `zoned` is the same series on the
  // forecast point's wall clock, which is what the hour and day labels read.
  periods: Period[]; rows: Row[]; dates: Date[]; zoned: Date[]; steps: number[]; units: UnitPrefs; timeFormat: TimeFormat;
  lat: number; lon: number; fonts: Fonts; dayGroups: DayGroup[];
  // The model row's bands. Their labels are not drawn here — they stick to the viewport's left
  // edge, like the day labels, so they live in the overlay above the canvas.
  modelBands: ModelSegment[];
  statics: SceneStatics;
  from: number; to: number;
}): { els: ReactNode[]; markerIndex: number } {
  const n = periods.length;
  const width = n * CELL_W;
  const colLeft = (i: number) => i * CELL_W;
  const colCenter = (i: number) => i * CELL_W + CELL_W / 2;
  const els: ReactNode[] = [];
  // The slice's column range with its one-column margin, and the x-range strokes are kept for —
  // a hairline on the tile's very edge bleeds half a pixel in from the neighboring column.
  const c0 = Math.max(0, from - 1);
  const c1 = Math.min(n, to + 1);
  const xLo = from * CELL_W - 1;
  const xHi = to * CELL_W + 1;

  // 1. Location-aware astronomical night shading. Partial rectangles place sunrise and sunset
  // within a column rather than rounding them to the forecast period boundary (the stop row is
  // TINTABLE_STOP's business).
  const nightBottom = (() => {
    let y = ROW_H.DATE;
    let headerTop: number | undefined; // top of the section label immediately above this row
    for (const row of rows) {
      if (TINTABLE_STOP.has(row.kind)) return headerTop ?? y;
      headerTop = row.kind === 'section' ? y : undefined;
      y += row.height;
    }
    return ROW_H.DATE + rows.reduce((s, r) => s + r.height, 0);
  })();
  for (let i = c0; i < c1; i++) {
    const start = dates[i].getTime();
    const end = start + steps[i] * 3600000;
    nightSegments(start, end, lat, lon).forEach(([fromFrac, toFrac], segment) => {
      els.push(<Rect key={`night${i}-${segment}`} x={colLeft(i) + fromFrac * CELL_W} y={31} width={(toFrac - fromFrac) * CELL_W} height={nightBottom - 31} color={C.night} />);
    });
  }

  // 2. The fills that lie under the header text and the row content, in the stacking order the
  // full scene always painted them: rain, then snow, then the temperature area.
  //
  // One smooth area per precip row, each rising from its own row's baseline. Snow is plotted at
  // liquid equivalent (1 cm ≈ 1 mm of water, so the cm number is already the mm-equivalent one),
  // which is what lets the two rows be read against each other: at equal duration, equal heights
  // are equal water, whatever the numbers printed on them say. That is also why ONE scale is taken
  // over both rows rather than each row fitting its own peak (statics.precipScale) — a row scaled
  // to itself would draw a dusting of snow as tall as the storm of rain beside it.
  const precipSpans = new Map<RowKind, { top: number; bottom: number }>();
  let precipRowY = ROW_H.DATE;
  rows.forEach((row) => {
    if (row.kind === 'snow' || row.kind === 'rain')
      precipSpans.set(row.kind, { top: precipRowY, bottom: precipRowY + row.height });
    precipRowY += row.height;
  });
  ([
    ['rain', statics.rainNorm, statics.maxRain, C.rainArea, C.rainEdge],
    ['snow', statics.snowNorm, statics.maxSnow, C.snowArea, C.snowEdge],
  ] as const).forEach(([kind, values, max, color, edgeColor]) => {
    const span = precipSpans.get(kind);
    if (!span || max <= 0) return;
    const plotTop = span.top + PRECIP_PLOT_PAD;
    const valueY = (norm: number) =>
      span.bottom - accumFrac(norm, statics.precipScale) * (span.bottom - plotTop);
    const points = slicePoints([
      { x: colLeft(0), y: valueY(values[0]) },
      ...values.map((value, i) => ({ x: colCenter(i), y: valueY(value) })),
      { x: colLeft(n), y: valueY(values[values.length - 1]) },
    ], xLo, xHi);
    const area = Skia.Path.Make();
    smoothTo(area, points);
    area.lineTo(points[points.length - 1].x, span.bottom);
    area.lineTo(points[0].x, span.bottom);
    area.close();
    // The top boundary again as its own open path, so only the curve is stroked: stroking the
    // closed area would draw the outline along the row's bottom edge too, a second rule beside
    // the seam. The edge is what carries the shape once the ground under it moves — snow's wash
    // against the night tint is a 1.01:1 difference, which is to say none at all.
    const edge = Skia.Path.Make();
    smoothTo(edge, points);
    els.push(
      <Group key={`${kind}-area`}>
        <Path path={area} color={color} />
        <Path path={edge} style="stroke" strokeWidth={PRECIP_EDGE_W} color={edgeColor} />
      </Group>,
    );
  });

  // Temperature is a background area behind the time, weather-code, and temperature rows. Its
  // vertical shape is normalized to this forecast's range, while the gradient colors are chosen
  // from absolute temperatures and fade to white beneath the plotted range.
  const plottedTemps = periods.map((p) => p.temp_c);
  if (plottedTemps.some((temperature) => temperature != null)) {
    const { tMin, tMax, tempRowBottom } = statics;
    const plotTop = 39;
    const plotBottom = tempRowBottom - 18;
    const scaleTempY = (temperature: number) =>
      plotTop + ((tMax - temperature) / (tMax - tMin)) * (plotBottom - plotTop);
    const first = plottedTemps.find((temperature): temperature is number => temperature != null)!;
    const last = [...plottedTemps].reverse().find((temperature): temperature is number => temperature != null)!;
    const points = slicePoints([
      { x: colLeft(0), y: scaleTempY(first) },
      ...plottedTemps.flatMap((temperature, i) => temperature == null ? [] : [{ x: colCenter(i), y: scaleTempY(temperature) }]),
      { x: colLeft(n), y: scaleTempY(last) },
    ], xLo, xHi);
    const area = Skia.Path.Make();
    smoothTo(area, points);
    area.lineTo(points[points.length - 1].x, tempRowBottom);
    area.lineTo(points[0].x, tempRowBottom);
    area.close();
    const rangeEnd = Math.max(0, Math.min(1, (plotBottom - plotTop) / (tempRowBottom - plotTop)));
    els.push(
      <Path key="temperature-area" path={area}>
        <LinearGradient
          start={vec(0, plotTop)}
          end={vec(0, tempRowBottom)}
          colors={[tempColor(tMax, 0.55), tempColor((tMax + tMin) / 2, 0.55), tempColor(tMin, 0.55), 'rgba(255,255,255,0)']}
          positions={[0, rangeEnd / 2, rangeEnd, 1]}
        />
      </Path>,
    );
  }

  // 3. Date header. Hours occupy their own row. Each day label sticks to the visible left
  // edge while its columns are being scrolled, then yields to the following day.
  for (let i = c0; i < c1; i++) {
    els.push(centerHour(`hour${i}`, hourParts(zoned[i], steps[i], timeFormat), colCenter(i), HOUR_LABEL_Y, fonts.hour, fonts.hourSuffix, C.hour));
  }
  els.push(<Line key="date-row-rule" p1={vec(0, 31)} p2={vec(width, 31)} color={C.grid} strokeWidth={1} />);

  // Where ModelCanvas splices the current-time marker into the one tile it crosses: over the
  // areas and header, under the row content — the digits read over the line, as they always
  // have. The marker is kept out of the slice so the minute tick re-renders one tile, not every
  // mounted one.
  const markerIndex = els.length;

  const { freezeValues, freezeBase, freezeSpan } = statics;

  // 4. Rows.
  let y = ROW_H.DATE;
  rows.forEach((row, ri) => {
    const top = y;
    const mid = top + row.height / 2;
    y += row.height;

    // Section bands paint their ground here and are LABELLED outside the scene: the header names
    // the block every row under it belongs to, and a band that scrolled its own name away would
    // leave a bare gray stripe exactly when the reader most needs to know what they are looking
    // at. See SectionLabels.
    if (row.kind === 'section') {
      els.push(<Rect key={`sec-bg${ri}`} x={0} y={top} width={width} height={row.height} color={C.section} />);
      return;
    }

    switch (row.kind) {
      case 'clouds':
        for (let i = c0; i < c1; i++) {
          const midpoint = dates[i].getTime() + steps[i] * 1800000;
          const night = isNight(midpoint, lat, lon);
          els.push(
            <Group key={`clg${i}`} transform={[{ scale: GLYPH_SCALE }]} origin={vec(colCenter(i), mid)}>
              {cloudGlyph(
                `cl${i}`,
                colCenter(i),
                top,
                row.height,
                periods[i].weathercode,
                night,
                moonPhaseAt(midpoint),
              )}
            </Group>,
          );
        }
        break;

      case 'temp': {
        for (let i = c0; i < c1; i++) {
          if (periods[i].temp_c != null) {
            els.push(centerText(`th${i}`, fmtTemp(periods[i].temp_c, units), colCenter(i), top + TEMP_VALUE_Y, fonts.data, '#1c1c1e'));
          }
        }
        break;
      }

      case 'precip-chance': {
        // A dashed curve on a fixed 0–100% scale — fixed because a probability's full scale is the
        // whole of it, and a 30% chance that filled the row because nothing beat it would be a lie
        // the amounts above can afford (they are quantities) and this row cannot. No numbers and
        // no fill: the shape is the reading, and the exact percentage is one tap away. The dashes
        // are what keep a row of pure line from reading as a border under the rain area.
        const bottom = top + row.height;
        const plotTop = top + PRECIP_PLOT_PAD;
        const chanceY = (v: number) =>
          bottom - (Math.min(100, Math.max(0, v)) / 100) * (bottom - plotTop);
        valueRuns(n, (i) => periods[i].precip != null).forEach((run) => {
          const x0 = colLeft(run[0]);
          const x1 = colLeft(run[run.length - 1]) + CELL_W;
          if (x1 < xLo || x0 > xHi) return;
          // The whole run, not a slice of it: the dashes' phase runs from the path's start, so a
          // trimmed curve would break pattern at every tile seam. One stroked path per run is
          // cheap; it is the per-column element walls this builder exists to avoid.
          const points = [
            { x: x0, y: chanceY(periods[run[0]].precip!) },
            ...run.map((i) => ({ x: colCenter(i), y: chanceY(periods[i].precip!) })),
            { x: x1, y: chanceY(periods[run[run.length - 1]].precip!) },
          ];
          const curve = Skia.Path.Make();
          smoothTo(curve, points);
          els.push(
            <Path key={`pc${ri}-${run[0]}`} path={curve}
              style="stroke" strokeWidth={1.25} color={C.chanceLine}>
              <DashPathEffect intervals={[4, 3]} />
            </Path>,
          );
        });
        break;
      }

      // One amount per row, on the row's own baseline. The max gate is what it always was: a
      // column prints a number only where the window has an area to print it against, so a
      // forecast whose every period rounds to nothing draws neither.
      case 'snow':
      case 'rain':
        for (let i = c0; i < c1; i++) {
          const snow = row.kind === 'snow';
          const value = (snow ? periods[i].snow_cm : periods[i].rain_mm) ?? 0;
          const max = snow ? statics.maxSnow : statics.maxRain;
          if (!(value > 0 && max > 0)) continue;
          const text = snow ? fmtSnow(value, units) : fmtRain(value, units);
          if (!text) continue;
          els.push(centerText(
            `${snow ? 'sv' : 'rv'}${i}`, text, colCenter(i), top + PRECIP_VALUE_Y,
            fonts.small, snow ? C.snowInk : C.rainInk,
          ));
        }
        break;

      case 'freeze': {
        // The 0°C isotherm as a curve with the sky either side of it washed in: cold above the
        // level, warm below. The washes run to the row's own edges rather than to the padded plot
        // band — the padding only keeps the curve off the edges, and filling only as far as it
        // would draw a white stripe along the top and bottom of the row.
        const bottom = top + row.height;
        const plotTop = top + FREEZE_PAD;
        // Where the domain is pinned to ground, the row's bottom edge *is* the ground, so the pad
        // comes off: a freezing level at the surface should leave no warm air under it at all.
        const plotBottom = bottom - (freezeBase > 0 ? FREEZE_PAD : 0);
        const freezeY = (m: number) =>
          plotBottom - ((m - freezeBase) / freezeSpan) * (plotBottom - plotTop);
        valueRuns(n, (i) => freezeValues[i] != null).forEach((run) => {
          const x0 = colLeft(run[0]);
          const x1 = colLeft(run[run.length - 1]) + CELL_W;
          if (x1 < xLo || x0 > xHi) return;
          // The curve holds flat out to the run's outer edges, so a run reads as covering its
          // columns edge to edge rather than tapering in from their centers.
          const points = slicePoints([
            { x: x0, y: freezeY(freezeValues[run[0]]!) },
            ...run.map((i) => ({ x: colCenter(i), y: freezeY(freezeValues[i]!) })),
            { x: x1, y: freezeY(freezeValues[run[run.length - 1]]!) },
          ], xLo, xHi);
          const xFirst = points[0].x;
          const xLast = points[points.length - 1].x;
          const cold = Skia.Path.Make();
          smoothTo(cold, points);
          cold.lineTo(xLast, top);
          cold.lineTo(xFirst, top);
          cold.close();
          const warm = Skia.Path.Make();
          smoothTo(warm, points);
          warm.lineTo(xLast, bottom);
          warm.lineTo(xFirst, bottom);
          warm.close();
          const isotherm = Skia.Path.Make();
          smoothTo(isotherm, points);
          els.push(
            <Group key={`fzg${ri}-${run[0]}`}>
              <Path path={cold} color={C.freezeCold} />
              <Path path={warm} color={C.freezeWarm} />
              <Path path={isotherm} style="stroke" strokeWidth={1.25} color={C.freezeLine} />
            </Group>,
          );
        });
        for (let i = c0; i < c1; i++) {
          const txt = fmtFreeze(periods[i].freeze_m, units);
          els.push(centerText(`fz${i}`, txt || '—', colCenter(i), mid, fonts.data,
            txt ? '#1c1c1e' : C.nil));
        }
        break;
      }

      case 'cloud-band':
        // Contours, gridlines and the ground line are global geometry, built once in
        // buildSceneStatics and shared by every tile — each canvas clips them to its own bounds.
        els.push(...statics.cloudBandEls);
        break;

      case 'wind-sfc': case 'wind-gust': case 'wind-aloft': {
        // Surface direction lives in its own arrow row below the gust row; gusts have none.
        const inlineArrow = row.kind === 'wind-aloft';
        const li = row.level ?? 0;
        const speedAt = (i: number): number | undefined => row.kind === 'wind-sfc' ? periods[i].wind_sfc_kph
          : row.kind === 'wind-gust' ? periods[i].wind_gust_kph
          : periods[i].wind_aloft?.[li]?.kph;
        const dirAt = (i: number): number | undefined => periods[i].wind_aloft?.[li]?.dir;
        // A run trimmed to the slice, not the whole run: the ribbon blends linearly between
        // column centers, so a sub-run holding every center adjacent to the tile paints the
        // tile's pixels exactly — the flat hold it gains at its cut ends lies in the margin,
        // where the canvas clips.
        valueRuns(n, (i) => speedAt(i) != null).forEach((run) => {
          const sub = run.filter((i) => i >= c0 && i < c1);
          if (!sub.length) return;
          els.push(windRibbon(
            `wbg${ri}-${sub[0]}`, sub,
            (i) => ({ left: colLeft(i), center: colCenter(i), right: colLeft(i) + CELL_W }),
            (i) => windColor(speedAt(i)!), top, row.height,
          ));
        });
        for (let i = c0; i < c1; i++) {
          const kph = speedAt(i);
          const cx = colCenter(i);
          if (kph == null) { els.push(centerText(`w${ri}-${i}`, '—', cx, mid, fonts.wind, C.nil)); continue; }
          const di = inlineArrow ? dirAt(i) : undefined;
          const arrow = di != null ? ARROWS[CARDINALS[di] ?? 'N'] ?? '' : '';
          // Rows carrying an inline arrow split the (now shorter) row evenly above and below center.
          els.push(centerText(`ws${ri}-${i}`, fmtWind(kph, units), cx, arrow ? mid - 6 : mid, fonts.wind, WIND_INK));
          els.push(centerText(`wa${ri}-${i}`, arrow, cx, mid + 6, fonts.data, WIND_INK));
        }
        break;
      }

      case 'aqi': case 'aqi-pm25': case 'aqi-o3': case 'aqi-pm10':
      case 'aqi-no2': case 'aqi-so2':
      case 'aqi-eu': case 'aqi-eu-pm25': case 'aqi-eu-o3': case 'aqi-eu-pm10':
      case 'aqi-eu-no2': case 'aqi-eu-so2': {
        const { field, scale } = AQ_KEYS[row.kind];
        const valueAt = (i: number) => periods[i][field] as number | undefined;
        // Painted as the wind ribbon is: one gradient per run of columns that have a value, exact
        // at each column's center and blended between them. The category edges become gradients
        // rather than steps, which is the trade — but the number is printed in every cell, so the
        // reader gets the precise value from the digits and the shape of an episode from the
        // color. A hard step per column made a smoke plume read as a bar chart of six categories
        // instead of as something arriving.
        valueRuns(n, (i) => valueAt(i) != null).forEach((run) => {
          // Trimmed to the slice like the wind ribbon above, and exact for the same reason.
          const sub = run.filter((i) => i >= c0 && i < c1);
          if (!sub.length) return;
          els.push(windRibbon(
            `aqbg${ri}-${sub[0]}`, sub,
            (i) => ({ left: colLeft(i), center: colCenter(i), right: colLeft(i) + CELL_W }),
            (i) => aqBand(valueAt(i)!, scale).color, top, row.height,
          ));
        });
        for (let i = c0; i < c1; i++) {
          const v = valueAt(i);
          const cx = colCenter(i);
          // Past the CAMS horizon there is no forecast at all, which is a different thing from
          // clean air — so those columns are filled in the day divider's grey, the drawing's
          // "not content" tone, as the cloud band's tail is, rather than left white beside the
          // category colors, where they would read as the cleanest category of all.
          if (v == null) {
            els.push(<Rect key={`aq${ri}-${i}`} x={colLeft(i)} y={top} width={CELL_W}
              height={row.height} color={C.divider} />);
            continue;
          }
          // The gradient is exact at the column's center, which is where the digits sit, so the
          // ink is measured against this cell's own band rather than the blend either side. One
          // white for the whole row was tried and doesn't survive the light fills — on EPA's
          // yellow it is 1.07:1, and on the orange and the EU cyan barely better.
          const band = aqBand(v, scale);
          els.push(centerText(`aq${ri}-${i}`, String(Math.round(v)), cx, mid, fonts.wind,
            band.ink ?? bandInk(hexRgb(band.color))));
        }
        break;
      }

      case 'aqi-dominant': case 'aqi-eu-dominant': {
        // Painted exactly like the headline row above it, from the HEADLINE's value — same
        // Left white on purpose. The row carries no measurement of its own — the AQI band above
        // it already says how bad the air is — so shading it in those same colours would read as
        // a second reading rather than as a caption on the first.
        //
        // The name itself is NOT drawn here: it is RN text in a sticky overlay, so a run wider
        // than the screen keeps its label in frame the way the model bands and day headers do.
        // What the canvas draws is the bracket the label sits in.
        const segs = statics.dominantSegs[row.kind] ?? [];
        const named = new Set<number>();
        segs.forEach((sg) => { for (let i = sg.start; i < sg.end; i++) named.add(i); });
        // Columns with no headline to caption — past the CAMS horizon — take the same grey as the
        // row above them, so the blank runs to the bottom of the block as one shape.
        for (let i = c0; i < c1; i++) {
          if (named.has(i)) continue;
          els.push(<Rect key={`dm${ri}-${i}`} x={colLeft(i)} y={top} width={CELL_W}
            height={row.height} color={C.divider} />);
        }
        segs.forEach((sg, si) => {
          if (colLeft(sg.end) < xLo || colLeft(sg.start) > xHi) return;
          const x0 = colLeft(sg.start), x1 = colLeft(sg.end);
          // |____| : a dotted rule on the text's own centre line, closed by a cap at each end of
          // the run. The caps rise from the rule toward the AQI row above, so the bracket points
          // at the numbers it is qualifying. They are also what marks a handover — two of them
          // land back to back where runs touch — so the full-height white tick that used to do
          // that job is gone; two rules saying the same thing in a 26px row was one too many.
          // The label rides over the rule on a white plate, which is what keeps the dashes from
          // striking through it: the label moves with the scroll and the canvas can't follow it,
          // so the gap has to travel with the text rather than be cut into the line.
          const y = mid;
          els.push(
            <Line key={`dmrule${ri}-${si}`} p1={vec(x0 + 1, y)} p2={vec(x1 - 1, y)}
              color={C.date} strokeWidth={1} opacity={0.45}>
              <DashPathEffect intervals={[1.5, 2.5]} />
            </Line>,
          );
          for (const [xi, x] of [[0, x0 + 1], [1, x1 - 1]] as const)
            els.push(<Line key={`dmcap${ri}-${si}-${xi}`}
              p1={vec(x, y - 6)} p2={vec(x, y)} color={C.date} strokeWidth={1} opacity={0.45} />);
        });
        break;
      }

      case 'wind-dir': {
        // Chunky solid arrow (shaft + triangular head), rotated per direction. Text glyphs are
        // too thin at this size. Drawn pointing east and rotated to where the wind blows toward:
        // dir index 0 (N wind) points south = +90° in screen coords.
        const L = 14, SHAFT = 4.5, HEAD_L = 6.5, HEAD_W = 10.5;
        const h = L / 2, s = SHAFT / 2, w = HEAD_W / 2;
        for (let i = c0; i < c1; i++) {
          const di = periods[i].wind_sfc_dir;
          if (di == null) continue;
          const cx = colCenter(i);
          const path = Skia.Path.Make();
          path.moveTo(cx - h, mid - s);
          path.lineTo(cx + h - HEAD_L, mid - s);
          path.lineTo(cx + h - HEAD_L, mid - w);
          path.lineTo(cx + h, mid);
          path.lineTo(cx + h - HEAD_L, mid + w);
          path.lineTo(cx + h - HEAD_L, mid + s);
          path.lineTo(cx - h, mid + s);
          path.close();
          const rotate = ((di * 45 + 90) % 360) * (Math.PI / 180);
          els.push(
            <Group key={`wd${ri}-${i}`} transform={[{ rotate }]} origin={vec(cx, mid)}>
              <Path path={path} color={C.dirArrow} />
            </Group>,
          );
        }
        break;
      }

      case 'model': {
        // One band per run of columns the same model serves, so a handoff reads as the width of
        // what it hands over rather than as a per-column repetition of the name. The separator is
        // drawn in the page's own white: at a handoff two bands can be a shade apart (ICON-EU 7km
        // beside ICON 13km), and a rule of their own is what keeps the seam a boundary.
        modelBands.forEach((band, bi) => {
          if (colLeft(band.end) < xLo || colLeft(band.start) > xHi) return;
          const x0 = colLeft(band.start);
          els.push(
            <Rect key={`mdl${ri}-${bi}`} x={x0} y={top} width={colLeft(band.end) - x0}
              height={row.height} color={rgb(modelBandRgb(band.spec))} />,
          );
          if (bi > 0) {
            els.push(<Line key={`mdlsep${ri}-${bi}`} p1={vec(x0, top)} p2={vec(x0, top + row.height)}
              color="#ffffff" strokeWidth={1} />);
          }
        });
        break;
      }

      case 'cloud-high': case 'cloud-mid': case 'cloud-low': {
        const key = CLOUD_KEYS[row.kind];
        for (let i = c0; i < c1; i++) {
          const pct = periods[i][key] as number | undefined;
          const cx = colCenter(i);
          if (pct == null) { els.push(centerText(`cc${ri}-${i}`, '—', cx, mid, fonts.data, C.nil)); continue; }
          els.push(<Rect key={`ccbg${ri}-${i}`} x={colLeft(i)} y={top} width={CELL_W} height={row.height}
            color={`rgba(130,130,130,${(pct / 100).toFixed(2)})`} />);
        }
        break;
      }
    }
  });

  // 5. Day dividers: a rule down each local-midnight boundary, from the header to the bottom row.
  // Drawn after the rows so it reads across the fill-encoded ones — wind ribbons and cloud alpha
  // would otherwise paint over it. It skips the section bands, which read as continuous label
  // strips and shouldn't be cut into.
  const dividerSpans: [number, number][] = [];
  let spanTop = 0;
  let spanY = ROW_H.DATE;
  rows.forEach((row) => {
    if (row.kind === 'section') {
      if (spanY > spanTop) dividerSpans.push([spanTop, spanY]);
      spanTop = spanY + row.height;
    }
    spanY += row.height;
  });
  if (spanY > spanTop) dividerSpans.push([spanTop, spanY]);
  dayGroups.slice(1).forEach((group, i) => {
    const x = colLeft(group.start);
    if (x < xLo || x > xHi) return;
    dividerSpans.forEach(([yFrom, yTo], s) => {
      els.push(<Line key={`day-divider${i}-${s}`} p1={vec(x, yFrom)} p2={vec(x, yTo)} color={C.divider} strokeWidth={1} />);
    });
  });

  // A rule on every seam INSIDE the precip block — snow/rain, rain/chance, snow/chance. These are
  // the drawing's only stacked rows that each plot from their own baseline, so without a rule an
  // area rising into the row above reads as that row's own bottom edge, and the chance curve
  // running low reads as a border under the rain. No rule at the block's outer edges: the rows
  // above and below it are unfilled and end it on their own. Drawn here, after the rows, so it
  // lies over the fills rather than under them.
  let seamY = ROW_H.DATE;
  let prevWasPrecip = false;
  rows.forEach((row) => {
    const isPrecip = PRECIP_BLOCK.has(row.kind);
    if (isPrecip && prevWasPrecip) {
      els.push(
        <Line key={`precip-seam${seamY}`} p1={vec(0, seamY)} p2={vec(width, seamY)}
          color={C.divider} strokeWidth={1} />,
      );
    }
    prevWasPrecip = isPrecip;
    seamY += row.height;
  });
  return { els, markerIndex };
}

// A single canvas tile, holding its own slice of the scene (buildScene) in the drawing's
// absolute coordinates, shifted into place. Memoized so a ModelCanvas re-render (selection
// moving, panel state, the minute tick moving the marker in another tile) repaints no tiles:
// a Skia Canvas repaints on any React commit that reaches it.
const CanvasTile = memo(function CanvasTile({ tile, els, totalH, paint, onPress }: {
  tile: Tile; els: ReactNode[]; totalH: number; paint: number;
  onPress: (locationX: number, tileOffset: number) => void;
}) {
  return (
    // Tap → column index. tile.offset is static per tile, so the tap position never needs
    // the native-driven scrollX; a drag hands the responder to the FlatList and cancels
    // the press.
    <Pressable onPress={(e) => onPress(e.nativeEvent.locationX, tile.offset)}>
      <Canvas key={paint} style={{ width: tile.width, height: totalH }}>
        <Group transform={[{ translateX: -tile.offset }]}>{els}</Group>
      </Canvas>
    </Pressable>
  );
});

// ── Fixed left rail ────────────────────────────────────────────────────────

// Rows whose rail entry is (or includes) a symbol rather than a word. Monochrome, in the rail's
// own ink: these say what a row IS, and a second color here would read as a value — every color
// elsewhere in the drawing encodes one.
//
// Direction gets a windsock and no word: the row is a line of arrows, and "dir" spelled out named
// something the arrows already say. The precip row's marks are not here — they come from
// precipMark, so that they are the strip's own drop and flake (see LEGEND_MARK_H).
const LEGEND_ICONS: Partial<Record<RowKind, (keyof typeof MaterialCommunityIcons.glyphMap)[]>> = {
  'wind-dir': ['windsock'],
};

// The rail's own grey, for both marks. The rail names rows; it does not carry values, and every
// other color in the drawing encodes one — a flake in the snow row's blue would read as a sample
// of that row rather than as its name. Shape and position say which row this is, and the divider
// under it says where the row ends. `ground` only matters to the mixed mark, which the rail never
// draws: each precip row gets the one mark that is its own.
const LEGEND_MARK_COLORS = { rain: C.unit, snow: C.unit, ground: '#ffffff' };

// Where the rail centers a row's entry, as an offset from the row's top. Most rows fill their
// height, so the entry sits in the middle of them; the rows that print a line of numbers instead
// hand the rail that line, so a unit reads against the values it names rather than against the
// row's geometric middle.
//
// The two amount rows solve for it: their entry is a mark stacked over a unit, and it is the UNIT
// that has to land on the numbers, not the stack as a whole. The unit's line box is centered half
// an icon BELOW the stack's center, so the stack goes up by that much — which leaves the mark
// sitting over the numbers, where a symbol naming them belongs. Temperature needs no such term:
// its entry is a bare unit, so the stack's center IS the unit's.
function legendCy(row: Row): number {
  if (row.kind === 'temp') return TEMP_VALUE_Y;
  if (row.kind === 'snow' || row.kind === 'rain') return PRECIP_VALUE_Y - LEGEND_ICON_H / 2;
  return row.height / 2;
}


/**
 * The unit rail: what each row is, written once and never scrolled away.
 *
 * It is laid out by walking the same row heights the scene walks, so an entry sits on its row by
 * construction rather than by a second set of coordinates that could drift from the drawing's.
 * Text and icons are RN views — nothing here moves, and a canvas per row would be a surface to
 * repaint on every commit that reaches this block. The one exception is the precip marks, which
 * are Skia because they are the strip's own geometry (precipMark) rather than a font glyph.
 *
 * Section bands carry their ground across the rail so a header reads as one strip rather than as
 * a label with a notch cut in front of it.
 */
const RowLegend = memo(function RowLegend({ rows, units, bandLevels, paint }: {
  rows: Row[]; units: UnitPrefs;
  // How many pressure levels the message's cloud band carries (0 when it carries none) — the
  // wire truncates the stack at one level below the forecast point, and the rail's ladder has
  // to list exactly the levels the band draws.
  bandLevels: number;
  // Epoch that remounts the marks canvas after this tab was hidden — see Meteogram.
  paint: number;
}) {
  const els: ReactNode[] = [];
  // The rail's edge, drawn first so every section band below paints over it: a header spans the
  // full width, and a divider crossing it cuts the strip in two. A child rather than the rail's
  // own border, which would sit above the bands however they were sized.
  els.push(<View key="edge" style={styles.legendEdge} />);
  // The hour row, which sits in the header above every data row and so is walked separately.
  els.push(
    <MaterialCommunityIcons key="clock" name="clock-outline" size={LEGEND_ICON_SIZE} color={C.unit}
      style={[styles.legendClock, { top: HOUR_LABEL_Y - LEGEND_ICON_H / 2 }]} />,
  );
  let y = ROW_H.DATE;
  rows.forEach((row, ri) => {
    const top = y;
    y += row.height;

    if (row.kind === 'section') {
      els.push(<View key={`sec${ri}`} style={[styles.legendSection, { top, height: row.height }]} />);
      return;
    }

    // The cloud band's axis: one altitude per carried wire level, on the same even ladder the
    // scene draws its gridlines with. Altitude rather than the transmitted pressure — a reader
    // in the mountains thinks in feet, and the pair ("14k · 600") doesn't fit a 44px rail. The
    // rung carries its own unit, and the detail panel gives both.
    //
    // A 1000 hPa floor goes unlabelled. It is the ground — 364 ft, and the ladder would have to
    // print a fraction to say so — and it sits on the row's own bottom edge, where a number reads
    // as much against the row below as against the band. A TRUNCATED floor is labelled: on a
    // summit forecast the bottom level is a real altitude one level below the point (18k on the
    // summit of Denali), not the ground, and the reader needs the scale's end named.
    if (row.kind === 'cloud-band') {
      const scale = bandScale(bandLevels);
      for (const hpa of scale.levels) {
        if (hpa === 1000) continue;
        const gy = top + scale.hpaToFrac(hpa) * row.height;
        // Rungs are centered on their own altitude, except at the ends: 300 hPa IS the row's top
        // edge, so centering would hang half the "30k+" over the section header above it, and a
        // truncated floor is the bottom edge likewise. The clamp drops each flush inside the
        // band instead — still reading against the edge it names. The inner rungs clear both
        // edges by a full slice, so for them the clamp only guards the arithmetic.
        const ty = Math.min(Math.max(gy - LEGEND_LEVEL_H / 2, top), top + row.height - LEGEND_LEVEL_H);
        els.push(
          <RNText key={`cb${ri}-${hpa}`} numberOfLines={1} style={[styles.legendLevel, { top: ty }]}>
            {ladderLabel(hpa, units.level, true)}
          </RNText>,
        );
      }
      return;
    }

    // Symbols over the unit, as one stack centered on whatever the row's own content lines up
    // with. A row can have either half or both.
    const icons = LEGEND_ICONS[row.kind];
    // The chance row takes a drop too, over "%" rather than over a depth: it is the odds of the
    // drop falling at all, and a shape the reader already reads as precipitation says that faster
    // than any glyph meaning "probability" could.
    const mark: PrecipMarkKind | undefined =
      row.kind === 'snow' ? 'snow'
        : row.kind === 'rain' || row.kind === 'precip-chance' ? 'rain'
          : undefined;
    const iconH = mark || icons ? LEGEND_ICON_H : 0;
    // Wind-aloft rungs sit on the cloud band's altitude ladder and print the same tokens, so
    // they wear the band's type (legendLevel) — one scale, one size.
    const onLadder = row.kind === 'wind-aloft';
    const textH = row.legend ? (onLadder ? LEGEND_LEVEL_H : LEGEND_LINE_H) : 0;
    if (!iconH && !textH) return;
    const stackTop = top + legendCy(row) - (iconH + textH) / 2;

    if (mark) {
      els.push(
        <Canvas key={`m${ri}-${paint}`} style={[styles.legendMarks, { top: stackTop }]}>
          {precipMark(mark, LEGEND_MARK_CX, LEGEND_ICON_H / 2, LEGEND_MARK_H, LEGEND_MARK_COLORS)
            .map((prim, i) => glyphPrimitive(`lm${ri}-${i}`, prim, false))}
        </Canvas>,
      );
    } else if (icons) {
      els.push(
        <View key={`i${ri}`} style={[styles.legendIcons, { top: stackTop, height: LEGEND_ICON_H }]}>
          {icons.map((name) => (
            <MaterialCommunityIcons key={name} name={name} size={LEGEND_ICON_SIZE} color={C.unit} />
          ))}
        </View>,
      );
    }
    if (row.legend) {
      els.push(
        <RNText key={`u${ri}`} numberOfLines={1}
          style={[onLadder ? styles.legendLevel : styles.legendUnit, { top: stackTop + iconH }]}>
          {row.legend}
        </RNText>,
      );
    }
  });
  return <View pointerEvents="none" style={styles.legend}>{els}</View>;
});

// Section headers, pinned rather than drawn into the scrolling scene. They span the full width of
// the block — rail included — because the band they sit on does.
const SectionLabels = memo(function SectionLabels({ rows }: { rows: Row[] }) {
  const els: ReactNode[] = [];
  let y = ROW_H.DATE;
  rows.forEach((row, ri) => {
    const top = y;
    y += row.height;
    if (row.kind !== 'section' || !row.label) return;
    els.push(
      <RNText key={ri} numberOfLines={1}
        style={[styles.sectionLabel, { top: top + (row.height - LEGEND_LINE_H) / 2 }]}>
        {row.label.toUpperCase()}
      </RNText>,
    );
  });
  return <View pointerEvents="none" style={styles.sectionOverlay}>{els}</View>;
});

// Animated.interpolate wants an input range that never goes backwards, and the sticky-label ranges
// below collapse two of their knots for anything anchored at content x=0 — the first day of the
// forecast, the first model band — now that the scene's columns start there. Drop the knots that
// don't advance; what's left describes the same piecewise line.
function monotonicRange(knots: [input: number, output: number][]): { inputRange: number[]; outputRange: number[] } {
  const inputRange: number[] = [];
  const outputRange: number[] = [];
  for (const [input, output] of knots) {
    if (inputRange.length && input <= inputRange[inputRange.length - 1]) continue;
    inputRange.push(input);
    outputRange.push(output);
  }
  return { inputRange, outputRange };
}

function ModelCanvas({ periods, rows, dates, zoned, steps, units, timeFormat, now, lat, lon, elevation, fonts, center, attributionMs, blockIndex, selected, onSelectColumn, paint, scrollY, pinTop, msg }: {
  // `steps` is each period's span in hours — the fill mixes resolutions within one message.
  // Columns stay equal-width; the span drives labels and shading.
  periods: Period[]; rows: Row[]; dates: Date[]; zoned: Date[]; steps: number[]; units: UnitPrefs; timeFormat: TimeFormat; now: number; lat: number; lon: number; elevation: number; fonts: Fonts;
  // The selector option this block was fetched under, and the instant its model horizons are
  // measured from — see modelSegments.
  center: Center; attributionMs: number;
  blockIndex: number; selected: number | null; onSelectColumn: (block: number, period: number) => void;
  // Epoch that remounts every canvas after this tab was hidden — see Meteogram.
  paint: number;
  // The decoder page's vertical scroll offset (native-driven), and this block's top edge within
  // that page's scroll content — together they place the pinned date header. `pinTop` is null
  // until the layout chain above this component has reported in.
  scrollY: Animated.Value; pinTop: number | null;
  // The decoded message this block renders. Only its identity is read here: a new message is a
  // newly loaded forecast, which starts reading from its first period.
  msg: ForecastMessage;
}) {
  const scrollX = useRef(new Animated.Value(0)).current;
  const flatListRef = useRef<FlatList<Tile>>(null);
  // A freshly loaded forecast starts at the beginning. The list persists across loads — blocks
  // re-render in place — so without this it would keep the previous forecast's scroll position,
  // which for a new message points at an unrelated stretch of time (or past the end entirely).
  useEffect(() => {
    flatListRef.current?.scrollToOffset({ offset: 0, animated: false });
  }, [msg]);
  const { width: winW, height: winH } = useWindowDimensions();
  // Where the strip docks and how much width the page spans are both orientation questions —
  // portrait clears the status bar above (the parked map covers the band behind the clock),
  // iPhone landscape clears the camera cutout at the sides instead (see insets.ts). The rail
  // sits inside this width, which is what keeps the legend out of the cutout.
  const { top: pinInset, side: sideInset } = pageInsets(winW, winH);
  const screenW = winW - 2 * sideInset;
  // How much of the forecast is on screen at once: the rail is beside the scroll view, not over
  // it, so it comes off the viewport rather than merely covering part of it.
  const viewportW = screenW - LEGEND_W;
  const n = periods.length;
  const width = n * CELL_W;
  const totalH = ROW_H.DATE + rows.reduce((s, r) => s + r.height, 0);
  // Where this block's canvas top sits in the page's scroll content: the block's own offset
  // (pinTop, measured by Meteogram) plus this component's offset within the block wrapper and
  // the overview strip above the canvas. Measured rather than summed from constants, so the
  // model header bar and the strip can change height without the pin point drifting.
  const [rootY, setRootY] = useState<number | null>(null);
  const [stripH, setStripH] = useState<number | null>(null);
  const headerY = pinTop != null && rootY != null && stripH != null ? pinTop + rootY + stripH : null;
  // The floating assembly: the overview strip is the REAL element, translated to dock flush
  // with the orientation's top inset (portrait: the status bar's bottom; iPhone landscape: the
  // top of the screen — see insets.ts), while the pinned copy of the
  // date header holds the line directly beneath it. Both dock at the same scroll instant: the
  // strip's top reaching its dock line is exactly the drawn header's top reaching the strip's
  // docked bottom, since the two are flush in the block — so one interpolation drives both, and
  // the plate's hard opacity switch lands while the copy lies exactly over the drawn header.
  // Both stop at the block's bottom, where the assembly slides off with its own rows rather
  // than floating over the next block's.
  const pin = useMemo(() => {
    if (headerY == null) return null;
    // The scroll offset at which the assembly docks: the strip's content-y top, less the dock
    // line's height down the screen.
    const dockY = headerY - stripH! - pinInset;
    const travel = totalH - ROW_H.DATE;
    return {
      translateY: scrollY.interpolate({
        inputRange: [dockY, dockY + travel], outputRange: [0, travel], extrapolate: 'clamp',
      }),
      // A hard switch, not a fade: below the pin point the copy would lie exactly over the drawn
      // header, hiding the night shading and the current-time marker it doesn't reproduce.
      opacity: scrollY.interpolate({
        inputRange: [dockY - 1, dockY], outputRange: [0, 1], extrapolate: 'clamp',
      }),
    };
  }, [headerY, stripH, totalH, scrollY, pinInset]);
  // Memoized so tile objects keep their identity across re-renders: CanvasTile bails out by
  // reference equality, and a fresh array would repaint every mounted tile on each selection.
  const tiles = useMemo(() => Array.from({ length: Math.ceil(width / CANVAS_TILE_W) }, (_, index) => {
    const offset = index * CANVAS_TILE_W;
    return { offset, width: Math.min(CANVAS_TILE_W, width - offset) };
  }), [width]);
  const colLeft = (i: number) => i * CELL_W;

  const dayGroups = useMemo(() => buildDayGroups(zoned), [zoned]);
  // The day labels, shared by the header row at the top of the block and its pinned copy: each
  // sticks to the visible left edge of its own day's columns, then yields to the following day.
  // Built once — the same scrollX interpolations drive both mounts.
  const dayLabelEls = useMemo(() => dayGroups.map((group, i) => {
    const start = group.start * CELL_W;
    const end = group.end * CELL_W;
    const label = fitDayLabel(group.date, end - start - 20, fonts.date);
    const textWidth = fonts.date.getTextWidth(label);
    const stickyEnd = end - textWidth - 20;
    const range = monotonicRange([
      [0, start + 10],
      [start, 10],
      [stickyEnd, 10],
      [width, end - textWidth - 10 - width],
    ]);
    const translateX = stickyEnd > start && range.inputRange.length >= 2
      ? scrollX.interpolate({ ...range, extrapolate: 'extend' })
      : Animated.subtract(start + 10, scrollX);
    return (
      <Animated.Text
        key={`day${i}`}
        style={[styles.stickyDayText, { transform: [{ translateX }] }]}
      >
        {label}
      </Animated.Text>
    );
  }), [dayGroups, width, fonts, scrollX]);
  // Native copies of the canvas's hour labels, for the pinned header: the number at the canvas's
  // size with the meridiem a couple of sizes down, sharing its baseline via nested Text the way
  // centerHour shares it, the pair centered in the column.
  const hourEls = useMemo(() => zoned.map((d, i) => {
    const parts = hourParts(d, steps[i], timeFormat);
    if (!parts.num) return null;
    return (
      <RNText key={`h${i}`} style={[styles.pinnedHourText, { left: i * CELL_W }]}>
        {parts.num}
        {parts.suffix ? <RNText style={styles.pinnedHourSuffix}>{parts.suffix}</RNText> : null}
      </RNText>
    );
  }), [zoned, steps, timeFormat]);
  // Held apart from the scene because the labels are drawn outside it, and memoized for the same
  // reason as the tiles: a fresh array on every render would repaint every mounted canvas.
  const modelBands = useMemo(
    () => modelSegments(dates, steps, predictCenter(center, lat, lon).models, attributionMs),
    [dates, steps, center, lat, lon, attributionMs],
  );
  const statics = useMemo(
    () => buildSceneStatics({ periods, rows, steps, elevation, units, fonts }),
    [periods, rows, steps, elevation, units, fonts]);
  // One scene slice per tile, built eagerly — the build is cheap element allocation, and building
  // them all up front costs about what the single full-scene build did. What it buys is the mount:
  // a tile commits only its own columns instead of the whole forecast, which is what made the
  // first paint slow and left blank tiles trailing a fast scroll.
  const slices = useMemo(
    () => tiles.map((tile) => buildScene({
      periods, rows, dates, zoned, steps, units, timeFormat, lat, lon, fonts, dayGroups, modelBands, statics,
      from: tile.offset / CELL_W, to: (tile.offset + tile.width) / CELL_W,
    })),
    [tiles, periods, rows, dates, zoned, steps, units, timeFormat, lat, lon, fonts, dayGroups, modelBands, statics],
  );
  // Current time, positioned proportionally within its period. It runs through the date/time
  // header and visual weather rows down to precip (statics.markerBottom). Built apart from the
  // slices because it is the one element that moves with the clock: the minute tick makes a new
  // marker, and only the tile it crosses re-renders.
  const marker = useMemo(() => {
    const i = dates.findIndex((date, k) => now >= date.getTime() && now < date.getTime() + steps[k] * 3600000);
    if (i < 0 || statics.markerTop == null || statics.markerBottom == null) return null;
    const fraction = (now - dates[i].getTime()) / (steps[i] * 3600000);
    const x = i * CELL_W + fraction * CELL_W;
    return {
      x,
      el: (
        <Line key="current-time" p1={vec(x, 0)} p2={vec(x, statics.markerBottom)}
          color="rgba(255,59,48,0.5)" strokeWidth={1}>
          <DashPathEffect intervals={[5, 4]} />
        </Line>
      ),
    };
  }, [now, dates, steps, statics]);
  // The marker spliced into the tile(s) it crosses, at the z-position the slice reserved for it
  // (over the area fills, under the row content). Unaffected tiles keep their slice's array
  // identity, so CanvasTile's memo holds for them.
  const tileEls = useMemo(() => slices.map((slice, k) => {
    if (marker == null) return slice.els;
    const tile = tiles[k];
    if (marker.x < tile.offset - 1 || marker.x > tile.offset + tile.width + 1) return slice.els;
    const els = slice.els.slice();
    els.splice(slice.markerIndex, 0, marker.el);
    return els;
  }), [slices, marker, tiles]);
  // Walked rather than measured from the bottom: the model row closes the weather rows, and the
  // air-quality block sits below it when the request asked for any of it.
  // Every dominant-pollutant row in this block: where it sits and the runs it labels. Walked
  // alongside modelRowTop because the labels are RN text outside the canvas, same as the model
  // names — a run of one pollutant can be wider than the screen.
  const dominantRows = useMemo(() => {
    const out: { kind: AqDominantKind; top: number; segs: DominantSegment[] }[] = [];
    let y = ROW_H.DATE;
    for (const row of rows) {
      if (row.kind === 'aqi-dominant' || row.kind === 'aqi-eu-dominant')
        out.push({ kind: row.kind, top: y, segs: dominantSegments(periods, row.kind) });
      y += row.height;
    }
    return out;
  }, [rows, periods]);

  const modelRowTop = useMemo(() => {
    let y = ROW_H.DATE;
    for (const row of rows) {
      if (row.kind === 'model') return y;
      y += row.height;
    }
    return y;
  }, [rows]);

  // Where the cloud-cover rows sit in the canvas, so the selected column can carry its percentages
  // as text. The rows are shaded by cover and otherwise unlabelled — a number in all three rows of
  // every 38px column would be a wall of digits — so the selection is what asks for the reading,
  // and it lands on the cells the reader just pointed at rather than only in the panel below.
  const cloudRows = useMemo(() => {
    const found: { kind: CloudKind; top: number; height: number }[] = [];
    let y = ROW_H.DATE;
    rows.forEach((row) => {
      if (row.kind in CLOUD_KEYS) found.push({ kind: row.kind as CloudKind, top: y, height: row.height });
      y += row.height;
    });
    return found;
  }, [rows]);

  const onPressTile = useCallback((locationX: number, tileOffset: number) => {
    const x = tileOffset + locationX;
    onSelectColumn(blockIndex, Math.min(periods.length - 1, Math.floor(x / CELL_W)));
  }, [onSelectColumn, blockIndex, periods.length]);
  const renderTile = useCallback(({ item: tile, index }: { item: Tile; index: number }) => (
    <CanvasTile tile={tile} els={tileEls[index]} totalH={totalH} paint={paint} onPress={onPressTile} />
  ), [tileEls, totalH, paint, onPressTile]);

  // The selection overlay tracks the scroll on the native driver, but only the scroll: which column
  // it sits on is a discrete jump, so it rides a static `left` that commits with everything else
  // about the selection. Pushing the column offset through the animated graph instead splits the
  // two apart — the offset would arrive a frame late, through an effect and then an async native
  // node, while the cloud percentages inside the overlay update in the commit itself, so the new
  // column's numbers paint over the old column before the box slides. The graph is built once and
  // never re-attached: a fresh node per selection doesn't recompute until the next scroll event,
  // which would strand the overlay off-screen-left until the user nudged the list.
  const scrollShift = useRef(Animated.multiply(scrollX, -1)).current;
  const selectedLeft = selected != null ? selected * CELL_W : 0;

  return (
    <View onLayout={(e) => setRootY(e.nativeEvent.layout.y)}>
      {/* The strip spans the whole screen, rail and all: it is a map of the forecast rather than
          a row of it, and insetting it would spend 44px of an already coarse graph on nothing.
          What it does share with the rows below is the viewport those rows are read through.
          The wrapper is what floats: the strip itself rides the pin translation (scrubber and
          all — it is not a copy), over the rows that slide beneath it, docked flush with the
          bottom of the status bar; the parked map above it (HomeScreen) owns the band the clock
          sits on. */}
      <Animated.View style={[styles.stripFloat, pin && { transform: [{ translateY: pin.translateY }] }]}>
        <OverviewStrip periods={periods} dates={dates} zoned={zoned} steps={steps} units={units} now={now}
          width={screenW} viewportW={viewportW} flatListRef={flatListRef} scrollX={scrollX} fonts={fonts} paint={paint} />
      </Animated.View>
      <View style={{ height: totalH }} onLayout={(e) => setStripH(e.nativeEvent.layout.y)}>
      {/* Everything that scrolls, inset past the rail. The overlays inside here are positioned in
          viewport coordinates and ride the scroll; the rail and the section labels are siblings
          of this view, in the block's own coordinates, and never move. */}
      <View style={{ height: totalH, marginLeft: LEGEND_W }}>
      <Animated.FlatList
        ref={flatListRef}
        data={tiles}
        horizontal
        bounces={false}
        // No scroll indicator: it draws at the bottom of the list over whatever row is last,
        // and the overview strip above already shows where the viewport sits in the window —
        // which it does continuously, and for the whole forecast rather than the scroll extent.
        showsHorizontalScrollIndicator={false}
        scrollEventThrottle={16}
        keyExtractor={(tile) => String(tile.offset)}
        // The paint epoch lives outside `data`, so tell the list its cells are stale when it moves.
        extraData={paint}
        // Render tiles ahead of the viewport so one mounts before it scrolls into view rather
        // than as it appears. A tile mounts only its own slice of the scene (see buildScene), so
        // the render window can afford to run a tile or two further past the screen than it used
        // to — but not much further: every mounted tile holds a full-height Metal drawable, and
        // that is a memory cost the slicing didn't change.
        initialNumToRender={3}
        maxToRenderPerBatch={4}
        windowSize={7}
        // Never let the ScrollView natively detach canvas tiles: a Skia Canvas repaints only on
        // React commits, so a reattached tile keeps its released (blank) Metal drawable.
        // Virtualization via windowSize still unmounts far-off tiles for memory.
        removeClippedSubviews={false}
        getItemLayout={(_, index) => ({
          length: CANVAS_TILE_W,
          offset: CANVAS_TILE_W * index,
          index,
        })}
        onScroll={Animated.event(
          [{ nativeEvent: { contentOffset: { x: scrollX } } }],
          { useNativeDriver: true },
        )}
        renderItem={renderTile}
      />
      {selected != null && (
        <View pointerEvents="none" style={styles.highlightClip}>
          <Animated.View
            style={[styles.highlightBox, {
              left: selectedLeft,
              height: totalH - 31,
              transform: [{ translateX: scrollShift }],
            }]}
          />
          {/* Cloud percentages, in the highlighted column's own cells. They sit on the same left
              edge as the box and take the same scroll shift, so they stay on their cells through a
              scroll and move with the box on a selection, and they are drawn over the canvas rather
              than into it — a selection must not rebuild the scene (see CanvasTile). Near-black
              throughout: the cover wash tops out at a mid gray, which never darkens far enough for
              white to be the better ink. */}
          <Animated.View
            style={[styles.cloudReadout, { left: selectedLeft, transform: [{ translateX: scrollShift }] }]}
          >
            {cloudRows.map(({ kind, top, height }) => {
              const pct = periods[selected][CLOUD_KEYS[kind]];
              // A missing value keeps the canvas's own dash — there is no reading to give.
              if (pct == null) return null;
              return (
                <RNText key={kind} style={[styles.cloudReadoutText, { top, lineHeight: height }]}>
                  {pct}%
                </RNText>
              );
            })}
          </Animated.View>
        </View>
      )}
      <View pointerEvents="none" style={styles.stickyDayRow}>
        {dayLabelEls}
      </View>
      {/* Model names ride above their bands the way the day labels ride above their columns: a
          band can run four screens wide — IFS covering everything past the short-range models —
          and a label centered in it would be off screen for most of that span. Each one sticks to
          the visible left edge while its own band is in view, then hands over at the seam. */}
      <View pointerEvents="none" style={[styles.stickyModelRow, { top: modelRowTop, height: ROW_H.MODEL }]}>
        {modelBands.map((band, i) => {
          const start = colLeft(band.start);
          const end = colLeft(band.end);
          const label = fitModelLabel(band.spec, end - start - 16, fonts.model);
          if (!label) return null;
          const textWidth = fonts.model.getTextWidth(label);
          // Where the label stops being pinned and starts leaving with its band: two pads short of
          // the band's right edge, which is where the pinned line and the parked one meet — the
          // label then holds one pad inside the seam for the rest of the scroll.
          const stickyEnd = end - textWidth - 16;
          const range = monotonicRange([
            [0, start + 8],
            [start, 8],
            [stickyEnd, 8],
            [width, end - textWidth - 8 - width],
          ]);
          const translateX = stickyEnd > start && range.inputRange.length >= 2
            ? scrollX.interpolate({ ...range, extrapolate: 'extend' })
            : Animated.subtract(start + 8, scrollX);
          return (
            <Animated.Text
              key={`mdl${i}`}
              style={[styles.stickyModelText, {
                color: bandInk(modelBandRgb(band.spec)),
                transform: [{ translateX }],
              }]}
            >
              {label}
            </Animated.Text>
          );
        })}
      </View>
      {/* The dominant pollutant rides its run the way a model name rides its band: pinned to the
          visible edge while the run is in view, handing over at the tick. Written once per run —
          a stretch of PM2.5 is one fact, and repeating it per column buried the thing that does
          change, which is where it stops being PM2.5. */}
      {dominantRows.map(({ kind, top, segs }) => (
        <View key={`dom-${kind}`} pointerEvents="none"
          style={[styles.stickyModelRow, { top, height: ROW_H.WIND }]}>
          {segs.map((seg, i) => {
            const start = colLeft(seg.start);
            const end = colLeft(seg.end);
            // Measured as the label's BOX, not its glyphs: the plate is padded to cut the rule
            // where the text sits, and translateX moves that box's left edge, so centring on the
            // glyphs alone would let the plate hang over the run's cap.
            //
            // The PAD is what gives way on a narrow run, not the label. A single period is 34px
            // and "PM2.5" is ~31 of them, so a fixed 4px each side overflowed and the name was
            // dropped entirely — a bracket with nothing in it. The pad shrinks to whatever is
            // left instead, down to nothing, and only a run too narrow for the glyphs themselves
            // goes unlabelled.
            const glyphW = fonts.model.getTextWidth(seg.label);
            const runW = end - start;
            const avail = runW - 2;
            if (glyphW > avail) return null;
            const pad = Math.max(0, Math.min(4, (avail - glyphW) / 2));
            const textWidth = glyphW + pad * 2;
            // Centered in the VISIBLE part of the run, not pinned to the edge: the label tracks
            // the middle of however much of its band is on screen, and comes to rest in the
            // middle of the band once the whole thing fits. Clamped to the run so a sliver at the
            // edge of the screen can't push the name out over the run next door.
            //
            // NOTE `viewportW`, not `width` — in this scope `width` is the CONTENT width
            // (n · CELL_W), which is several screens across. The sticky day and model labels use
            // it only as a far extrapolation anchor, where any value past the pin gives the slope
            // they want; here it is the viewport that defines "visible", and using the content
            // width instead puts the label off the right of the screen.
            const labelX = (sx: number) => {
              const l = Math.max(start - sx, 0);
              const r = Math.min(end - sx, viewportW);
              const c = (l + r) / 2 - textWidth / 2;
              return Math.min(Math.max(c, start - sx), end - sx - textWidth);
            };
            // The function is piecewise linear; these are its knees, so sampling exactly here
            // reproduces it rather than approximating it. Outer anchors extend the end slopes.
            const knees = [
              start - viewportW + textWidth,
              Math.min(start, end - viewportW),
              Math.max(start, end - viewportW),
              end - textWidth,
            ];
            const inputRange: number[] = [];
            for (const v of [knees[0] - viewportW, ...knees, knees[3] + viewportW])
              if (!inputRange.length || v > inputRange[inputRange.length - 1] + 0.01)
                inputRange.push(v);
            const translateX = inputRange.length >= 2
              ? scrollX.interpolate({
                  inputRange, outputRange: inputRange.map(labelX), extrapolate: 'extend',
                })
              : Animated.subtract(start + (runW - textWidth) / 2, scrollX);
            return (
              <Animated.Text
                key={`dom${i}`}
                style={[styles.stickyModelText, styles.stickyDominantText, {
                  paddingHorizontal: pad,
                  transform: [{ translateX }],
                }]}
              >
                {seg.label}
              </Animated.Text>
            );
          })}
        </View>
      ))}
      </View>
      <RowLegend rows={rows} units={units} paint={paint}
        bandLevels={periods.find((p) => p.cloud_band)?.cloud_band?.length ?? 0} />
      <SectionLabels rows={rows} />
      {/* The pinned date header. With enough rows selected the drawn header is off the top of the
          screen before the reader is halfway down the block, and a column's day and hour were
          then only recoverable by scrolling back up — the one question the fixed rail can't
          answer, since time is the axis it doesn't name. This copy holds the viewport's top edge
          while the block is under it, on the same native scroll value the page moves with. It is
          a duplicate rather than the header itself: the drawn header keeps its night shading and
          the current-time marker, which the plate doesn't reproduce, so the copy stays invisible
          until the moment the real one leaves the screen. */}
      {pin && (
        <Animated.View pointerEvents="none"
          style={[styles.pinnedHeader, { opacity: pin.opacity, transform: [{ translateY: pin.translateY }] }]}>
          <View style={styles.pinnedHeaderScene}>
            <Animated.View style={[styles.pinnedHourStrip, { width, transform: [{ translateX: scrollShift }] }]}>
              {hourEls}
            </Animated.View>
            <View pointerEvents="none" style={styles.stickyDayRow}>{dayLabelEls}</View>
            <View style={styles.pinnedDayRule} />
          </View>
          {/* The rail's slice of the header — edge and clock — so the plate reads as one strip
              with the rail below it, and a day label scrolling past the edge disappears under it
              exactly as it does in the block. */}
          <View style={styles.pinnedHeaderRail}>
            <View style={styles.legendEdge} />
            <MaterialCommunityIcons name="clock-outline" size={LEGEND_ICON_SIZE} color={C.unit}
              style={[styles.legendClock, { top: HOUR_LABEL_Y - LEGEND_ICON_H / 2 }]} />
          </View>
        </Animated.View>
      )}
      </View>
    </View>
  );
}

// ── Public component ─────────────────────────────────────────────────────--

export default function Meteogram({ msg, units, timeFormat, active, scrollY, onDetailHeight }: {
  msg: ForecastMessage; units: UnitPrefs; timeFormat: TimeFormat; active: boolean;
  // The page's vertical scroll offset (native-driven) — see the pinned header in ModelCanvas.
  scrollY: Animated.Value;
  // Height of the open tap detail panel, 0 when closed. The panel sits below the blocks but
  // above the attribution HomeScreen measures the map park against, so HomeScreen subtracts
  // this to keep the park ending where the blocks end — otherwise the map stays parked in the
  // status-bar band while the strip and plate ride off, and the stack tears.
  onDetailHeight?: (h: number) => void;
}) {
  // The layout chain the pinned headers hang off: this component's top within the page's scroll
  // content, and each block's top within this component. Summed per block and handed down;
  // ModelCanvas measures its own internal offsets.
  const [selfY, setSelfY] = useState<number | null>(null);
  const [blockTops, setBlockTops] = useState<Record<number, number>>({});
  // Memoized because `blocks` depends on it: a fresh array here would rebuild every block —
  // and with them every Skia scene — on each render, e.g. whenever the selection moves.
  const models = useMemo(() => modelsFromMask(msg.models_mask), [msg.models_mask]);
  const [now, setNow] = useState(Date.now());
  const [selection, setSelection] = useState<{ block: number; period: number } | null>(null);

  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 60000);
    return () => clearInterval(timer);
  }, []);

  // A new message may have different period counts and models; drop the selection.
  useEffect(() => setSelection(null), [msg]);

  // A Skia canvas draws into a drawable its layer only vends while the view is on screen, and hiding
  // this tab (`display: none`) zeroes the layout underneath it — the drawables go with it, and
  // nothing repaints them on the way back, so the meteogram returns blank. Bump a paint epoch on each
  // hide→show; the canvases are keyed on it, so they come back as fresh surfaces. Only the canvases
  // remount: the list around them keeps its scroll position, and the selection survives too.
  const [paint, setPaint] = useState(0);
  const wasActive = useRef(active);
  useEffect(() => {
    if (active && !wasActive.current) setPaint((epoch) => epoch + 1);
    wasActive.current = active;
  }, [active]);

  // Stable across renders so the memoized canvas tiles never see a new press handler.
  const selectColumn = useCallback((block: number, period: number) => setSelection({ block, period }), []);

  const fonts = useMemo<Fonts>(() => ({
    data: matchFont({ fontSize: 13 }),
    small: matchFont({ fontSize: 10.5, fontWeight: '600' }),
    date: matchFont({ fontSize: 14, fontWeight: '600' }),
    hour: matchFont({ fontSize: 12, fontWeight: '400' }),
    hourSuffix: matchFont({ fontSize: 9.5, fontWeight: '400' }),
    strip: matchFont({ fontSize: 11, fontWeight: '300' }),
    wind: matchFont({ fontSize: 11.5, fontWeight: '400' }),
    model: matchFont({ fontSize: 11, fontWeight: '600' }),
  }), []);

  const blocks = useMemo(() => msg.periods.map((periods, mi) => {
    const start = startDatetime(msg);
    // Per-period spans can be mixed (the layout refines near-term days first). Each period
    // starts where the previous one ended.
    const steps = msg.periodHours;
    const dates: Date[] = [];
    let t = start.getTime();
    for (const step of steps) {
      dates.push(new Date(t));
      t += step * 3600000;
    }
    return {
      name: models[mi] ?? `Model ${mi + 1}`,
      color: MODEL_COLORS[models[mi]] ?? '#666',
      center: MODEL_CENTERS[models[mi]] ?? 'best',
      // What the model row measures each model's horizon from. The message doesn't carry the
      // request time — the header holds the first period's start, which is that time floored to
      // the first period's resolution (see layout.ts), so it runs up to one period early. That is
      // inside the tolerance attribution already has: a horizon boundary moves with the age of
      // the newest full-length run, which is only known to within its run interval.
      attributionMs: dates[0].getTime(),
      // lat/lon decide which CAMS domain the air-quality header names, the same way they decide
      // the model row's chain.
      rows: buildRows(periods, units, msg.lat, msg.lon),
      // The wall clock everything is labelled on belongs to the forecast point, not to wherever
      // the reader is: a Tokyo forecast read from Seattle names Tokyo's hours and breaks its days
      // at Tokyo's midnight. The offset rides along on the message, so a forecast pulled up later
      // — or in another timezone — still reads on the clock it was laid out for.
      zoned: zonedDates(dates, msg.utcOffsetHours),
      periods, dates, steps,
    };
  }), [msg, models, units]);

  const sel = selection != null && selection.period < (blocks[selection.block]?.periods.length ?? 0)
    ? selection
    : null;

  return (
    <View style={styles.container} onLayout={(e) => setSelfY(e.nativeEvent.layout.y)}>
      {blocks.map((b, bi) => (
        <View key={bi} onLayout={(e) => {
          const { y } = e.nativeEvent.layout;
          setBlockTops((prev) => (prev[bi] === y ? prev : { ...prev, [bi]: y }));
        }}>
          {/* Model header is a plain RN bar so it stays pinned at full width above the scrolling canvas. */}
          {blocks.length > 1 && (
            <View style={[styles.modelHeaderBar, { backgroundColor: b.color }]}>
              <RNText style={styles.modelHeaderText}>{b.name}</RNText>
            </View>
          )}
          <ModelCanvas periods={b.periods} rows={b.rows} dates={b.dates} zoned={b.zoned} steps={b.steps} units={units} timeFormat={timeFormat} now={now} lat={msg.lat} lon={msg.lon} elevation={msg.elevation} fonts={fonts}
            center={b.center} attributionMs={b.attributionMs}
            blockIndex={bi}
            selected={sel?.block === bi ? sel.period : null}
            onSelectColumn={selectColumn} paint={paint}
            scrollY={scrollY} msg={msg}
            pinTop={selfY != null && blockTops[bi] != null ? selfY + blockTops[bi] : null} />
          {bi < blocks.length - 1 && <View style={styles.sep} />}
        </View>
      ))}
      {/* Wrapped and measured even while closed, so closing reports a height of 0 — see
          onDetailHeight. */}
      <View onLayout={(e) => onDetailHeight?.(e.nativeEvent.layout.height)}>
      {sel != null && (
        <DetailPanel
          periods={blocks[sel.block].periods}
          index={sel.period}
          dates={blocks[sel.block].dates}
          zoned={blocks[sel.block].zoned}
          steps={blocks[sel.block].steps}
          modelName={blocks.length > 1 ? blocks[sel.block].name : undefined}
          modelColor={blocks[sel.block].color}
          units={units}
          timeFormat={timeFormat}
          lat={msg.lat}
          lon={msg.lon}
          utcOffsetHours={msg.utcOffsetHours}
          paint={paint}
          onClose={() => setSelection(null)}
        />
      )}
      </View>
    </View>
  );
}

// ── Tap detail panel ───────────────────────────────────────────────────────

const LEADER_DOTS = '.'.repeat(160);

// Detail-panel label for a pressure-level wind row, e.g. "Wind 18,000 ft" or "Wind 500 hPa" — the
// level named the same way the panel's cloud rows name theirs.
function upperWindLabel(hpa: number, units: UnitPrefs): string {
  return `Wind ${fmtLevelFull(hpa, units)}`;
}

const MOON_PHASE_LABELS: Record<CyclePhase, string> = {
  'new': 'New moon',
  'waxing-crescent': 'Waxing crescent',
  'first-quarter': 'First quarter',
  'waxing-gibbous': 'Waxing gibbous',
  'full': 'Full moon',
  'waning-gibbous': 'Waning gibbous',
  'last-quarter': 'Last quarter',
  'waning-crescent': 'Waning crescent',
};

// Sun and moon over the whole calendar day the selected column falls in — the one span in the panel
// that isn't the selected period. `dayStart` is the absolute instant of that day's local midnight;
// the day runs 24h from there, on the fixed offset the whole axis is laid out on.
function astroRows(
  dayStart: number, utcOffsetHours: number, lat: number, lon: number, timeFormat: TimeFormat,
): [string, string][] {
  const dayEnd = dayStart + 86400000;
  const sun = riseSet(dayStart, dayEnd, (t) => sunAltitude(t, lat, lon), SUN_HORIZON);
  const moon = riseSet(dayStart, dayEnd, (t) => moonAltitude(t, lat, lon), MOON_HORIZON);

  // A day with neither crossing describes itself — polar summer and winter for the sun, and the
  // nights the moon happens to stay up or stay down for. With one of the two, the other simply
  // fell outside this midnight-to-midnight window and the day has nothing to say about it.
  const label = (event: number | null, body: RiseSet): string => {
    if (event != null) return clockLabel(new Date(event + utcOffsetHours * 3600000), timeFormat);
    if (body.rise != null || body.set != null) return '—';
    return body.everUp ? 'Up all day' : 'Below horizon';
  };

  // Named and measured at the day's local noon: a single instant to speak for the day, and the one
  // furthest from the midnights where the name could tip either way.
  const noon = dayStart + 12 * 3600000;
  const illuminated = Math.round((1 - Math.cos(2 * Math.PI * moonCycleAt(noon))) / 2 * 100);
  const phase = MOON_PHASE_LABELS[moonPhaseAt(noon)];

  return [
    ['Sunrise', label(sun.rise, sun)],
    ['Sunset', label(sun.set, sun)],
    ['Moonrise', label(moon.rise, moon)],
    ['Moonset', label(moon.set, moon)],
    ['Moon phase', `${phase}, ${illuminated}% lit`],
  ];
}

// The glyph appearance a period selects: what to draw, on which ground.
function glyphVariantAt(periods: Period[], dates: Date[], steps: number[], i: number, lat: number, lon: number) {
  const midpoint = dates[i].getTime() + steps[i] * 1800000;
  const night = isNight(midpoint, lat, lon);
  const phase = night ? moonPhaseAt(midpoint) : 'full' as MoonPhase;
  return { key: `${periods[i].weathercode}|${night}|${phase}`, code: periods[i].weathercode, night, phase };
}

function DetailPanel({ periods, index, dates, zoned, steps, modelName, modelColor, units, timeFormat, lat, lon, utcOffsetHours, paint, onClose }: {
  // `dates` are absolute — the glyph's day/night ground comes off the sun. `zoned` names the hours
  // on the forecast point's clock, matching the column the tap came from.
  periods: Period[]; index: number; dates: Date[]; zoned: Date[]; steps: number[];
  modelName?: string; modelColor: string;
  units: UnitPrefs; timeFormat: TimeFormat; lat: number; lon: number; utcOffsetHours: number;
  // Epoch that remounts the glyph canvases after this tab was hidden — see Meteogram.
  paint: number;
  onClose: () => void;
}) {
  const p = periods[index];
  const date = zoned[index]; // labels only
  const step = steps[index];
  // Row presence mirrors buildRows: a group renders when any period in the model has it, and a
  // missing value within a present group reads — like the canvas dashes.
  const has = (fn: (q: Period) => unknown) => periods.some((q) => fn(q) != null);
  // Snow is the one group kept on amount rather than presence, the same test the snow row on the
  // canvas passes: a requested-but-dry column reads back as zeros, and a panel that lists them
  // spends two lines saying a snowless week is snowless.
  const hasAmount = (fn: (q: Period) => number | undefined) => periods.some((q) => (fn(q) ?? 0) > 0);

  // A Skia canvas applies child updates through its own async reconciler, so redrawing one canvas
  // per selection shows the new glyph a beat after the surrounding text. Instead, mount a canvas
  // per distinct glyph appearance in this model once, and switch periods by flipping which one is
  // visible — an ordinary style change that commits with the text.
  const glyphVariants = useMemo(() => {
    const seen = new Map<string, { key: string; code: number; night: boolean; phase: MoonPhase }>();
    periods.forEach((_, i) => {
      const variant = glyphVariantAt(periods, dates, steps, i, lat, lon);
      if (!seen.has(variant.key)) seen.set(variant.key, variant);
    });
    return [...seen.values()];
  }, [periods, dates, steps, lat, lon]);

  // Scanning both bodies across a day costs a few hundred trig evaluations, so it is held against
  // the day rather than the column: stepping along the columns of one day recomputes nothing.
  const dayStart = zonedMidnight(date) - utcOffsetHours * 3600000;
  const astro = useMemo(
    () => astroRows(dayStart, utcOffsetHours, lat, lon, timeFormat),
    [dayStart, utcOffsetHours, lat, lon, timeFormat],
  );

  let cumRain = 0;
  let cumSnow = 0;
  for (let i = 0; i <= index; i++) {
    cumRain += periods[i].rain_mm ?? 0;
    cumSnow += periods[i].snow_cm ?? 0;
  }

  const timeText = step >= 24
    ? `${fullDateLabel(date)} · all day`
    : step > 1
      ? `${fullDateLabel(date)}, ${hourLabel(date, 1, timeFormat)}–${hourLabel(new Date(date.getTime() + step * 3600000), 1, timeFormat)}`
      : `${fullDateLabel(date)}, ${hourLabel(date, 1, timeFormat)}`;

  const activeGlyph = glyphVariantAt(periods, dates, steps, index, lat, lon);
  const night = activeGlyph.night;

  // The readout is grouped the way the canvas is sectioned, one group per subject, and a rule is
  // drawn between the groups that survive. Rows keep the order they had; only the rules are new.
  const thermal: [string, string][] = [];
  const precip: [string, string][] = [];
  const wind: [string, string][] = [];
  const clouds: [string, string][] = [];
  const air: [string, string][] = [];

  if (has((q) => q.temp_c))
    thermal.push(['Temperature', p.temp_c != null ? `${fmtTemp(p.temp_c, units)}${units.temp === 'f' ? 'F' : 'C'}` : '—']);
  // The freezing level rides with temperature rather than with the winds it used to sit among:
  // it is the other thing this column says about heat, and keeping it here leaves the surface
  // wind and the levels above it unbroken.
  if (has((q) => q.freeze_m)) thermal.push(['Freezing level', fmtFreezeFull(p.freeze_m, units)]);

  // Probability lives here and only here: the drawing carries the two amounts, and this panel is
  // where a column's numbers are read one at a time.
  if (has((q) => q.precip)) precip.push(['Precip chance', p.precip != null ? `${p.precip}%` : '—']);
  // Snow before rain, the order the two rows are drawn in.
  if (hasAmount((q) => q.snow_cm)) {
    precip.push(['Snow', fmtSnowFull(p.snow_cm ?? 0, units)]);
    precip.push(['Total snow accumulation', fmtSnowFull(cumSnow, units)]);
  }
  if (has((q) => q.rain_mm)) {
    precip.push(['Rain', fmtRainFull(p.rain_mm ?? 0, units)]);
    precip.push(['Total rain accumulation', fmtRainFull(cumRain, units)]);
  }

  if (has((q) => q.wind_sfc_kph)) wind.push(['Wind', fmtWindFull(p.wind_sfc_kph, p.wind_sfc_dir, units)]);
  // On the surface wind's direction: a gust is that wind's peak, not a second wind, and the wire
  // carries no bearing of its own for it.
  if (has((q) => q.wind_gust_kph)) wind.push(['Gust', fmtWindFull(p.wind_gust_kph, p.wind_sfc_dir, units)]);
  for (const li of windLevelsPresent(periods)) {
    const w = p.wind_aloft?.[li];
    wind.push([upperWindLabel(WIND_LEVELS_HPA[li], units), fmtWindFull(w?.kph, w?.dir, units)]);
  }

  if (has((q) => q.cloud_band)) {
    // Only the levels the message carries — the wire truncates the stack at one level below the
    // forecast point, so the carried count is any band-bearing period's array length. A period
    // outside the band's resolution clamp lists them with dashes, like any other absent value.
    const bandLevels = periods.find((q) => q.cloud_band)?.cloud_band?.length ?? 0;
    CLOUD_BAND_LEVELS_HPA.slice(0, bandLevels).forEach((hpa, li) => {
      const v = p.cloud_band?.[li];
      // "and above" on the top level, matching the rail's "30k+" — the highest level the
      // message carries is the only one whose reading is not bracketed by a level above it.
      const at = fmtLevelFull(hpa, units) + (hpa === BAND_TOP_HPA ? ' and above' : '');
      clouds.push([`Clouds ${at}`, v != null ? `${v}%` : '—']);
    });
  }
  if (has((q) => q.cloud_high)) clouds.push(['Cloud high (>8km)', p.cloud_high != null ? `${p.cloud_high}%` : '—']);
  if (has((q) => q.cloud_mid)) clouds.push(['Cloud mid (3–8km)', p.cloud_mid != null ? `${p.cloud_mid}%` : '—']);
  if (has((q) => q.cloud_low)) clouds.push(['Cloud low (<3km)', p.cloud_low != null ? `${p.cloud_low}%` : '—']);

  // Air quality reads out with its category named — the number alone doesn't say whether to go
  // outside, and the two scales name their categories differently at the same value. A period
  // past the CAMS horizon has no value at all and says so.
  for (const kind of AQ_KINDS) {
    const { field, label, scale } = AQ_KEYS[kind];
    if (!has((q) => q[field])) continue;
    const v = p[field] as number | undefined;
    air.push([label, v != null ? `${Math.round(v)} · ${aqBand(v, scale).name}` : 'Not forecast']);
    // The headline's line is followed by what is driving it, so the readout answers "how bad"
    // and "of what" together.
    const dom = AQ_DOMINANT_FOR[kind];
    if (!dom) continue;
    const dk = AQ_DOMINANT_KEYS[dom];
    if (!has((q) => q[dk.field] as unknown)) continue;
    air.push(['Dominant pollutant', pollutantName(dk.scale, p[dk.field] as number | undefined) ?? '—']);
  }

  // The astronomy group answers for the whole day, not the selected period. It needs no header of
  // its own — the panel's header already names the day, and now the same rule that separates
  // every other group sets it apart.
  const groups: { key: string; rows: [string, string][] }[] = [
    { key: 'thermal', rows: thermal },
    { key: 'precip', rows: precip },
    { key: 'wind', rows: wind },
    { key: 'clouds', rows: clouds },
    { key: 'air', rows: air },
    { key: 'astro', rows: astro },
  ].filter((g) => g.rows.length > 0);

  return (
    <View style={styles.detailPanel}>
      <View style={styles.detailHeader}>
        <RNText style={styles.detailTime}>{timeText}</RNText>
        <Pressable onPress={onClose} hitSlop={8}>
          <RNText style={styles.detailClose}>✕</RNText>
        </Pressable>
      </View>
      {modelName != null && (
        <View style={[styles.detailModelChip, { backgroundColor: modelColor }]}>
          <RNText style={styles.detailModelText}>{modelName}</RNText>
        </View>
      )}
      <View style={styles.detailSummary}>
        <View style={[styles.detailGlyphWrap, night && { backgroundColor: C.night }]}>
          {glyphVariants.map((variant) => (
            <View key={variant.key} style={[styles.detailGlyphLayer, variant.key !== activeGlyph.key && styles.detailGlyphHidden]}>
              <Canvas key={paint} style={{ width: 48, height: 48 }}>
                {/* Same convention as the clouds row: cloudGlyph centers on top + 58/2, scaled
                    about the canvas center. */}
                <Group transform={[{ scale: 0.75 }]} origin={vec(24, 24)}>
                  {cloudGlyph(`dg-${variant.key}`, 24, -5, 58, variant.code, variant.night, variant.phase)}
                </Group>
              </Canvas>
            </View>
          ))}
        </View>
        <RNText style={styles.detailCodeName}>{wmoName(p.weathercode)}</RNText>
      </View>
      {/* A rule between groups, never above the first one or below the last. */}
      {groups.map((group, gi) => (
        <Fragment key={group.key}>
          {gi > 0 && <View style={styles.detailDivider} />}
          {group.rows.map(([label, value]) => <DetailRow key={label} label={label} value={value} />)}
        </Fragment>
      ))}
    </View>
  );
}

function DetailRow({ label, value }: { label: string; value: string }) {
  return (
    <View style={styles.detailRow}>
      <RNText style={styles.detailLabel}>{label}</RNText>
      {/* Leader dots: a clipped run of periods stretches to whatever space the label and
          value leave, tying the pair together across the row. */}
      <RNText style={styles.detailDots} numberOfLines={1} ellipsizeMode="clip">{LEADER_DOTS}</RNText>
      <RNText style={styles.detailValue}>{value}</RNText>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { backgroundColor: '#fff' },
  // The fixed rail. Opaque and edged: the edge is what the plot is read from, and the day
  // dividers and ribbons run right up to it.
  legend: {
    position: 'absolute', left: 0, top: 0, bottom: 0, width: LEGEND_W,
    backgroundColor: '#fff',
  },
  legendEdge: {
    position: 'absolute', right: 0, top: 0, bottom: 0,
    width: StyleSheet.hairlineWidth, backgroundColor: C.divider,
  },
  legendSection: { position: 'absolute', left: 0, right: 0, backgroundColor: C.section },
  legendIcons: {
    position: 'absolute', left: 0, right: 0,
    flexDirection: 'row', justifyContent: 'center', alignItems: 'center', columnGap: 2,
  },
  // Icon fonts carry their own line box, so the clock is placed by its box rather than centered
  // by a flex row like the pair above.
  legendClock: { position: 'absolute', left: 0, right: 0, textAlign: 'center' },
  legendMarks: { position: 'absolute', left: 0, width: LEGEND_W, height: LEGEND_ICON_H },
  // Centered in the rail: the tokens run from two characters to six, and against the plot edge
  // the short ones read as a ragged margin rather than as a column.
  legendUnit: {
    position: 'absolute', left: 0, right: 0,
    textAlign: 'center',
    fontSize: 10, lineHeight: LEGEND_LINE_H, fontWeight: '600', color: C.unit,
  },
  legendLevel: {
    position: 'absolute', left: 0, right: 0,
    textAlign: 'center',
    fontSize: 9, lineHeight: LEGEND_LEVEL_H, color: C.unit,
  },
  sectionOverlay: { position: 'absolute', left: 0, right: 0, top: 0, bottom: 0 },
  sectionLabel: {
    position: 'absolute', left: 12, right: 0,
    fontSize: 10.5, lineHeight: LEGEND_LINE_H, fontWeight: '700', color: C.sectionText,
  },
  overviewStrip: {
    backgroundColor: SC.bg,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: '#000',
  },
  // The viewport window brackets the graph bands only — the weekday/date rows read as a fixed
  // calendar above it, so boxing them in moved with the scroll for no reason. The summary glyph and
  // high do fall inside it, since they sit on the temperature graph rather than above it.
  overviewWindowFill: {
    position: 'absolute',
    top: STRIP_HEAD_H,
    height: STRIP_GRAPH_H,
    borderTopWidth: 1.5,
    borderBottomWidth: 1.5,
    borderColor: SC.window,
    backgroundColor: 'rgba(255,255,255,0.10)',
  },
  overviewWindowEdge: {
    position: 'absolute',
    top: STRIP_HEAD_H,
    height: STRIP_GRAPH_H,
    width: 1.5,
    backgroundColor: SC.window,
  },
  highlightClip: { position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, overflow: 'hidden' },
  // Starts below the 31px day-label band (same boundary the night shading uses).
  highlightBox: { position: 'absolute', top: 31, width: CELL_W, borderWidth: 1.5, borderColor: 'rgba(255,59,48,0.5)' },
  // `left` is set per selection — see the selection overlay in ModelCanvas.
  cloudReadout: { position: 'absolute', top: 0, bottom: 0, width: CELL_W },
  cloudReadoutText: {
    position: 'absolute', left: 0, width: CELL_W, textAlign: 'center',
    fontSize: 12, fontWeight: '600', color: C.label,
  },
  detailPanel: {
    backgroundColor: '#fff',
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: '#d1d1d6',
    paddingHorizontal: 14,
    paddingTop: 10,
    paddingBottom: 14,
  },
  detailHeader: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  detailTime: { fontSize: 15, fontWeight: '600', color: C.label, flexShrink: 1 },
  detailClose: { fontSize: 17, color: C.sectionText, paddingLeft: 14, paddingVertical: 2 },
  detailModelChip: { alignSelf: 'flex-start', borderRadius: 4, paddingHorizontal: 6, paddingVertical: 2, marginTop: 4 },
  detailModelText: { color: '#fff', fontSize: 11, fontWeight: '600' },
  detailSummary: { flexDirection: 'row', alignItems: 'center', marginTop: 8, marginBottom: 4 },
  detailGlyphWrap: { width: 48, height: 48, borderRadius: 8, overflow: 'hidden' },
  detailGlyphLayer: { position: 'absolute', top: 0, left: 0 },
  detailGlyphHidden: { opacity: 0 },
  detailCodeName: { fontSize: 14, fontWeight: '600', color: C.label, marginLeft: 10, flexShrink: 1 },
  detailDivider: {
    height: StyleSheet.hairlineWidth,
    backgroundColor: '#e5e5ea',
    marginTop: 10,
    marginBottom: 6,
  },
  detailRow: { flexDirection: 'row', alignItems: 'baseline', paddingVertical: 4 },
  detailLabel: { fontSize: 13, color: C.sectionText },
  detailDots: { flex: 1, marginHorizontal: 6, fontSize: 13, letterSpacing: 2, color: C.nil },
  detailValue: { fontSize: 13, fontWeight: '600', color: C.label },
  stickyDayRow: { position: 'absolute', top: 0, left: 0, right: 0, height: 31, overflow: 'hidden' },
  stickyDayText: { position: 'absolute', top: 4, color: C.date, fontSize: 14, fontWeight: '600', lineHeight: 24 },
  // Clipped to the band row so a label can never ride up into the row above it. Color comes per
  // label, from the band it sits on.
  stickyModelRow: { position: 'absolute', left: 0, right: 0, overflow: 'hidden' },
  stickyModelText: { position: 'absolute', top: 0, fontSize: 11, fontWeight: '600', lineHeight: ROW_H.MODEL },
  // The pollutant label sits ON its run's dotted rule, so it needs a plate to cut the dashes
  // where the text is. The row is white, so the plate is invisible and does only that job.
  stickyDominantText: {
    lineHeight: ROW_H.WIND,
    color: '#1c1c1e', backgroundColor: '#ffffff',
  },
  // The pinned date header: an opaque plate the height of the drawn one, riding the page scroll.
  // White like the canvas ground — over arbitrary rows a plain plate reads as the floating header
  // it is — with a hairline for the bottom edge it otherwise wouldn't have.
  pinnedHeader: {
    position: 'absolute', top: 0, left: 0, right: 0, height: ROW_H.DATE,
    backgroundColor: '#fff',
    borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: C.divider,
  },
  // The floating strip must draw over the rows that slide beneath it; its siblings render later
  // and would otherwise paint on top. The plate never overlaps it — the assembly is contiguous.
  stripFloat: { zIndex: 1 },
  // The scene's slice of the plate, inset past the rail and clipped like the scroll view it
  // shadows, so labels vanish at the rail edge rather than sliding over it.
  pinnedHeaderScene: { position: 'absolute', top: 0, bottom: 0, left: LEGEND_W, right: 0, overflow: 'hidden' },
  pinnedHeaderRail: { position: 'absolute', top: 0, bottom: 0, left: 0, width: LEGEND_W, backgroundColor: '#fff' },
  // Content-wide, translated by the block's own horizontal scroll — the native mirror of the
  // hour row the canvas draws.
  pinnedHourStrip: { position: 'absolute', top: 0, bottom: 0, left: 0 },
  // Mirrors the canvas's date-row rule: a 1px line centered on y=31 in the grid's ink.
  pinnedDayRule: { position: 'absolute', left: 0, right: 0, top: 30.5, height: 1, backgroundColor: C.grid },
  // lineHeight 16 with its top at HOUR_LABEL_Y − 8 centers the text on the canvas's hour line.
  pinnedHourText: {
    position: 'absolute', width: CELL_W, textAlign: 'center',
    top: HOUR_LABEL_Y - 8, fontSize: 12, lineHeight: 16, color: C.hour,
  },
  pinnedHourSuffix: { fontSize: 9.5 },
  modelHeaderBar: { paddingHorizontal: 14, paddingVertical: 7 },
  modelHeaderText: { color: '#fff', fontSize: 13, fontWeight: '600' },
  sep: { height: 10, backgroundColor: '#f2f2f7' },
});
