import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { Animated, View, Text as RNText, StyleSheet } from 'react-native';
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
// The row-label column lives inside the canvas and scrolls horizontally with the
// data (one canvas keeps panning trivial). Units are folded into the labels.

const NAME_W = 96;
const CELL_W = 60;

const ROW_H = {
  DATE: 58,
  SECTION: 22,
  CLOUD: 58,
  PRECIP: 44,
  TEMP: 88,
  SNOW: 50,
  DATA: 42,
} as const;

// ── Palette ──────────────────────────────────────────────────────────────--

const C = {
  bg: '#ffffff',
  night: '#eceef3',
  grid: '#f0f1f4',
  section: '#eef1f6',
  sectionText: '#8a8f99',
  label: '#48484a',
  unit: '#9aa0aa',
  date: '#48484a',
  nil: '#d1d1d6',
} as const;

const MODEL_COLORS: Record<string, string> = {
  'ECMWF IFS HRES': '#2a6bb5',
  GFS: '#2a8f5a',
  ICON: '#c06010',
  'ECMWF IFS 0.25': '#7040b0',
};

// ── Weather code classification ──────────────────────────────────────────--

const SNOW_CODES = new Set([56, 57, 66, 67, 71, 73, 75, 77, 85, 86]);
const RAIN_CODES = new Set([51, 53, 55, 61, 63, 65, 80, 81, 82, 95, 96, 99]);

