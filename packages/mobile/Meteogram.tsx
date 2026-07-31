import { memo, useCallback, useEffect, useMemo, useRef, useState, type ReactNode, type RefObject } from 'react';
import { Animated, View, Text as RNText, StyleSheet, FlatList, PanResponder, Pressable, useWindowDimensions } from 'react-native';
import {
  Canvas, DashPathEffect, Group, Paint, Rect, RoundedRect, Circle, Line, Path, Text,
  LinearGradient, Skia, vec, matchFont, type SkFont,
} from '@shopify/react-native-skia';
import {
  CARDINALS, RAIN_MAX_MM, modelsFromMask, startDatetime,
  type ForecastMessage, type Period,
} from '@weather/protocol';
import type { TimeFormat, Units } from './settings';
import { precipMark, weatherGlyph, wmoName, type MoonPhase, type Prim } from './weatherGlyph';

// ── Layout constants ───────────────────────────────────────────────────────
// The row-label column lives inside the drawing and scrolls horizontally with the
// data. Units are folded into the labels.

const NAME_W = 96;
const CELL_W = 38;
// The weather glyphs have fixed natural geometry, extending up to ±26.5px around their center
// (widest: partly-cloudy and shower codes). They are shrunk into their column by this factor;
// keep GLYPH_SCALE ≤ CELL_W / 53 so neighboring columns don't overlap.
const GLYPH_SCALE = 0.7;
// Clip bound for a glyph in its own (unscaled) coordinates, covering the widest glyph.
const GLYPH_NATURAL_W = 56;
// A Canvas is backed by a CAMetalLayer whose drawable size is measured in physical
// pixels. A single canvas spanning a long hourly forecast can exceed Metal's maximum
// texture width on Retina devices and abort the entire process. Keep each drawable
// narrow and let FlatList virtualize the off-screen tiles. Wider tiles mean fewer seams
// to paint mid-scroll (smoother) while staying well under the texture limit (16×38×3px).
const CANVAS_TILE_W = CELL_W * 16;

const ROW_H = {
  DATE: 58,
  SECTION: 22,
  CLOUD: 58,
  TEMP: 52,
  SNOW: 50,
  DATA: 42,
  // The freezing level is a graph rather than a bare number, so it needs room for the isotherm to
  // move in under its band of column labels.
  FREEZE: 66,
  // Wind speeds are a single short number on a colored ground, so they need less room than the
  // other data rows — and there are up to five of them stacked (surface, gust, three upper levels).
  WIND: 32,
  DIR: 30,
} as const;

// Accumulation areas use the codec's sqrt companding on a fixed full-scale (RAIN_MAX_MM of
// liquid equivalent) instead of normalizing to the forecast's own maximum: a trace 0.5 mm
// period draws a small-but-visible bump rather than filling the row just because nothing
// heavier is in the window.
const accumFrac = (mmEq: number) => Math.min(1, Math.sqrt(Math.max(0, mmEq) / RAIN_MAX_MM));

// The freezing-level row plots the 0°C isotherm over the full row height, with its per-column
// altitudes centered on the row — the curve passes behind them. Like the temperature area, the plot
// is normalized to this forecast's own range — but floored at a minimum span, since a level that
// holds within a couple of hundred metres should read as flat rather than as amplified noise, and
// with headroom so the curve doesn't ride either edge of the row.
const FREEZE_PAD = 4;
const FREEZE_MIN_SPAN_M = 700;
const FREEZE_HEADROOM = 1.2;

// Overview-strip band heights, stacked top to bottom: a per-day header (weekday, day of month,
// summary glyph, daily high) over the mini temperature / precip / wind graphs.
// Each header band is taller than its text so the rows breathe; the row tops are derived here so
// the draw sites don't repeat the arithmetic.
const STRIP_PAD_T = 8;
const STRIP_DAY_H = 15;
const STRIP_DATE_H = 18;
const STRIP_GLYPH_H = 20;
const STRIP_TVAL_H = 14;
const STRIP_DATE_Y = STRIP_PAD_T + STRIP_DAY_H;
const STRIP_GLYPH_Y = STRIP_DATE_Y + STRIP_DATE_H;
const STRIP_HEAD_H = STRIP_GLYPH_Y + STRIP_GLYPH_H + STRIP_TVAL_H;
const STRIP_SIL_H = 28;
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
// The graph bands below the header — the span the viewport window brackets.
const STRIP_GRAPH_H = STRIP_SIL_H + STRIP_PRECIP_H + STRIP_WIND_H + STRIP_RES_H;
const STRIP_H = STRIP_HEAD_H + STRIP_GRAPH_H;

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

// ── Weather code classification ──────────────────────────────────────────--

const SNOW_CODES = new Set([56, 57, 66, 67, 71, 73, 75, 77, 85, 86]);
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

function windAlpha(mph: number): number {
  const t = Math.min(1, Math.max(0, (mph - WIND_FADE_LO) / (WIND_FADE_HI - WIND_FADE_LO)));
  return Number((t * t * (3 - 2 * t)).toFixed(3)); // smoothstep, so both ends ease
}

