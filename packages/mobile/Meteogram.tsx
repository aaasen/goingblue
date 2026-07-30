import { useEffect, useMemo, useRef, useState, type ReactNode, type RefObject } from 'react';
import { Animated, View, Text as RNText, StyleSheet, FlatList, PanResponder, useWindowDimensions } from 'react-native';
import {
  Canvas, DashPathEffect, Group, Rect, RoundedRect, Circle, Line, Path, Text,
  LinearGradient, Skia, vec, matchFont, type SkFont,
} from '@shopify/react-native-skia';
import {
  CARDINALS, modelsFromMask, startDatetime,
  type ForecastMessage, type Period,
} from '@weather/protocol';
import type { TimeFormat, Units } from './settings';

// ── Layout constants ───────────────────────────────────────────────────────
// The row-label column lives inside the drawing and scrolls horizontally with the
// data. Units are folded into the labels.

const NAME_W = 96;
const CELL_W = 60;
// A Canvas is backed by a CAMetalLayer whose drawable size is measured in physical
// pixels. A single canvas spanning a long hourly forecast can exceed Metal's maximum
// texture width on Retina devices and abort the entire process. Keep each drawable
// narrow and let FlatList virtualize the off-screen tiles. Wider tiles mean fewer seams
// to paint mid-scroll (smoother) while staying well under the texture limit (16×60×3px).
const CANVAS_TILE_W = CELL_W * 16;

const ROW_H = {
  DATE: 58,
  SECTION: 22,
  CLOUD: 58,
  TEMP: 52,
  SNOW: 50,
  DATA: 42,
} as const;

// Overview-strip band heights, stacked top to bottom: a per-day header (weekday, summary glyph,
// daily high) over the mini temperature / precip / wind graphs.
const STRIP_DAY_H = 12;
const STRIP_GLYPH_H = 20;
const STRIP_TVAL_H = 14;
const STRIP_HEAD_H = STRIP_DAY_H + STRIP_GLYPH_H + STRIP_TVAL_H;
const STRIP_SIL_H = 28;
const STRIP_PRECIP_H = 13;
const STRIP_WIND_H = 6;
const STRIP_H = STRIP_HEAD_H + STRIP_SIL_H + STRIP_PRECIP_H + STRIP_WIND_H;

// ── Palette ──────────────────────────────────────────────────────────────--

const C = {
  bg: '#ffffff',
  night: '#eceef3',
  grid: '#f0f1f4',
  keyBg: '#e5e5ea',
  section: '#eef1f6',
  sectionText: '#8a8f99',
  label: '#2c2c2e',
  unit: '#9aa0aa',
  date: '#48484a',
  nil: '#d1d1d6',
} as const;

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

// Wind speed ramp, calm → storm. [mph upper bound, bg, fg]
const BEAUFORT: [number, string, string][] = [
  [1, '#a7cf95', '#2b3a25'],
  [4, '#8cc274', '#2b3a25'],
  [8, '#aacb52', '#2b3a16'],
  [13, '#cfd049', '#3a3614'],
  [19, '#edc63f', '#3a2e08'],
  [25, '#eba23c', '#fff'],
  [32, '#e37b34', '#fff'],
  [39, '#d9502d', '#fff'],
  [47, '#c02b2b', '#fff'],
  [55, '#9c2566', '#fff'],
  [64, '#76288e', '#fff'],
  [73, '#522a9e', '#fff'],
  [Infinity, '#372a8e', '#fff'],
];