// Coverage (0–100) implied by a weather code, used when cloud_total is absent.
function codeCoverage(code: number): number {
  if (code === 0) return 0;
  if (code === 1) return 25;
  if (code === 2) return 55;
  if (code === 3) return 95;
  if (code === 45 || code === 48) return 90; // fog
  return 85; // anything precipitating is heavily clouded
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

function rgb([r, g, b]: [number, number, number]): string {
  return `rgb(${r}, ${g}, ${b})`;
}

function tempColor(c: number): string {
  const s = TEMP_STOPS;
  if (c <= s[0][0]) return rgb(s[0][1]);
  if (c >= s[s.length - 1][0]) return rgb(s[s.length - 1][1]);
  for (let i = 0; i < s.length - 1; i++) {
    const [t0, c0] = s[i];
    const [t1, c1] = s[i + 1];
    if (c >= t0 && c <= t1) {
      const t = (c - t0) / (t1 - t0);
      return rgb([lerp(c0[0], c1[0], t), lerp(c0[1], c1[1], t), lerp(c0[2], c1[2], t)]);
    }
  }
  return '#1c1c1e';
}

function beaufort(kph: number): { bg: string; fg: string } {
  const mph = kph / 1.60934;
  const [, bg, fg] = BEAUFORT.find(([lim]) => mph < lim)!;
  return { bg, fg };
}

function precipColor(pct: number): string {
  if (pct >= 60) return '#c04040';
  if (pct >= 30) return '#c08020';
  return '#4080c8';
}

// ── Unit-aware formatting (no suffix; unit lives in the row label) ──────────--

function fmtTemp(c: number | undefined, u: Units): string {
  if (c == null) return '';
  return u === 'imperial' ? `${Math.round((c * 9) / 5 + 32)}` : `${Math.round(c)}`;
}
function fmtSnow(cm: number, u: Units): string {
  if (u === 'imperial') {
    const inches = cm / 2.54;
    return inches >= 0.1 ? inches.toFixed(inches < 1 ? 1 : 0) : '';
  }
  return cm >= 0.5 ? `${Math.round(cm)}` : '';
}
function fmtRain(mm: number, u: Units): string {
  if (u === 'imperial') {
    const inches = mm / 25.4;
    return inches >= 0.01 ? inches.toFixed(2) : '';
  }
  if (mm < 0.5) return '';
  return mm < 10 ? mm.toFixed(1) : `${Math.round(mm)}`;
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
function snowUnit(u: Units) { return u === 'imperial' ? 'in' : 'cm'; }
function rainUnit(u: Units) { return u === 'imperial' ? 'in' : 'mm'; }
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

function pressureLabel(level: 500 | 600 | 700, u: Units): string {
  const ft: Record<number, string> = { 500: '18,000', 600: '14,000', 700: '10,000' };
  const m: Record<number, string> = { 500: '5,500', 600: '4,200', 700: '3,000' };
  return u === 'imperial' ? `${level}mb ~${ft[level]}ft` : `${level}mb ~${m[level]}m`;
}

// ── Row model ──────────────────────────────────────────────────────────────

type RowKind =
  | 'clouds' | 'precip' | 'temp' | 'snow' | 'rain' | 'freeze' | 'wind-sfc'
  | 'cloud-total' | 'cloud-high' | 'cloud-mid' | 'cloud-low'
  | 'wind-500' | 'wind-600' | 'wind-700' | 'section';

interface Row {
  kind: RowKind;
  height: number;
  label: string;
}

function buildRows(periods: Period[], u: Units): Row[] {
  const rows: Row[] = [];
  const has = (fn: (p: Period) => unknown) => periods.some((p) => fn(p) != null);
  const tU = tempUnit(u), snU = snowUnit(u), rnU = rainUnit(u), frU = freezeUnit(u), wU = windUnit(u);

  rows.push({ kind: 'clouds', height: ROW_H.CLOUD, label: 'Sky' });

  const hasSurface =
    has((p) => p.precip) || has((p) => p.temp_c) || has((p) => p.temp_min_c) ||
    has((p) => p.snow_cm) || has((p) => p.rain_mm) || has((p) => p.freeze_m) || has((p) => p.wind_sfc_kph);
  if (hasSurface) {
    rows.push({ kind: 'section', height: ROW_H.SECTION, label: 'Surface' });
    if (has((p) => p.temp_c) || has((p) => p.temp_min_c))
      rows.push({ kind: 'temp', height: ROW_H.TEMP, label: `Temp ${tU}` });
    if (has((p) => p.freeze_m)) rows.push({ kind: 'freeze', height: ROW_H.DATA, label: `Freezing ${frU}` });
    if (has((p) => p.precip)) rows.push({ kind: 'precip', height: ROW_H.PRECIP, label: 'Precip %' });
    if (has((p) => p.snow_cm)) rows.push({ kind: 'snow', height: ROW_H.SNOW, label: `Snow ${snU}` });
    if (has((p) => p.rain_mm)) rows.push({ kind: 'rain', height: ROW_H.SNOW, label: `Rain ${rnU}` });
    if (has((p) => p.wind_sfc_kph)) rows.push({ kind: 'wind-sfc', height: ROW_H.DATA, label: `Wind ${wU}` });
  }

  const hasCloud = has((p) => p.cloud_total) || has((p) => p.cloud_high) ||
    has((p) => p.cloud_mid) || has((p) => p.cloud_low);
  if (hasCloud) {
    rows.push({ kind: 'section', height: ROW_H.SECTION, label: 'Cloud cover %' });
    if (has((p) => p.cloud_total)) rows.push({ kind: 'cloud-total', height: ROW_H.DATA, label: 'Total' });
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

// ── Meteogram canvas (one per model) ─────────────────────────────────────--

function ModelCanvas({ periods, rows, dates, steps, units, timeFormat, now, lat, lon, fonts }: {
  // `steps` is each period's span in hours — the fill mixes resolutions within one message.
  // Columns stay equal-width; the span drives labels and shading.
  periods: Period[]; rows: Row[]; dates: Date[]; steps: number[]; units: Units; timeFormat: TimeFormat; now: number; lat: number; lon: number; fonts: Fonts;
}) {
  const scrollX = useRef(new Animated.Value(0)).current;
  const n = periods.length;
  const width = NAME_W + n * CELL_W;
  const totalH = ROW_H.DATE + rows.reduce((s, r) => s + r.height, 0);
  const colLeft = (i: number) => NAME_W + i * CELL_W;
  const colCenter = (i: number) => NAME_W + i * CELL_W + CELL_W / 2;

  const els: ReactNode[] = [];

  // 1. Location-aware astronomical night shading. Partial rectangles place sunrise and sunset
  // within a column rather than rounding them to the forecast period boundary.
  dates.forEach((d, i) => {
    const start = d.getTime();
    const end = start + steps[i] * 3600000;
    nightSegments(start, end, lat, lon).forEach(([from, to], segment) => {
      els.push(<Rect key={`night${i}-${segment}`} x={colLeft(i) + from * CELL_W} y={ROW_H.DATE} width={(to - from) * CELL_W} height={totalH - ROW_H.DATE} color={C.night} />);
    });
  });

  // 2. Column separators + header underline.
  for (let i = 0; i <= n; i++) {
    els.push(<Line key={`grid${i}`} p1={vec(colLeft(i), ROW_H.DATE)} p2={vec(colLeft(i), totalH)} color={C.grid} strokeWidth={1} />);
  }
  els.push(<Line key="hdr-rule" p1={vec(0, ROW_H.DATE)} p2={vec(width, ROW_H.DATE)} color="#d1d1d6" strokeWidth={1} />);

  // 3. Date header. Hours occupy their own row. Each day label sticks to the visible left
  // edge while its columns are being scrolled, then yields to the following day.
  const dayGroups: { start: number; end: number; date: Date }[] = [];
  dates.forEach((d, i) => {
    const previous = dayGroups[dayGroups.length - 1];
    if (!previous || previous.date.toDateString() !== d.toDateString()) {
      dayGroups.push({ start: i, end: i + 1, date: d });
    } else {
      previous.end = i + 1;
    }
    els.push(centerText(`hour${i}`, hourLabel(d, steps[i], timeFormat), colCenter(i), 44, fonts.hour, C.date));
  });
  els.push(<Line key="date-row-rule" p1={vec(NAME_W, 31)} p2={vec(width, 31)} color={C.grid} strokeWidth={1} />);

  // Temperature domain across all periods (max + min).
  const temps: number[] = [];
  periods.forEach((p) => { if (p.temp_c != null) temps.push(p.temp_c); if (p.temp_min_c != null) temps.push(p.temp_min_c); });
  const tMin = temps.length ? Math.min(...temps) - 1 : 0;
  const tMax = temps.length ? Math.max(...temps) + 1 : 1;

  // Snow / rain bar scaling (each row scales to its own max accumulation).
  const maxSnow = Math.max(0, ...periods.map((p) => p.snow_cm ?? 0));
  const maxRain = Math.max(0, ...periods.map((p) => p.rain_mm ?? 0));

  // Current time, positioned proportionally within its period. Run it through the date/time
  // header and visual weather rows down to freezing level, excluding wind and lower sections.
  const markerRows = new Set<RowKind>(['clouds', 'precip', 'temp', 'snow', 'rain', 'freeze']);
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
    els.push(<Text key={`lbl${ri}`} x={12} y={baseline(mid, fonts.label.getSize())} text={row.label} font={fonts.label} color={C.label} />);

    switch (row.kind) {
      case 'clouds':
        periods.forEach((p, i) => {
          const cov = p.cloud_total ?? codeCoverage(p.weathercode);
          els.push(cloudGlyph(`cl${i}`, colCenter(i), top, row.height, p.weathercode, cov));
        });
        break;

      case 'precip':
        periods.forEach((p, i) => {
          if (p.precip == null) { els.push(centerText(`pn${i}`, '—', colCenter(i), mid, fonts.data, C.nil)); return; }
          const col = precipColor(p.precip);
          const cx = colCenter(i);
          els.push(centerText(`pp${i}`, `${p.precip}`, cx, mid - 6, fonts.bold, col));
          const tw = 40;
          els.push(<RoundedRect key={`pt${i}`} x={cx - tw / 2} y={mid + 8} width={tw} height={4} r={2} color="#e5e8ee" />);
          els.push(<RoundedRect key={`pf${i}`} x={cx - tw / 2} y={mid + 8} width={(tw * p.precip) / 100} height={4} r={2} color={col} />);
        });
        break;

      case 'temp': {
        const tp = 16, bp = 22;
        const span = row.height - tp - bp;
        const scaleY = (t: number) => top + tp + ((tMax - t) / (tMax - tMin)) * span;
        const maxPts: { x: number; y: number }[] = [];
        const minPts: { x: number; y: number }[] = [];
        periods.forEach((p, i) => {
          const hi = p.temp_c ?? p.temp_min_c;
          const lo = p.temp_min_c ?? p.temp_c;
          if (hi != null) maxPts.push({ x: colCenter(i), y: scaleY(hi) });
          if (lo != null) minPts.push({ x: colCenter(i), y: scaleY(lo) });
        });
        if (maxPts.length) {
          // Filled band between max and min curves with a warm→cool vertical gradient.
          const band = Skia.Path.Make();
          smoothTo(band, maxPts);
          smoothTo(band, minPts, true);
          band.close();
          els.push(
            <Path key="tband" path={band}>
              <LinearGradient start={vec(0, top + tp)} end={vec(0, top + tp + span)}
                colors={[tempColor(tMax), tempColor((tMax + tMin) / 2), tempColor(tMin)]} />
            </Path>,
          );
          // The high-temperature curve, emphasized.
          const line = Skia.Path.Make();
          smoothTo(line, maxPts);
          els.push(<Path key="tline" path={line} style="stroke" strokeWidth={2} color={tempColor(tMax)} />);
        }
        periods.forEach((p, i) => {
          const cx = colCenter(i);
          if (p.temp_c != null) {
            const yHi = scaleY(p.temp_c);
            els.push(centerText(`th${i}`, fmtTemp(p.temp_c, units), cx, yHi - 9, fonts.bold, tempColor(p.temp_c)));
          }
          if (p.temp_min_c != null && p.temp_min_c !== p.temp_c) {
            const yLo = scaleY(p.temp_min_c);
            els.push(centerText(`tl${i}`, fmtTemp(p.temp_min_c, units), cx, yLo + 11, fonts.small, tempColor(p.temp_min_c)));
          }
        });
        break;
      }

      case 'snow':
        periods.forEach((p, i) => {
          const cm = p.snow_cm ?? 0;
          const cx = colCenter(i);
          const txt = fmtSnow(cm, units);
          if (cm <= 0 || maxSnow <= 0 || !txt) { els.push(centerText(`sn${i}`, '—', cx, mid, fonts.data, C.nil)); return; }
          const base = top + row.height - 6;
          const maxBarH = row.height - 22;
          const bh = Math.max(3, (cm / maxSnow) * maxBarH);
          const bw = 22;
          els.push(<RoundedRect key={`sb${i}`} x={cx - bw / 2} y={base - bh} width={bw} height={bh} r={2} color="#9ec5e8" />);
          els.push(centerText(`sv${i}`, txt, cx, base - bh - 8, fonts.small, '#3a6ea5'));
        });
        break;

      case 'rain':
        periods.forEach((p, i) => {
          const mm = p.rain_mm ?? 0;
          const cx = colCenter(i);
          const txt = fmtRain(mm, units);
          if (mm <= 0 || maxRain <= 0 || !txt) { els.push(centerText(`rn${i}`, '—', cx, mid, fonts.data, C.nil)); return; }
          const base = top + row.height - 6;
          const maxBarH = row.height - 22;
          const bh = Math.max(3, (mm / maxRain) * maxBarH);
          const bw = 22;
          els.push(<RoundedRect key={`rb${i}`} x={cx - bw / 2} y={base - bh} width={bw} height={bh} r={2} color="#4a90d9" />);
          els.push(centerText(`rv${i}`, txt, cx, base - bh - 8, fonts.small, '#2a6bb5'));
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

      case 'cloud-total': case 'cloud-high': case 'cloud-mid': case 'cloud-low': {
        const key = (row.kind === 'cloud-total' ? 'cloud_total'
          : row.kind === 'cloud-high' ? 'cloud_high'
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
    <View style={{ height: totalH }}>
      <Animated.ScrollView
        horizontal
        bounces={false}
        showsHorizontalScrollIndicator
        scrollEventThrottle={16}
        onScroll={Animated.event(
          [{ nativeEvent: { contentOffset: { x: scrollX } } }],
          { useNativeDriver: true },
        )}
      >
        <Canvas style={{ width, height: totalH }}>{els}</Canvas>
      </Animated.ScrollView>
      <View pointerEvents="none" style={styles.stickyDayRow}>
        {dayGroups.map((group, i) => {
          const label = dayLabel(group.date);
          const textWidth = fonts.date.getTextWidth(label);
          const start = colLeft(group.start);
          const end = colLeft(group.end);
          const stickyEnd = end - textWidth - 10;
          const translateX = stickyEnd > start
            ? scrollX.interpolate({
                inputRange: [0, start, stickyEnd, width],
                outputRange: [start + 5, 5, 5, end - textWidth - 5 - width],
                extrapolate: 'extend',
              })
            : Animated.subtract(start + 5, scrollX);
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
  stickyDayRow: { position: 'absolute', top: 0, left: 0, right: 0, height: 31, overflow: 'hidden' },
  stickyDayText: { position: 'absolute', top: 4, color: C.date, fontSize: 14, fontWeight: '600', lineHeight: 24 },
  modelHeaderBar: { paddingHorizontal: 14, paddingVertical: 7 },
  modelHeaderText: { color: '#fff', fontSize: 13, fontWeight: '600' },
  sep: { height: 10, backgroundColor: '#f2f2f7' },
});