function windColor(kph: number): string {
  const mph = kph / 1.60934;
  return rgb(rampRgb(WIND_STOPS, mph), windAlpha(mph));
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

function fmtTemp(c: number | undefined, u: Units): string {
  if (c == null) return '';
  return u === 'imperial' ? `${Math.round((c * 9) / 5 + 32)}°` : `${Math.round(c)}°`;
}
function fmtSnow(cm: number, u: Units): string {
  if (u === 'imperial') {
    const inches = cm / 2.54;
    return inches >= 0.1 ? `${inches.toFixed(inches < 1 ? 1 : 0)}IN` : '';
  }
  return cm >= 0.5 ? `${Math.round(cm)}CM` : '';
}
function fmtRain(mm: number, u: Units): string {
  if (u === 'imperial') {
    const inches = mm / 25.4;
    return inches >= 0.01 ? `${inches.toFixed(2)}IN` : '';
  }
  if (mm < 0.5) return '';
  return `${mm < 10 ? mm.toFixed(1) : Math.round(mm)}MM`;
}
// Column labels are abbreviated to thousands ("14k", "13.5k") — a grouped "14,000" outgrows the
// cell. Metric already fits at 100 m granularity.
function fmtFreeze(m: number | undefined, u: Units): string {
  if (m == null) return '';
  if (u === 'imperial') {
    const ft = Math.round((m * 3.28084) / 500) * 500;
    return ft < 1000 ? `${ft}` : `${(ft / 1000).toFixed(ft % 1000 === 0 ? 0 : 1)}k`;
  }
  return `${Math.round(m / 100) * 100}`;
}
function fmtWind(kph: number | undefined, u: Units): string {
  if (kph == null) return '';
  return u === 'imperial' ? `${Math.round(kph / 1.60934)}` : `${Math.round(kph)}`;
}

// Detail-panel variants: unit-suffixed and never blanked — the panel must show the trace
// amounts the column labels drop below their display thresholds.
function fmtRainFull(mm: number, u: Units): string {
  if (u === 'imperial') {
    if (mm <= 0) return '0 in';
    const inches = mm / 25.4;
    return inches < 0.01 ? '<0.01 in' : `${inches.toFixed(2)} in`;
  }
  if (mm <= 0) return '0 mm';
  return `${mm < 10 ? mm.toFixed(1) : Math.round(mm)} mm`;
}
function fmtSnowFull(cm: number, u: Units): string {
  if (u === 'imperial') {
    if (cm <= 0) return '0 in';
    const inches = cm / 2.54;
    return inches < 0.1 ? '<0.1 in' : `${inches.toFixed(1)} in`;
  }
  if (cm <= 0) return '0 cm';
  return `${cm < 10 ? cm.toFixed(1) : Math.round(cm)} cm`;
}
function fmtFreezeFull(m: number | undefined, u: Units): string {
  if (m == null) return '—';
  const v = u === 'imperial' ? Math.round((m * 3.28084) / 500) * 500 : Math.round(m / 100) * 100;
  return `${v.toLocaleString()} ${freezeUnit(u)}`;
}
function fmtWindFull(kph: number | undefined, dir: number | undefined, u: Units): string {
  if (kph == null) return '—';
  const cardinal = dir != null ? CARDINALS[dir] : undefined;
  const dirText = cardinal ? ` ${ARROWS[cardinal] ?? ''} ${cardinal}` : '';
  return `${fmtWind(kph, u)} ${windUnit(u)}${dirText}`;
}

function tempUnit(u: Units) { return u === 'imperial' ? '°F' : '°C'; }
function freezeUnit(u: Units) { return u === 'imperial' ? 'ft' : 'm'; }
function windUnit(u: Units) { return u === 'imperial' ? 'mph' : 'kph'; }

const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
function dayLabel(d: Date): string { return `${DAYS[d.getDay()]} ${d.getDate()}`; }

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
  return `${DAYS[d.getDay()]} ${MONTHS[d.getMonth()]} ${ordinal(d.getDate())}`;
}

// A day's header has only that day's columns to sit in, and the first and last days of a forecast
// are usually partial — a day that starts at 10pm gets two hourly columns, 76px, where "Wednesday
// 24" needs around 90. So the label steps down through shorter forms until one fits: the weekday
// abbreviates, then drops out entirely. The date is what identifies the column either way, and the
// weekday of a partial day is readable from the full day beside it.
function fitDayLabel(d: Date, available: number, font: SkFont): string {
  const forms = [dayLabel(d), `${DAYS[d.getDay()].slice(0, 3)} ${d.getDate()}`, `${d.getDate()}`];
  return forms.find((f) => font.getTextWidth(f) <= available) ?? forms[forms.length - 1];
}
// The hour splits into the number and its meridiem so the two can be drawn at different sizes.
function hourParts(d: Date, step: number, timeFormat: TimeFormat): { num: string; suffix: string } {
  if (step >= 24) return { num: '', suffix: '' };
  const hour = d.getHours();
  if (timeFormat === '24h') return { num: `${hour}`, suffix: '' };
  return { num: `${hour % 12 || 12}`, suffix: hour < 12 ? 'AM' : 'PM' };
}
function hourLabel(d: Date, step: number, timeFormat: TimeFormat): string {
  const { num, suffix } = hourParts(d, step, timeFormat);
  return num + suffix;
}

// Solar altitude using the standard low-precision solar-position equations. The apparent
// sunrise/sunset threshold is -0.833° to account for refraction and the sun's visible radius.
function isNight(time: number, lat: number, lon: number): boolean {
  const rad = Math.PI / 180;
  const days = time / 86400000 + 2440587.5 - 2451545;
  const meanLongitude = (280.46 + 0.9856474 * days) * rad;
  const anomaly = (357.528 + 0.9856003 * days) * rad;
  const eclipticLongitude = meanLongitude + (1.915 * Math.sin(anomaly) + 0.02 * Math.sin(2 * anomaly)) * rad;
  const obliquity = (23.439 - 0.0000004 * days) * rad;
  const rightAscension = Math.atan2(Math.cos(obliquity) * Math.sin(eclipticLongitude), Math.cos(eclipticLongitude));
  const declination = Math.asin(Math.sin(obliquity) * Math.sin(eclipticLongitude));
  const siderealTime = (280.46061837 + 360.98564736629 * days + lon) * rad;
  const hourAngle = siderealTime - rightAscension;
  const latitude = lat * rad;
  const altitude = Math.asin(
    Math.sin(latitude) * Math.sin(declination)
      + Math.cos(latitude) * Math.cos(declination) * Math.cos(hourAngle),
  );
  return altitude < -0.833 * rad;
}

// Eight-phase approximation anchored to the 2000-01-06 new moon. This is precise enough for the
// compact phase glyph while avoiding another astronomy dependency in the mobile bundle.
function moonPhaseAt(time: number): MoonPhase {
  const synodicMonthMs = 29.530588853 * 86400000;
  const knownNewMoon = Date.UTC(2000, 0, 6, 18, 14);
  const cycle = ((time - knownNewMoon) % synodicMonthMs + synodicMonthMs) % synodicMonthMs;
  const phases: MoonPhase[] = [
    'new', 'waxing-crescent', 'first-quarter', 'waxing-gibbous',
    'full', 'waning-gibbous', 'last-quarter', 'waning-crescent',
  ];
  return phases[Math.floor(cycle / synodicMonthMs * 8 + 0.5) % phases.length];
}

// Night portions of an arbitrary forecast period, as 0–1 fractions. A short scan locates each
// sunrise/sunset, then binary search places the boundary to within roughly one second.
function nightSegments(start: number, end: number, lat: number, lon: number): [number, number][] {
  const crossings: number[] = [];
  const scanStep = 30 * 60000;
  let previousTime = start;
  let previousNight = isNight(start, lat, lon);
  for (let time = Math.min(start + scanStep, end); previousTime < end; time = Math.min(time + scanStep, end)) {
    const night = isNight(time, lat, lon);
    if (night !== previousNight) {
      let low = previousTime;
      let high = time;
      for (let i = 0; i < 16; i++) {
        const mid = (low + high) / 2;
        if (isNight(mid, lat, lon) === previousNight) low = mid;
        else high = mid;
      }
      crossings.push((low + high) / 2);
    }
    previousTime = time;
    previousNight = night;
  }

  const boundaries = [start, ...crossings, end];
  const segments: [number, number][] = [];
  for (let i = 0; i < boundaries.length - 1; i++) {
    const a = boundaries[i];
    const b = boundaries[i + 1];
    if (isNight((a + b) / 2, lat, lon)) segments.push([(a - start) / (end - start), (b - start) / (end - start)]);
  }
  return segments;
}