// Temperature → color stops (°C), interpolated for a smooth blue→red scale.
const TEMP_STOPS: [number, [number, number, number]][] = [
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

function tempColor(c: number, alpha = 1): string {
  const s = TEMP_STOPS;
  if (c <= s[0][0]) return rgb(s[0][1], alpha);
  if (c >= s[s.length - 1][0]) return rgb(s[s.length - 1][1], alpha);
  for (let i = 0; i < s.length - 1; i++) {
    const [t0, c0] = s[i];
    const [t1, c1] = s[i + 1];
    if (c >= t0 && c <= t1) {
      const t = (c - t0) / (t1 - t0);
      return rgb([lerp(c0[0], c1[0], t), lerp(c0[1], c1[1], t), lerp(c0[2], c1[2], t)], alpha);
    }
  }
  return '#1c1c1e';
}

function beaufort(kph: number): { bg: string; fg: string } {
  const mph = kph / 1.60934;
  const [, bg, fg] = BEAUFORT.find(([lim]) => mph < lim)!;
  return { bg, fg };
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
function fmtFreeze(m: number | undefined, u: Units): string {
  if (m == null) return '';
  if (u === 'imperial') return `${(Math.round((m * 3.28084) / 500) * 500).toLocaleString()}`;
  return `${Math.round(m / 100) * 100}`;
}
function fmtWind(kph: number | undefined, u: Units): string {
  if (kph == null) return '';
  return u === 'imperial' ? `${Math.round(kph / 1.60934)}` : `${Math.round(kph)}`;
}

function tempUnit(u: Units) { return u === 'imperial' ? '°F' : '°C'; }
function freezeUnit(u: Units) { return u === 'imperial' ? 'ft' : 'm'; }
function windUnit(u: Units) { return u === 'imperial' ? 'mph' : 'kph'; }

const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
function dayLabel(d: Date): string { return `${DAYS[d.getDay()]} ${d.getDate()}`; }
function hourLabel(d: Date, step: number, timeFormat: TimeFormat): string {
  if (step >= 24) return '';
  const hour = d.getHours();
  if (timeFormat === '24h') return `${hour}`;
  return `${hour % 12 || 12}${hour < 12 ? 'am' : 'pm'}`;
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

function pressureLabel(level: 500 | 600 | 700, u: Units): string {
  const ft: Record<number, string> = { 500: '18,000', 600: '14,000', 700: '10,000' };
  const m: Record<number, string> = { 500: '5,500', 600: '4,200', 700: '3,000' };
  return u === 'imperial' ? `${level}mb ~${ft[level]}ft` : `${level}mb ~${m[level]}m`;
}

// ── Row model ──────────────────────────────────────────────────────────────

type RowKind =
  | 'clouds' | 'temp' | 'accumulation' | 'freeze' | 'wind-sfc'
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
    has((p) => p.snow_cm) || has((p) => p.rain_mm) || has((p) => p.freeze_m) || has((p) => p.wind_sfc_kph);
  if (hasSurface) {
    if (has((p) => p.temp_c))
      rows.push({ kind: 'temp', height: ROW_H.TEMP, label: `Temp ${tU}` });
    if (has((p) => p.freeze_m)) rows.push({ kind: 'freeze', height: ROW_H.DATA, label: `Freezing ${frU}` });
    if (has((p) => p.precip) || has((p) => p.snow_cm) || has((p) => p.rain_mm))
      rows.push({ kind: 'accumulation', height: ROW_H.SNOW, label: 'Precip' });
    if (has((p) => p.wind_sfc_kph)) rows.push({ kind: 'wind-sfc', height: ROW_H.DATA, label: `Wind ${wU}` });
  }

  const hasCloud = has((p) => p.cloud_high) || has((p) => p.cloud_mid) || has((p) => p.cloud_low);
  if (hasCloud) {
    rows.push({ kind: 'section', height: ROW_H.SECTION, label: 'Cloud cover %' });
    if (has((p) => p.cloud_high)) rows.push({ kind: 'cloud-high', height: ROW_H.DATA, label: 'High' });
    if (has((p) => p.cloud_mid)) rows.push({ kind: 'cloud-mid', height: ROW_H.DATA, label: 'Mid' });
    if (has((p) => p.cloud_low)) rows.push({ kind: 'cloud-low', height: ROW_H.DATA, label: 'Low' });
  }

  const hasUpper = has((p) => p.wind_500_kph) || has((p) => p.wind_600_kph) || has((p) => p.wind_700_kph);
  if (hasUpper) {
    rows.push({ kind: 'section', height: ROW_H.SECTION, label: `Upper wind ${wU}` });
    if (has((p) => p.wind_500_kph)) rows.push({ kind: 'wind-500', height: ROW_H.DATA, label: pressureLabel(500, u) });
    if (has((p) => p.wind_600_kph)) rows.push({ kind: 'wind-600', height: ROW_H.DATA, label: pressureLabel(600, u) });
    if (has((p) => p.wind_700_kph)) rows.push({ kind: 'wind-700', height: ROW_H.DATA, label: pressureLabel(700, u) });
  }

  return rows;
}

// ── Drawing helpers ────────────────────────────────────────────────────────

// Baseline offset to vertically center text of a given size at a y coordinate.
function baseline(cy: number, size: number) { return cy + size * 0.35; }

interface Fonts {
  label: SkFont; sub: SkFont; data: SkFont; small: SkFont; bold: SkFont; date: SkFont; hour: SkFont;
}

function centerText(key: string, text: string, cx: number, cy: number, font: SkFont, color: string): ReactNode {
  if (!text) return null;
  const w = font.getTextWidth(text);
  return <Text key={key} x={cx - w / 2} y={baseline(cy, font.getSize())} text={text} font={font} color={color} />;
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

// A puffy cloud + optional sun + precip glyphs, centered in a column cell.
function cloudGlyph(key: string, cx: number, top: number, h: number, code: number, coverage: number): ReactNode {
  const els: ReactNode[] = [];
  const cy = top + h / 2;
  const showSun = coverage < 65;
  const cloudGray = rgb([
    lerp(196, 132, Math.min(1, coverage / 100)),
    lerp(201, 138, Math.min(1, coverage / 100)),
    lerp(209, 148, Math.min(1, coverage / 100)),
  ]);

  if (showSun) {
    const sx = coverage < 25 ? cx : cx - 11;
    const sy = cy - 6;
    const r = 8;
    for (let a = 0; a < 8; a++) {
      const ang = (a * Math.PI) / 4;
      els.push(
        <Line key={`${key}-ray${a}`} p1={vec(sx + Math.cos(ang) * (r + 2), sy + Math.sin(ang) * (r + 2))}
          p2={vec(sx + Math.cos(ang) * (r + 5), sy + Math.sin(ang) * (r + 5))} color="#f5b836" strokeWidth={1.6} />,
      );
    }
    els.push(<Circle key={`${key}-sun`} cx={sx} cy={sy} r={r} color="#f6b93b" />);
  }

  if (coverage >= 25) {
    const scale = 0.8 + Math.min(1, coverage / 100) * 0.35;
    const bx = showSun ? cx + 6 : cx;
    const by = cy + 4;
    const w = 17 * scale;
    els.push(<Circle key={`${key}-c1`} cx={bx - w * 0.55} cy={by} r={7.5 * scale} color={cloudGray} />);
    els.push(<Circle key={`${key}-c2`} cx={bx + w * 0.55} cy={by - 1} r={6.5 * scale} color={cloudGray} />);
    els.push(<Circle key={`${key}-c3`} cx={bx} cy={by - 5 * scale} r={9 * scale} color={cloudGray} />);
    els.push(
      <RoundedRect key={`${key}-cb`} x={bx - w} y={by} width={w * 2} height={8 * scale} r={4 * scale} color={cloudGray} />,
    );
  }

  // Precip glyphs below the cloud.
  const isSnow = SNOW_CODES.has(code);
  const isRain = RAIN_CODES.has(code);
  if (isSnow || isRain) {
    const py = top + h - 9;
    for (let i = -1; i <= 1; i++) {
      const px = cx + i * 7;
      if (isRain) {
        els.push(<Line key={`${key}-r${i}`} p1={vec(px + 1.5, py - 3)} p2={vec(px - 1.5, py + 4)} color="#4a90d9" strokeWidth={1.8} />);
      } else {
        els.push(<Circle key={`${key}-s${i}`} cx={px} cy={py} r={1.7} color="#7f9bb5" />);
      }
    }
  }

  return <Group key={key}>{els}</Group>;
}

// ── Overview strip (per-model minimap + scrubber) ────────────────────────--

type Tile = { offset: number; width: number };

// A coarse, screen-width overview whose x-axis is linear in time, so full days come out equal
// width regardless of how many periods they hold. Each day column shows its weekday, a summary
// weather glyph, and its high over a mini temperature silhouette, the same stacked snow/rain area,
// and a Beaufort wind ribbon. A viewport window tracks the meteogram's scroll on the native
// driver, and touching the strip scrubs the meteogram to that position.
function OverviewStrip({ periods, dates, steps, units, lat, lon, now, width, flatListRef, scrollX, fonts }: {
  periods: Period[]; dates: Date[]; steps: number[]; units: Units; lat: number; lon: number; now: number;
  width: number; flatListRef: RefObject<FlatList<Tile> | null>; scrollX: Animated.Value; fonts: Fonts;
}) {
  const n = periods.length;
  const W = width;
  const dayGroups = buildDayGroups(dates);

  // Time-linear columns: each period's width is proportional to the hours it spans. Full days come
  // out equal width whatever their resolution — a coarse far-term day is no wider than an hourly
  // near-term one — so same-resolution periods (and the viewport window over them) render the same
  // size on every day. The axis is padded back to the first day's local midnight: a forecast that
  // starts mid-day keeps a full-width first column, with dead space standing in for the hours
  // before the forecast starts.
  const cum = new Float64Array(n + 1);
  for (let i = 0; i < n; i++) cum[i + 1] = cum[i] + steps[i];
  const firstMidnight = new Date(dates[0]);
  firstMidnight.setHours(0, 0, 0, 0);
  const padHours = (dates[0].getTime() - firstMidnight.getTime()) / 3600000;
  const pxPerHour = W / (padHours + cum[n]);
  const timeX = (h: number) => (padHours + h) * pxPerHour;
  const slot = (i: number) => {
    const left = timeX(cum[i]);
    const right = timeX(cum[i + 1]);
    return { left, center: (left + right) / 2, right };
  };

  const graphTop = STRIP_HEAD_H;
  const els: ReactNode[] = [];

  // Night shading behind the graph bands.
  dates.forEach((d, i) => {
    const s = slot(i);
    const start = d.getTime();
    const end = start + steps[i] * 3600000;
    nightSegments(start, end, lat, lon).forEach(([from, to], seg) => {
      els.push(<Rect key={`snight${i}-${seg}`} x={s.left + from * (s.right - s.left)} y={graphTop}
        width={(to - from) * (s.right - s.left)} height={STRIP_H - graphTop} color={C.night} />);
    });
  });

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
          colors={[tempColor(tMax, 0.55), tempColor((tMax + tMin) / 2, 0.55), tempColor(tMin, 0.55)]}
          positions={[0, 0.5, 1]} />
      </Path>,
    );
  }

  // Snow + rain stacked liquid-equivalent area (snow cm already equals mm at 10:1).
  const rainEq = periods.map((p) => p.rain_mm ?? 0);
  const snowEq = periods.map((p) => p.snow_cm ?? 0);
  const totalEq = rainEq.map((r, i) => r + snowEq[i]);
  const maxEq = Math.max(0, ...totalEq);
  const precipBottom = silBottom + STRIP_PRECIP_H;
  if (maxEq > 0) {
    const yOf = (v: number) => precipBottom - (v / maxEq) * (STRIP_PRECIP_H - 2);
    const boundary = (values: number[]) => [
      { x: timeX(0), y: yOf(values[0]) },
      ...values.map((v, i) => ({ x: slot(i).center, y: yOf(v) })),
      { x: W, y: yOf(values[values.length - 1]) },
    ];
    const rainPoints = boundary(rainEq);
    const totalPoints = boundary(totalEq);
    const rainArea = Skia.Path.Make();
    smoothTo(rainArea, rainPoints);
    rainArea.lineTo(W, precipBottom);
    rainArea.lineTo(timeX(0), precipBottom);
    rainArea.close();
    const snowArea = Skia.Path.Make();
    smoothTo(snowArea, totalPoints);
    smoothTo(snowArea, rainPoints, true);
    snowArea.close();
    els.push(
      <Group key="strip-precip">
        <Path path={rainArea} color="#4b8fc8" />
        <Path path={snowArea} color="#c6e1f5" />
      </Group>,
    );
  }

  // Surface-wind ribbon along the bottom, Beaufort-colored like the main canvas.
  const windTop = STRIP_H - STRIP_WIND_H;
  periods.forEach((p, i) => {
    if (p.wind_sfc_kph == null) return;
    const s = slot(i);
    els.push(<Rect key={`swind${i}`} x={s.left} y={windTop} width={s.right - s.left + 0.5}
      height={STRIP_WIND_H} color={beaufort(p.wind_sfc_kph).bg} />);
  });

  // Per-day header: weekday, summary glyph, daily high, and a boundary separator.
  const glyphScale = STRIP_GLYPH_H / 38;
  dayGroups.forEach((g, d) => {
    // The first day's column includes the pre-forecast pad, back to x=0 (midnight).
    const left = d === 0 ? 0 : timeX(cum[g.start]);
    const dayW = timeX(cum[g.end]) - left;
    const cx = left + dayW / 2;
    if (d > 0) {
      els.push(<Line key={`sbd${d}`} p1={vec(left, 0)} p2={vec(left, STRIP_H)} color={C.grid} strokeWidth={1} />);
    }
    let code = periods[g.start].weathercode;
    let hi: number | undefined;
    for (let i = g.start; i < g.end; i++) {
      if (codeSeverity(periods[i].weathercode) > codeSeverity(code)) code = periods[i].weathercode;
      const t = periods[i].temp_c;
      if (t != null) hi = hi == null ? t : Math.max(hi, t);
    }
    // The glyph is drawn at its natural meteogram size, then scaled into the small header slot.
    els.push(
      <Group key={`gly${d}`} transform={[{ translateX: cx }, { translateY: STRIP_DAY_H }, { scale: glyphScale }]}>
        {cloudGlyph(`glyi${d}`, 0, 0, 38, code, codeCoverage(code))}
      </Group>,
    );
    if (dayW >= 22) {
      els.push(centerText(`swk${d}`, DAYS[g.date.getDay()].slice(0, 3).toUpperCase(), cx, STRIP_DAY_H / 2, fonts.sub, C.date));
    }
    if (hi != null && dayW >= 20) {
      els.push(centerText(`shi${d}`, fmtTemp(hi, units), cx, STRIP_DAY_H + STRIP_GLYPH_H + STRIP_TVAL_H / 2, fonts.small, C.label));
    }
  });

  // Current-time marker across the graph bands.
  const cur = dates.findIndex((date, i) => now >= date.getTime() && now < date.getTime() + steps[i] * 3600000);
  if (cur >= 0) {
    const s = slot(cur);
    const frac = (now - dates[cur].getTime()) / (steps[cur] * 3600000);
    const mx = s.left + frac * (s.right - s.left);
    els.push(<Line key="strip-now" p1={vec(mx, graphTop)} p2={vec(mx, STRIP_H)} color="rgba(255,59,48,0.5)" strokeWidth={1} />);
  }

  const contentW = NAME_W + n * CELL_W;
  const maxOffset = Math.max(0, contentW - W);

  // Scrub: map the touched time position back to a fractional period index, then center the
  // viewport on it.
  const scrub = (xMini: number) => {
    if (maxOffset <= 0) return;
    const clampedX = Math.max(0, Math.min(W, xMini));
    const hours = Math.max(0, clampedX / pxPerHour - padHours);
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
}

// ── Meteogram canvas (one per model) ─────────────────────────────────────--

function ModelCanvas({ periods, rows, dates, steps, units, timeFormat, now, lat, lon, fonts }: {
  // `steps` is each period's span in hours — the fill mixes resolutions within one message.
  // Columns stay equal-width; the span drives labels and shading.
  periods: Period[]; rows: Row[]; dates: Date[]; steps: number[]; units: Units; timeFormat: TimeFormat; now: number; lat: number; lon: number; fonts: Fonts;
}) {
  const scrollX = useRef(new Animated.Value(0)).current;
  const flatListRef = useRef<FlatList<Tile>>(null);
  const screenW = useWindowDimensions().width;
  const n = periods.length;
  const width = NAME_W + n * CELL_W;
  const totalH = ROW_H.DATE + rows.reduce((s, r) => s + r.height, 0);
  const tiles = Array.from({ length: Math.ceil(width / CANVAS_TILE_W) }, (_, index) => {
    const offset = index * CANVAS_TILE_W;
    return { offset, width: Math.min(CANVAS_TILE_W, width - offset) };
  });
  const colLeft = (i: number) => NAME_W + i * CELL_W;
  const colCenter = (i: number) => NAME_W + i * CELL_W + CELL_W / 2;

  const els: ReactNode[] = [];
  els.push(<Rect key="key-column-bg" x={0} y={0} width={NAME_W} height={totalH} color={C.keyBg} />);

  // 1. Location-aware astronomical night shading. Partial rectangles place sunrise and sunset
  // within a column rather than rounding them to the forecast period boundary.
  dates.forEach((d, i) => {
    const start = d.getTime();
    const end = start + steps[i] * 3600000;
    nightSegments(start, end, lat, lon).forEach(([from, to], segment) => {
      els.push(<Rect key={`night${i}-${segment}`} x={colLeft(i) + from * CELL_W} y={31} width={(to - from) * CELL_W} height={totalH - 31} color={C.night} />);
    });
  });
  const headerInsertIndex = els.length;

  // 2. Date header. Hours occupy their own row. Each day label sticks to the visible left
  // edge while its columns are being scrolled, then yields to the following day.
  const dayGroups = buildDayGroups(dates);
  dates.forEach((d, i) => {
    els.push(centerText(`hour${i}`, hourLabel(d, steps[i], timeFormat), colCenter(i), 44, fonts.hour, C.date));
  });
  dayGroups.slice(1).forEach((group, i) => {
    const x = colLeft(group.start);
    els.push(<Line key={`day-boundary${i}`} p1={vec(x, 0)} p2={vec(x, 31)} color={C.grid} strokeWidth={1} />);
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
    const valueY = (value: number) =>
      accumulationBottom! - (value / maxEquivalent) * (accumulationBottom! - plotTop);
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
  // header and visual weather rows down to freezing level, excluding wind and lower sections.
  const markerRows = new Set<RowKind>(['clouds', 'temp', 'accumulation', 'freeze']);
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
          const cov = codeCoverage(p.weathercode);
          els.push(cloudGlyph(`cl${i}`, colCenter(i), top, row.height, p.weathercode, cov));
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

      case 'freeze':
        periods.forEach((p, i) => {
          const txt = fmtFreeze(p.freeze_m, units);
          els.push(centerText(`fz${i}`, txt || '—', colCenter(i), mid, fonts.data, txt ? '#1c1c1e' : C.nil));
        });
        break;

      case 'wind-sfc': case 'wind-500': case 'wind-600': case 'wind-700': {
        const base = row.kind.replace('-', '_'); // wind-sfc → wind_sfc, wind-500 → wind_500
        const speedKey = `${base}_kph` as keyof Period;
        const dirKey = `${base}_dir` as keyof Period;
        periods.forEach((p, i) => {
          const kph = p[speedKey] as number | undefined;
          const cx = colCenter(i);
          if (kph == null) { els.push(centerText(`w${ri}-${i}`, '—', cx, mid, fonts.data, C.nil)); return; }
          const { bg, fg } = beaufort(kph);
          els.push(<Rect key={`wbg${ri}-${i}`} x={colLeft(i)} y={top} width={CELL_W} height={row.height} color={bg} />);
          const di = p[dirKey] as number | undefined;
          const arrow = di != null ? ARROWS[CARDINALS[di] ?? 'N'] ?? '' : '';
          els.push(centerText(`ws${ri}-${i}`, fmtWind(kph, units), cx, mid - 7, fonts.bold, fg));
          els.push(centerText(`wa${ri}-${i}`, arrow, cx, mid + 9, fonts.data, fg));
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
          els.push(centerText(`ccv${ri}-${i}`, `${pct}`, cx, mid, fonts.data, '#48484a'));
        });
        break;
      }
    }
  });

  return (
    <View>
      <OverviewStrip periods={periods} dates={dates} steps={steps} units={units} lat={lat} lon={lon} now={now}
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
        renderItem={({ item: tile }) => (
          <Canvas style={{ width: tile.width, height: totalH }}>
            <Group transform={[{ translateX: -tile.offset }]}>{els}</Group>
          </Canvas>
        )}
      />
      <View pointerEvents="none" style={styles.stickyDayRow}>
        {dayGroups.map((group, i) => {
          const label = dayLabel(group.date);
          const textWidth = fonts.date.getTextWidth(label);
          const start = colLeft(group.start);
          const end = colLeft(group.end);
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
  const models = modelsFromMask(msg.models_mask);
  const [now, setNow] = useState(Date.now());

  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 60000);
    return () => clearInterval(timer);
  }, []);

  const fonts = useMemo<Fonts>(() => ({
    label: matchFont({ fontSize: 12, fontWeight: '500' }),
    sub: matchFont({ fontSize: 10.5, fontWeight: '700' }),
    data: matchFont({ fontSize: 13 }),
    small: matchFont({ fontSize: 10.5, fontWeight: '600' }),
    bold: matchFont({ fontSize: 12.5, fontWeight: '700' }),
    date: matchFont({ fontSize: 14, fontWeight: '600' }),
    hour: matchFont({ fontSize: 14, fontWeight: '400' }),
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
          <ModelCanvas periods={b.periods} rows={b.rows} dates={b.dates} steps={b.steps} units={units} timeFormat={timeFormat} now={now} lat={msg.lat} lon={msg.lon} fonts={fonts} />
          {bi < blocks.length - 1 && <View style={styles.sep} />}
        </View>
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  container: { backgroundColor: '#fff' },
  overviewStrip: {
    backgroundColor: C.bg,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: C.grid,
  },
  overviewWindowFill: {
    position: 'absolute',
    top: 0,
    height: STRIP_H,
    borderTopWidth: 1.5,
    borderBottomWidth: 1.5,
    borderColor: '#2a6bb5',
    backgroundColor: 'rgba(42,107,181,0.08)',
  },
  overviewWindowEdge: {
    position: 'absolute',
    top: 0,
    height: STRIP_H,
    width: 1.5,
    backgroundColor: '#2a6bb5',
  },
  stickyDayRow: { position: 'absolute', top: 0, left: 0, right: 0, height: 31, overflow: 'hidden' },
  stickyDayText: { position: 'absolute', top: 4, color: C.date, fontSize: 14, fontWeight: '600', lineHeight: 24 },
  modelHeaderBar: { paddingHorizontal: 14, paddingVertical: 7 },
  modelHeaderText: { color: '#fff', fontSize: 13, fontWeight: '600' },
  sep: { height: 10, backgroundColor: '#f2f2f7' },
});