// Contiguous columns that fall on the same local calendar day.
interface DayGroup { start: number; end: number; date: Date }
function buildDayGroups(dates: Date[]): DayGroup[] {
  const groups: DayGroup[] = [];
  dates.forEach((d, i) => {
    const previous = groups[groups.length - 1];
    if (!previous || previous.date.toDateString() !== d.toDateString()) {
      groups.push({ start: i, end: i + 1, date: d });
    } else {
      previous.end = i + 1;
    }
  });
  return groups;
}

function pressureLabel(level: 500 | 600 | 700): string {
  return `${level} hPa`;
}

// ── Row model ──────────────────────────────────────────────────────────────

type RowKind =
  | 'clouds' | 'temp' | 'accumulation' | 'freeze' | 'wind-sfc' | 'wind-gust' | 'wind-dir'
  | 'cloud-high' | 'cloud-mid' | 'cloud-low'
  | 'wind-500' | 'wind-600' | 'wind-700' | 'section';

interface Row {
  kind: RowKind;
  height: number;
  label: string;
}

function buildRows(periods: Period[], u: Units): Row[] {
  const rows: Row[] = [];
  const has = (fn: (p: Period) => unknown) => periods.some((p) => fn(p) != null);
  const tU = tempUnit(u), frU = freezeUnit(u), wU = windUnit(u);

  rows.push({ kind: 'clouds', height: ROW_H.CLOUD, label: '' });

  const hasSurface =
    has((p) => p.precip) || has((p) => p.temp_c) ||
    has((p) => p.snow_cm) || has((p) => p.rain_mm) ||
    has((p) => p.wind_sfc_kph) || has((p) => p.wind_gust_kph);
  if (hasSurface) {
    if (has((p) => p.temp_c))
      rows.push({ kind: 'temp', height: ROW_H.TEMP, label: `Temp ${tU}` });
    if (has((p) => p.precip) || has((p) => p.snow_cm) || has((p) => p.rain_mm))
      rows.push({ kind: 'accumulation', height: ROW_H.SNOW, label: 'Precip' });
    if (has((p) => p.wind_sfc_kph)) rows.push({ kind: 'wind-sfc', height: ROW_H.WIND, label: `Wind ${wU}` });
    if (has((p) => p.wind_gust_kph)) rows.push({ kind: 'wind-gust', height: ROW_H.WIND, label: `Gust ${wU}` });
    if (has((p) => p.wind_sfc_dir)) rows.push({ kind: 'wind-dir', height: ROW_H.DIR, label: 'Dir' });
  }

  // Freezing level is an altitude, not a surface reading — it heads the upper-air sections with
  // its unit in the header, so the single row below it needs no label of its own.
  if (has((p) => p.freeze_m)) {
    rows.push({ kind: 'section', height: ROW_H.SECTION, label: `Freezing level (${frU})` });
    rows.push({ kind: 'freeze', height: ROW_H.FREEZE, label: '' });
  }

  const hasCloud = has((p) => p.cloud_high) || has((p) => p.cloud_mid) || has((p) => p.cloud_low);
  if (hasCloud) {
    rows.push({ kind: 'section', height: ROW_H.SECTION, label: 'Cloud cover' });
    if (has((p) => p.cloud_high)) rows.push({ kind: 'cloud-high', height: ROW_H.DATA, label: 'High' });
    if (has((p) => p.cloud_mid)) rows.push({ kind: 'cloud-mid', height: ROW_H.DATA, label: 'Mid' });
    if (has((p) => p.cloud_low)) rows.push({ kind: 'cloud-low', height: ROW_H.DATA, label: 'Low' });
  }

  const hasUpper = has((p) => p.wind_500_kph) || has((p) => p.wind_600_kph) || has((p) => p.wind_700_kph);
  if (hasUpper) {
    rows.push({ kind: 'section', height: ROW_H.SECTION, label: `Pressure level winds (${wU})` });
    if (has((p) => p.wind_500_kph)) rows.push({ kind: 'wind-500', height: ROW_H.WIND, label: pressureLabel(500) });
    if (has((p) => p.wind_600_kph)) rows.push({ kind: 'wind-600', height: ROW_H.WIND, label: pressureLabel(600) });
    if (has((p) => p.wind_700_kph)) rows.push({ kind: 'wind-700', height: ROW_H.WIND, label: pressureLabel(700) });
  }

  return rows;
}

// ── Drawing helpers ────────────────────────────────────────────────────────

// Baseline offset to vertically center text of a given size at a y coordinate.
function baseline(cy: number, size: number) { return cy + size * 0.35; }

interface Fonts {
  label: SkFont; sub: SkFont; data: SkFont; small: SkFont; bold: SkFont; date: SkFont;
  hour: SkFont; hourSuffix: SkFont;
  // The strip's header text is light-weight — at header size a thin face keeps the day columns
  // legible without competing with the glyphs below them.
  strip: SkFont; stripSub: SkFont;
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
// width regardless of how many periods they hold. Each day column shows its weekday and date, a
// summary weather glyph, and its high over a mini temperature silhouette, a band of drop and
// flake marks stamped across the wet stretches, a Beaufort wind ribbon, and a band of one block
// per forecast period showing where the fill's resolution changes. A viewport window tracks the
// meteogram's scroll on the native driver, and touching the strip scrubs the meteogram to that
// position.
// Memoized for the same reason as CanvasTile: every prop is identity-stable while a selection
// changes, and an unchecked re-render rebuilds the strip's elements and repaints its canvas.
const OverviewStrip = memo(function OverviewStrip({ periods, dates, steps, units, now, width, flatListRef, scrollX, fonts }: {
  periods: Period[]; dates: Date[]; steps: number[]; units: Units; now: number;
  width: number; flatListRef: RefObject<FlatList<Tile> | null>; scrollX: Animated.Value; fonts: Fonts;
}) {
  const n = periods.length;
  const W = width;
  const dayGroups = buildDayGroups(dates);

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
  // Hours from the first day's local midnight to the start of the forecast. Not part of the axis —
  // only the precip grid needs it, to keep its segments on wall-clock boundaries.
  const firstMidnight = new Date(dates[0]);
  firstMidnight.setHours(0, 0, 0, 0);
  const originHours = (dates[0].getTime() - firstMidnight.getTime()) / 3600000;
  const slot = (i: number) => {
    const left = timeX(cum[i]);
    const right = timeX(cum[i + 1]);
    return { left, center: (left + right) / 2, right };
  };

  const graphTop = STRIP_HEAD_H;
  const els: ReactNode[] = [];

  // Temperature silhouette.
  const temps: number[] = [];
  periods.forEach((p) => { if (p.temp_c != null) temps.push(p.temp_c); });
  const tMin = temps.length ? Math.min(...temps) - 1 : 0;
  const tMax = temps.length ? Math.max(...temps) + 1 : 1;
  const plottedTemps = periods.map((p) => p.temp_c);
  const silTop = graphTop + 2;
  const silBottom = graphTop + STRIP_SIL_H;
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
        <LinearGradient start={vec(0, silTop)} end={vec(0, silBottom)}
          colors={[tempColor(tMax, 0.8), tempColor((tMax + tMin) / 2, 0.8), tempColor(tMin, 0.8)]}
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

  // Per-day header: weekday, day of month, summary glyph, daily high. The day columns are read from
  // the header text alone — no separators, so nothing cuts across the graphs below.
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
    els.push(centerText(`swk${d}`, DAYS[g.date.getDay()].slice(0, 3).toUpperCase(), cx, STRIP_PAD_T + STRIP_DAY_H / 2, fonts.stripSub, SC.label));
    els.push(centerText(`sdm${d}`, String(g.date.getDate()), cx, STRIP_DATE_Y + STRIP_DATE_H / 2, fonts.strip, SC.label));
    if (hi != null) {
      els.push(centerText(`shi${d}`, fmtTemp(hi, units), cx, STRIP_HEAD_H - STRIP_TVAL_H / 2, fonts.strip, SC.label));
    }
  });

  // Current-time marker across the graph bands.
  const cur = dates.findIndex((date, i) => now >= date.getTime() && now < date.getTime() + steps[i] * 3600000);
  if (cur >= 0) {
    const s = slot(cur);
    const frac = (now - dates[cur].getTime()) / (steps[cur] * 3600000);
    const mx = s.left + frac * (s.right - s.left);
    els.push(<Line key="strip-now" p1={vec(mx, graphTop)} p2={vec(mx, STRIP_H)} color="rgba(255,69,58,0.85)" strokeWidth={1} />);
  }

  const contentW = NAME_W + n * CELL_W;
  const maxOffset = Math.max(0, contentW - W);

  // Scrub: map the touched time position back to a fractional period index, then center the
  // viewport on it.
  const scrub = (xMini: number) => {
    if (maxOffset <= 0) return;
    const clampedX = Math.max(0, Math.min(W, xMini));
    const hours = clampedX / pxPerHour;
    let i = 0;
    while (i < n - 1 && cum[i + 1] <= hours) i++;
    const t = i + (hours - cum[i]) / steps[i];
    const offset = Math.max(0, Math.min(maxOffset, NAME_W + t * CELL_W - W / 2));
    flatListRef.current?.scrollToOffset({ offset, animated: false });
  };
  const pan = useMemo(() => PanResponder.create({
    onStartShouldSetPanResponder: () => true,
    onMoveShouldSetPanResponder: () => true,
    onPanResponderTerminationRequest: () => false,
    onPanResponderGrant: (e) => scrub(e.nativeEvent.locationX),
    onPanResponderMove: (e) => scrub(e.nativeEvent.locationX),
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }), [steps, maxOffset, W]);

  // The main canvas scrolls by equal-width period columns while the strip is linear in time, so
  // map BOTH viewport edges through the resolution boundaries — piecewise-linear, on the native
  // driver — rather than with a single affine factor. Where the period span changes, the two edges
  // move at different rates, so the window resizes as it crosses resolution changes, not just
  // translates.
  const resBoundaries = [0];
  for (let i = 1; i < n; i++) if (steps[i] !== steps[i - 1]) resBoundaries.push(i);
  resBoundaries.push(n);
  const inputRange = resBoundaries.map((i) => NAME_W + i * CELL_W);
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
    if (x - W > 0 && x - W < maxOffset) knots.add(x - W);
  }
  const offsets = [...knots].sort((a, b) => a - b);
  const lefts = offsets.map((o) => stripXOf(o));
  const rights = offsets.map((o) => stripXOf(o + W));
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
        <Canvas style={{ width: W, height: STRIP_H }} pointerEvents="none">{els}</Canvas>
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

// Full Skia scene for one model. Pure, and called through useMemo: overlay-only state like the
// selected column must not rebuild the elements, since any rebuild repaints every mounted tile.
function buildScene({ periods, rows, dates, steps, units, timeFormat, now, lat, lon, fonts, dayGroups }: {
  periods: Period[]; rows: Row[]; dates: Date[]; steps: number[]; units: Units; timeFormat: TimeFormat;
  now: number; lat: number; lon: number; fonts: Fonts; dayGroups: DayGroup[];
}): ReactNode[] {
  const n = periods.length;
  const width = NAME_W + n * CELL_W;
  const totalH = ROW_H.DATE + rows.reduce((s, r) => s + r.height, 0);
  const colLeft = (i: number) => NAME_W + i * CELL_W;
  const colCenter = (i: number) => NAME_W + i * CELL_W + CELL_W / 2;
  const els: ReactNode[] = [];
  els.push(<Rect key="key-column-bg" x={0} y={0} width={NAME_W} height={totalH} color={C.keyBg} />);

  // 1. Location-aware astronomical night shading. Partial rectangles place sunrise and sunset
  // within a column rather than rounding them to the forecast period boundary. The shading stops
  // at the first row that encodes its value as a fill — wind ribbons and cloud-cover alpha — since
  // a tinted backdrop would make identical speeds or percentages look different by night than by
  // day. Everything above reads as text or glyphs and is unharmed by the tint.
  const TINTABLE_STOP = new Set<RowKind>([
    'wind-sfc', 'wind-gust', 'wind-dir', 'freeze', 'cloud-high', 'cloud-mid', 'cloud-low',
    'wind-500', 'wind-600', 'wind-700',
  ]);
  const nightBottom = (() => {
    let y = ROW_H.DATE;
    let headerTop: number | undefined; // top of the section label immediately above this row
    for (const row of rows) {
      if (TINTABLE_STOP.has(row.kind)) return headerTop ?? y;
      headerTop = row.kind === 'section' ? y : undefined;
      y += row.height;
    }
    return totalH;
  })();
  dates.forEach((d, i) => {
    const start = d.getTime();
    const end = start + steps[i] * 3600000;
    nightSegments(start, end, lat, lon).forEach(([from, to], segment) => {
      els.push(<Rect key={`night${i}-${segment}`} x={colLeft(i) + from * CELL_W} y={31} width={(to - from) * CELL_W} height={nightBottom - 31} color={C.night} />);
    });
  });
  const headerInsertIndex = els.length;

  // 2. Date header. Hours occupy their own row. Each day label sticks to the visible left
  // edge while its columns are being scrolled, then yields to the following day.
  dates.forEach((d, i) => {
    els.push(centerHour(`hour${i}`, hourParts(d, steps[i], timeFormat), colCenter(i), 44, fonts.hour, fonts.hourSuffix, C.hour));
  });
  els.push(<Line key="date-row-rule" p1={vec(NAME_W, 31)} p2={vec(width, 31)} color={C.grid} strokeWidth={1} />);

  // Temperature domain across all periods.
  const temps: number[] = [];
  periods.forEach((p) => { if (p.temp_c != null) temps.push(p.temp_c); });
  const tMin = temps.length ? Math.min(...temps) - 1 : 0;
  const tMax = temps.length ? Math.max(...temps) + 1 : 1;

  // Temperature is a background area behind the time, weather-code, and temperature rows. Its
  // vertical shape is normalized to this forecast's range, while the gradient colors are chosen
  // from absolute temperatures and fade to white beneath the plotted range.
  let tempRowBottom = ROW_H.DATE;
  for (const row of rows) {
    tempRowBottom += row.height;
    if (row.kind === 'temp') break;
  }
  const plottedTemps = periods.map((p) => p.temp_c);
  if (temps.length && plottedTemps.some((temperature) => temperature != null)) {
    const plotTop = 39;
    const plotBottom = tempRowBottom - 18;
    const scaleTempY = (temperature: number) =>
      plotTop + ((tMax - temperature) / (tMax - tMin)) * (plotBottom - plotTop);
    const first = plottedTemps.find((temperature): temperature is number => temperature != null)!;
    const last = [...plottedTemps].reverse().find((temperature): temperature is number => temperature != null)!;
    const points = [
      { x: colLeft(0), y: scaleTempY(first) },
      ...plottedTemps.flatMap((temperature, i) => temperature == null ? [] : [{ x: colCenter(i), y: scaleTempY(temperature) }]),
      { x: colLeft(n), y: scaleTempY(last) },
    ];
    const area = Skia.Path.Make();
    smoothTo(area, points);
    area.lineTo(colLeft(n), tempRowBottom);
    area.lineTo(colLeft(0), tempRowBottom);
    area.close();
    const rangeEnd = Math.max(0, Math.min(1, (plotBottom - plotTop) / (tempRowBottom - plotTop)));
    els.splice(headerInsertIndex, 0,
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

  // Precipitation probability as a smooth 0–100% area behind its value labels.
  // Snow and rain share a stacked area. Snow is converted to liquid-equivalent depth at 10:1,
  // so 10 inches of snow plots at the same height as 1 inch of rain.
  const maxSnow = Math.max(0, ...periods.map((p) => p.snow_cm ?? 0));
  const maxRain = Math.max(0, ...periods.map((p) => p.rain_mm ?? 0));
  let accumulationTop: number | undefined;
  let accumulationBottom: number | undefined;
  let accumulationY = ROW_H.DATE;
  rows.forEach((row) => {
    if (row.kind === 'accumulation') {
      accumulationTop ??= accumulationY;
      accumulationBottom = accumulationY + row.height;
    }
    accumulationY += row.height;
  });
  const rainEquivalent = periods.map((period) => period.rain_mm ?? 0);
  // 1 cm snow / 10 = 1 mm liquid equivalent, so the numeric cm value already matches rain mm.
  const snowEquivalent = periods.map((period) => period.snow_cm ?? 0);
  const totalEquivalent = rainEquivalent.map((rain, i) => rain + snowEquivalent[i]);
  const maxEquivalent = Math.max(0, ...totalEquivalent);
  if (accumulationTop != null && accumulationBottom != null && maxEquivalent > 0) {
    const plotTop = accumulationTop + 4;
    const valueY = (value: number) => accumulationBottom! - accumFrac(value) * (accumulationBottom! - plotTop);
    const boundary = (values: number[]) => [
      { x: colLeft(0), y: valueY(values[0]) },
      ...values.map((value, i) => ({ x: colCenter(i), y: valueY(value) })),
      { x: colLeft(n), y: valueY(values[values.length - 1]) },
    ];
    const rainPoints = boundary(rainEquivalent);
    const totalPoints = boundary(totalEquivalent);
    const rainArea = Skia.Path.Make();
    smoothTo(rainArea, rainPoints);
    rainArea.lineTo(colLeft(n), accumulationBottom);
    rainArea.lineTo(colLeft(0), accumulationBottom);
    rainArea.close();
    const snowArea = Skia.Path.Make();
    smoothTo(snowArea, totalPoints);
    smoothTo(snowArea, rainPoints, true);
    snowArea.close();
    els.splice(headerInsertIndex, 0,
      <Group key="accumulation-area">
        <Path path={rainArea} color="#4b8fc8" />
        <Path path={snowArea} color="#c6e1f5" />
      </Group>,
    );
  }

  // Precipitation chance overlays the accumulation chart as a line with its own fixed 0–100%
  // scale. It intentionally has no fill or value labels.
  const precipValues = periods.map((period) => period.precip);
  if (accumulationTop != null && accumulationBottom != null && precipValues.some((value) => value != null)) {
    const plotTop = accumulationTop + 4;
    const first = precipValues.find((value): value is number => value != null)!;
    const last = [...precipValues].reverse().find((value): value is number => value != null)!;
    const precipY = (value: number) => accumulationBottom! - (value / 100) * (accumulationBottom! - plotTop);
    const points = [
      { x: colLeft(0), y: precipY(first) },
      ...precipValues.flatMap((value, i) => value == null ? [] : [{ x: colCenter(i), y: precipY(value) }]),
      { x: colLeft(n), y: precipY(last) },
    ];
    const line = Skia.Path.Make();
    smoothTo(line, points);
    els.push(
      <Path key="precip-line" path={line} style="stroke" strokeWidth={1} color="#245d91">
        <DashPathEffect intervals={[4, 3]} />
      </Path>,
    );
  }

  // Current time, positioned proportionally within its period. Run it through the date/time
  // header and visual weather rows down to precip, excluding wind and the sections below it.
  const markerRows = new Set<RowKind>(['clouds', 'temp', 'accumulation']);
  let markerTop: number | undefined;
  let markerBottom: number | undefined;
  let markerY = ROW_H.DATE;
  rows.forEach((row) => {
    if (markerRows.has(row.kind)) {
      markerTop ??= markerY;
      markerBottom = markerY + row.height;
    }
    markerY += row.height;
  });
  const currentPeriod = dates.findIndex((date, i) =>
    now >= date.getTime() && now < date.getTime() + steps[i] * 3600000,
  );
  if (currentPeriod >= 0 && markerTop != null && markerBottom != null) {
    const periodStart = dates[currentPeriod].getTime();
    const fraction = (now - periodStart) / (steps[currentPeriod] * 3600000);
    const x = colLeft(currentPeriod) + fraction * CELL_W;
    els.push(
      <Line
        key="current-time"
        p1={vec(x, 0)}
        p2={vec(x, markerBottom)}
        color="rgba(255,59,48,0.5)"
        strokeWidth={1}
      >
        <DashPathEffect intervals={[5, 4]} />
      </Line>,
    );
  }

  // Freezing-level domain, shared by the isotherm curve and the two washes either side of it. The
  // bottom is pinned to ground level once the level comes near it, so a freezing level at the
  // surface reads as one with no above-freezing air under it rather than as one floating a row's
  // worth of red above the ground.
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

  // 4. Rows.
  let y = ROW_H.DATE;
  rows.forEach((row, ri) => {
    const top = y;
    const mid = top + row.height / 2;
    y += row.height;

    if (row.kind === 'section') {
      els.push(<Rect key={`sec-bg${ri}`} x={0} y={top} width={width} height={row.height} color={C.section} />);
      els.push(<Text key={`sec-l${ri}`} x={12} y={baseline(mid, fonts.sub.getSize())} text={row.label.toUpperCase()} font={fonts.sub} color={C.sectionText} />);
      return;
    }

    // Row label (left column, scrolls with data).
    if (row.label) {
      els.push(<Text key={`lbl${ri}`} x={12} y={baseline(mid, fonts.label.getSize())} text={row.label} font={fonts.label} color={C.label} />);
    }

    switch (row.kind) {
      case 'clouds':
        periods.forEach((p, i) => {
          const midpoint = dates[i].getTime() + steps[i] * 1800000;
          const night = isNight(midpoint, lat, lon);
          els.push(
            <Group key={`clg${i}`} transform={[{ scale: GLYPH_SCALE }]} origin={vec(colCenter(i), mid)}>
              {cloudGlyph(
                `cl${i}`,
                colCenter(i),
                top,
                row.height,
                p.weathercode,
                night,
                moonPhaseAt(midpoint),
              )}
            </Group>,
          );
        });
        break;

      case 'temp': {
        periods.forEach((p, i) => {
          const cx = colCenter(i);
          if (p.temp_c != null) {
            els.push(centerText(`th${i}`, fmtTemp(p.temp_c, units), cx, top + 14, fonts.bold, '#1c1c1e'));
          }
        });
        break;
      }

      case 'accumulation':
        periods.forEach((p, i) => {
          const cm = p.snow_cm ?? 0;
          const mm = p.rain_mm ?? 0;
          const cx = colCenter(i);
          const snowText = cm > 0 && maxSnow > 0 ? fmtSnow(cm, units) : '';
          const rainText = mm > 0 && maxRain > 0 ? fmtRain(mm, units) : '';
          if (snowText && rainText) {
            const rainY = top + row.height - 10;
            els.push(centerText(`sv${i}`, snowText, cx, rainY - 18, fonts.small, '#4f82ae'));
            els.push(centerText(`rv${i}`, rainText, cx, rainY, fonts.small, '#245d91'));
          } else if (snowText) {
            els.push(centerText(`sv${i}`, snowText, cx, top + row.height - 10, fonts.small, '#4f82ae'));
          } else if (rainText) {
            els.push(centerText(`rv${i}`, rainText, cx, top + row.height - 10, fonts.small, '#245d91'));
          }
        });
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
          // The curve holds flat out to the run's outer edges, so a run reads as covering its
          // columns edge to edge rather than tapering in from their centers.
          const points = [
            { x: x0, y: freezeY(freezeValues[run[0]]!) },
            ...run.map((i) => ({ x: colCenter(i), y: freezeY(freezeValues[i]!) })),
            { x: x1, y: freezeY(freezeValues[run[run.length - 1]]!) },
          ];
          const cold = Skia.Path.Make();
          smoothTo(cold, points);
          cold.lineTo(x1, top);
          cold.lineTo(x0, top);
          cold.close();
          const warm = Skia.Path.Make();
          smoothTo(warm, points);
          warm.lineTo(x1, bottom);
          warm.lineTo(x0, bottom);
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
        periods.forEach((p, i) => {
          const txt = fmtFreeze(p.freeze_m, units);
          els.push(centerText(`fz${i}`, txt || '—', colCenter(i), mid, fonts.data,
            txt ? '#1c1c1e' : C.nil));
        });
        break;
      }

      case 'wind-sfc': case 'wind-gust': case 'wind-500': case 'wind-600': case 'wind-700': {
        const base = row.kind.replace('-', '_'); // wind-sfc → wind_sfc, wind-500 → wind_500
        const speedKey = `${base}_kph` as keyof Period;
        const dirKey = `${base}_dir` as keyof Period;
        // Surface direction lives in its own arrow row below the gust row; gusts have none.
        const inlineArrow = row.kind !== 'wind-sfc' && row.kind !== 'wind-gust';
        const speedAt = (i: number) => periods[i][speedKey] as number | undefined;
        valueRuns(n, (i) => speedAt(i) != null).forEach((run) => {
          els.push(windRibbon(
            `wbg${ri}-${run[0]}`, run,
            (i) => ({ left: colLeft(i), center: colCenter(i), right: colLeft(i) + CELL_W }),
            (i) => windColor(speedAt(i)!), top, row.height,
          ));
        });
        periods.forEach((p, i) => {
          const kph = speedAt(i);
          const cx = colCenter(i);
          if (kph == null) { els.push(centerText(`w${ri}-${i}`, '—', cx, mid, fonts.data, C.nil)); return; }
          const di = inlineArrow ? p[dirKey] as number | undefined : undefined;
          const arrow = di != null ? ARROWS[CARDINALS[di] ?? 'N'] ?? '' : '';
          // Rows carrying an inline arrow split the (now shorter) row evenly above and below center.
          els.push(centerText(`ws${ri}-${i}`, fmtWind(kph, units), cx, arrow ? mid - 8 : mid, fonts.bold, WIND_INK));
          els.push(centerText(`wa${ri}-${i}`, arrow, cx, mid + 8, fonts.data, WIND_INK));
        });
        break;
      }

      case 'wind-dir': {
        // Chunky solid arrow (shaft + triangular head), rotated per direction. Text glyphs are
        // too thin at this size. Drawn pointing east and rotated to where the wind blows toward:
        // dir index 0 (N wind) points south = +90° in screen coords.
        const L = 14, SHAFT = 4.5, HEAD_L = 6.5, HEAD_W = 10.5;
        const h = L / 2, s = SHAFT / 2, w = HEAD_W / 2;
        periods.forEach((p, i) => {
          const di = p.wind_sfc_dir;
          if (di == null) return;
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
        });
        break;
      }

      case 'cloud-high': case 'cloud-mid': case 'cloud-low': {
        const key = (row.kind === 'cloud-high' ? 'cloud_high'
          : row.kind === 'cloud-mid' ? 'cloud_mid' : 'cloud_low') as keyof Period;
        periods.forEach((p, i) => {
          const pct = p[key] as number | undefined;
          const cx = colCenter(i);
          if (pct == null) { els.push(centerText(`cc${ri}-${i}`, '—', cx, mid, fonts.data, C.nil)); return; }
          els.push(<Rect key={`ccbg${ri}-${i}`} x={colLeft(i)} y={top} width={CELL_W} height={row.height}
            color={`rgba(130,130,130,${(pct / 100).toFixed(2)})`} />);
        });
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
    dividerSpans.forEach(([from, to], s) => {
      els.push(<Line key={`day-divider${i}-${s}`} p1={vec(x, from)} p2={vec(x, to)} color={C.divider} strokeWidth={1} />);
    });
  });
  return els;
}

// A single canvas tile. Memoized so a ModelCanvas re-render (selection moving, panel state)
// repaints no tiles: a Skia Canvas repaints on any React commit that reaches it, and each paint
// is a full scene pass.
const CanvasTile = memo(function CanvasTile({ tile, els, totalH, onPress }: {
  tile: Tile; els: ReactNode[]; totalH: number; onPress: (locationX: number, tileOffset: number) => void;
}) {
  return (
    // Tap → column index. tile.offset is static per tile, so the tap position never needs
    // the native-driven scrollX; a drag hands the responder to the FlatList and cancels
    // the press.
    <Pressable onPress={(e) => onPress(e.nativeEvent.locationX, tile.offset)}>
      <Canvas style={{ width: tile.width, height: totalH }}>
        <Group transform={[{ translateX: -tile.offset }]}>{els}</Group>
      </Canvas>
    </Pressable>
  );
});

function ModelCanvas({ periods, rows, dates, steps, units, timeFormat, now, lat, lon, fonts, blockIndex, selected, onSelectColumn }: {
  // `steps` is each period's span in hours — the fill mixes resolutions within one message.
  // Columns stay equal-width; the span drives labels and shading.
  periods: Period[]; rows: Row[]; dates: Date[]; steps: number[]; units: Units; timeFormat: TimeFormat; now: number; lat: number; lon: number; fonts: Fonts;
  blockIndex: number; selected: number | null; onSelectColumn: (block: number, period: number) => void;
}) {
  const scrollX = useRef(new Animated.Value(0)).current;
  const flatListRef = useRef<FlatList<Tile>>(null);
  const screenW = useWindowDimensions().width;
  const n = periods.length;
  const width = NAME_W + n * CELL_W;
  const totalH = ROW_H.DATE + rows.reduce((s, r) => s + r.height, 0);
  // Memoized so tile objects keep their identity across re-renders: CanvasTile bails out by
  // reference equality, and a fresh array would repaint every mounted tile on each selection.
  const tiles = useMemo(() => Array.from({ length: Math.ceil(width / CANVAS_TILE_W) }, (_, index) => {
    const offset = index * CANVAS_TILE_W;
    return { offset, width: Math.min(CANVAS_TILE_W, width - offset) };
  }), [width]);
  const colLeft = (i: number) => NAME_W + i * CELL_W;

  const dayGroups = useMemo(() => buildDayGroups(dates), [dates]);
  const els = useMemo(
    () => buildScene({ periods, rows, dates, steps, units, timeFormat, now, lat, lon, fonts, dayGroups }),
    [periods, rows, dates, steps, units, timeFormat, now, lat, lon, fonts, dayGroups],
  );

  const onPressTile = useCallback((locationX: number, tileOffset: number) => {
    const x = tileOffset + locationX;
    if (x < NAME_W) return; // row-label gutter
    onSelectColumn(blockIndex, Math.min(periods.length - 1, Math.floor((x - NAME_W) / CELL_W)));
  }, [onSelectColumn, blockIndex, periods.length]);
  const renderTile = useCallback(({ item: tile }: { item: Tile }) => (
    <CanvasTile tile={tile} els={els} totalH={totalH} onPress={onPressTile} />
  ), [els, totalH, onPressTile]);

  // The highlight rides scrollX on the native driver. The animated graph is built once and the
  // selected column's edge pushed in with setValue: swapping in a fresh Animated.subtract per
  // selection re-attaches the native node, which doesn't recompute until the next scroll event —
  // the box would sit on the old column until the user nudges the list.
  const selectedLeft = useRef(new Animated.Value(0)).current;
  const highlightX = useRef(Animated.subtract(selectedLeft, scrollX)).current;
  useEffect(() => {
    if (selected != null) selectedLeft.setValue(NAME_W + selected * CELL_W);
  }, [selected, selectedLeft]);

  return (
    <View>
      <OverviewStrip periods={periods} dates={dates} steps={steps} units={units} now={now}
        width={screenW} flatListRef={flatListRef} scrollX={scrollX} fonts={fonts} />
      <View style={{ height: totalH }}>
      <Animated.FlatList
        ref={flatListRef}
        data={tiles}
        horizontal
        bounces={false}
        showsHorizontalScrollIndicator
        scrollEventThrottle={16}
        keyExtractor={(tile) => String(tile.offset)}
        // Render more tiles ahead of the viewport so a Skia tile mounts (an expensive full-scene
        // paint) before it scrolls into view rather than as it appears — reduces scroll hitching.
        initialNumToRender={2}
        maxToRenderPerBatch={3}
        windowSize={5}
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
              height: totalH - 31,
              transform: [{ translateX: highlightX }],
            }]}
          />
        </View>
      )}
      <View pointerEvents="none" style={styles.stickyDayRow}>
        {dayGroups.map((group, i) => {
          const start = colLeft(group.start);
          const end = colLeft(group.end);
          const label = fitDayLabel(group.date, end - start - 20, fonts.date);
          const textWidth = fonts.date.getTextWidth(label);
          const stickyEnd = end - textWidth - 20;
          const translateX = stickyEnd > start
            ? scrollX.interpolate({
                inputRange: [0, start, stickyEnd, width],
                outputRange: [start + 10, 10, 10, end - textWidth - 10 - width],
                extrapolate: 'extend',
              })
            : Animated.subtract(start + 10, scrollX);
          return (
            <Animated.Text
              key={`day${i}`}
              style={[styles.stickyDayText, { transform: [{ translateX }] }]}
            >
              {label}
            </Animated.Text>
          );
        })}
      </View>
      </View>
    </View>
  );
}

// ── Public component ─────────────────────────────────────────────────────--

export default function Meteogram({ msg, units, timeFormat }: { msg: ForecastMessage; units: Units; timeFormat: TimeFormat }) {
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

  // Stable across renders so the memoized canvas tiles never see a new press handler.
  const selectColumn = useCallback((block: number, period: number) => setSelection({ block, period }), []);

  const fonts = useMemo<Fonts>(() => ({
    label: matchFont({ fontSize: 12, fontWeight: '500' }),
    sub: matchFont({ fontSize: 10.5, fontWeight: '700' }),
    data: matchFont({ fontSize: 13 }),
    small: matchFont({ fontSize: 10.5, fontWeight: '600' }),
    bold: matchFont({ fontSize: 12.5, fontWeight: '700' }),
    date: matchFont({ fontSize: 14, fontWeight: '600' }),
    hour: matchFont({ fontSize: 12, fontWeight: '400' }),
    hourSuffix: matchFont({ fontSize: 9.5, fontWeight: '400' }),
    strip: matchFont({ fontSize: 11, fontWeight: '300' }),
    stripSub: matchFont({ fontSize: 9.5, fontWeight: '300' }),
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
      rows: buildRows(periods, units),
      periods, dates, steps,
    };
  }), [msg, models, units]);

  const sel = selection != null && selection.period < (blocks[selection.block]?.periods.length ?? 0)
    ? selection
    : null;

  return (
    <View style={styles.container}>
      {blocks.map((b, bi) => (
        <View key={bi}>
          {/* Model header is a plain RN bar so it stays pinned at full width above the scrolling canvas. */}
          {blocks.length > 1 && (
            <View style={[styles.modelHeaderBar, { backgroundColor: b.color }]}>
              <RNText style={styles.modelHeaderText}>{b.name}</RNText>
            </View>
          )}
          <ModelCanvas periods={b.periods} rows={b.rows} dates={b.dates} steps={b.steps} units={units} timeFormat={timeFormat} now={now} lat={msg.lat} lon={msg.lon} fonts={fonts}
            blockIndex={bi}
            selected={sel?.block === bi ? sel.period : null}
            onSelectColumn={selectColumn} />
          {bi < blocks.length - 1 && <View style={styles.sep} />}
        </View>
      ))}
      {sel != null && (
        <DetailPanel
          periods={blocks[sel.block].periods}
          index={sel.period}
          dates={blocks[sel.block].dates}
          steps={blocks[sel.block].steps}
          modelName={blocks.length > 1 ? blocks[sel.block].name : undefined}
          modelColor={blocks[sel.block].color}
          units={units}
          timeFormat={timeFormat}
          lat={msg.lat}
          lon={msg.lon}
          onClose={() => setSelection(null)}
        />
      )}
    </View>
  );
}

// ── Tap detail panel ───────────────────────────────────────────────────────

const LEADER_DOTS = '.'.repeat(160);

// Detail-panel variant of pressureLabel, e.g. "Wind 500 hPa".
function upperWindLabel(level: 500 | 600 | 700): string {
  return `Wind ${pressureLabel(level)}`;
}

// The glyph appearance a period selects: what to draw, on which ground.
function glyphVariantAt(periods: Period[], dates: Date[], steps: number[], i: number, lat: number, lon: number) {
  const midpoint = dates[i].getTime() + steps[i] * 1800000;
  const night = isNight(midpoint, lat, lon);
  const phase = night ? moonPhaseAt(midpoint) : 'full' as MoonPhase;
  return { key: `${periods[i].weathercode}|${night}|${phase}`, code: periods[i].weathercode, night, phase };
}

function DetailPanel({ periods, index, dates, steps, modelName, modelColor, units, timeFormat, lat, lon, onClose }: {
  periods: Period[]; index: number; dates: Date[]; steps: number[];
  modelName?: string; modelColor: string;
  units: Units; timeFormat: TimeFormat; lat: number; lon: number; onClose: () => void;
}) {
  const p = periods[index];
  const date = dates[index];
  const step = steps[index];
  // Row presence mirrors buildRows: a group renders when any period in the model has it, and a
  // missing value within a present group reads — like the canvas dashes.
  const has = (fn: (q: Period) => unknown) => periods.some((q) => fn(q) != null);

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

  const rows: [string, string][] = [];
  if (has((q) => q.temp_c))
    rows.push(['Temperature', p.temp_c != null ? `${fmtTemp(p.temp_c, units)}${units === 'imperial' ? 'F' : 'C'}` : '—']);
  if (has((q) => q.precip)) rows.push(['Precip chance', p.precip != null ? `${p.precip}%` : '—']);
  if (has((q) => q.rain_mm)) {
    rows.push(['Rain', fmtRainFull(p.rain_mm ?? 0, units)]);
    rows.push(['Rain accumulation', fmtRainFull(cumRain, units)]);
  }
  if (has((q) => q.snow_cm)) {
    rows.push(['Snow', fmtSnowFull(p.snow_cm ?? 0, units)]);
    rows.push(['Snow accumulation', fmtSnowFull(cumSnow, units)]);
  }
  if (has((q) => q.wind_sfc_kph)) rows.push(['Wind', fmtWindFull(p.wind_sfc_kph, p.wind_sfc_dir, units)]);
  if (has((q) => q.freeze_m)) rows.push(['Freezing level', fmtFreezeFull(p.freeze_m, units)]);
  if (has((q) => q.wind_500_kph)) rows.push([upperWindLabel(500), fmtWindFull(p.wind_500_kph, p.wind_500_dir, units)]);
  if (has((q) => q.wind_600_kph)) rows.push([upperWindLabel(600), fmtWindFull(p.wind_600_kph, p.wind_600_dir, units)]);
  if (has((q) => q.wind_700_kph)) rows.push([upperWindLabel(700), fmtWindFull(p.wind_700_kph, p.wind_700_dir, units)]);
  if (has((q) => q.cloud_high)) rows.push(['Cloud high (>8km)', p.cloud_high != null ? `${p.cloud_high}%` : '—']);
  if (has((q) => q.cloud_mid)) rows.push(['Cloud mid (3–8km)', p.cloud_mid != null ? `${p.cloud_mid}%` : '—']);
  if (has((q) => q.cloud_low)) rows.push(['Cloud low (<3km)', p.cloud_low != null ? `${p.cloud_low}%` : '—']);

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
              <Canvas style={{ width: 48, height: 48 }}>
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
      {rows.map(([label, value]) => (
        <View key={label} style={styles.detailRow}>
          <RNText style={styles.detailLabel}>{label}</RNText>
          {/* Leader dots: a clipped run of periods stretches to whatever space the label and
              value leave, tying the pair together across the row. */}
          <RNText style={styles.detailDots} numberOfLines={1} ellipsizeMode="clip">{LEADER_DOTS}</RNText>
          <RNText style={styles.detailValue}>{value}</RNText>
        </View>
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  container: { backgroundColor: '#fff' },
  overviewStrip: {
    backgroundColor: SC.bg,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: '#000',
  },
  // The viewport window brackets the graph bands only — the per-day header reads as a fixed
  // calendar above it, so boxing it in moved with the scroll for no reason.
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
  detailRow: { flexDirection: 'row', alignItems: 'baseline', paddingVertical: 4 },
  detailLabel: { fontSize: 13, color: C.sectionText },
  detailDots: { flex: 1, marginHorizontal: 6, fontSize: 13, letterSpacing: 2, color: C.nil },
  detailValue: { fontSize: 13, fontWeight: '600', color: C.label },
  stickyDayRow: { position: 'absolute', top: 0, left: 0, right: 0, height: 31, overflow: 'hidden' },
  stickyDayText: { position: 'absolute', top: 4, color: C.date, fontSize: 14, fontWeight: '600', lineHeight: 24 },
  modelHeaderBar: { paddingHorizontal: 14, paddingVertical: 7 },
  modelHeaderText: { color: '#fff', fontSize: 13, fontWeight: '600' },
  sep: { height: 10, backgroundColor: '#f2f2f7' },
});
