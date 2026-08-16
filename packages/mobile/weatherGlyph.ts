// Renderer-agnostic weather glyph geometry.
//
// weatherGlyph() turns a WMO weather code + day/night flag + moon phase into a flat list of drawing
// primitives (circles, lines, rounded rects, SVG-path strings). It imports nothing from Skia
// or React, so the same geometry feeds two adapters: the Skia scene graph in the meteogram, and
// a standalone SVG gallery used to review the icon set. Both renderers consume identical
// primitives, so what you review in the gallery is what ships.

export type Prim =
  | { kind: 'circle'; cx: number; cy: number; r: number; fill: string }
  | {
      kind: 'line';
      x1: number;
      y1: number;
      x2: number;
      y2: number;
      stroke: string;
      width: number;
      cap?: 'round' | 'butt';
      role?: 'symbol-separator';
    }
  | { kind: 'rrect'; x: number; y: number; w: number; h: number; r: number; fill: string }
  | {
      kind: 'path';
      d: string;
      fill?: string;
      stroke?: string;
      width?: number;
      cap?: 'round' | 'butt';
      role?: 'cloud-separator' | 'symbol-separator';
    };

// ── Palette ──────────────────────────────────────────────────────────────--

const SUN = '#f5a623';
const SUN_RAY = '#f5a623';
const PARTLY_CLOUD = '#a5a5a6';
const MOON_LIGHT = '#edd6a0';
const MOON_LIGHT_DARK = '#d7ba87';
const MOON_LIGHT_HIGHLIGHT = '#f5e3ae';
const MOON_SHADOW = '#666570';
const MOON_SHADOW_LIGHT = '#777681';
const MOON_SHADOW_DARK = '#595864';
const MOON_RIM = '#77737c';
const RAIN = '#29a0ee';
const FLAKE = '#a0cee8';
const GRAIN = '#aeb9c9';
const BOLT = '#f4b400';
const FOG = '#aeb7c5';
const NIGHT_BACKGROUND = '#eceef3';
// Keep both layers monochrome so overlapping clouds read as one soft silhouette.
const CLOUD_BACK = '#a5a5a6';
const CLOUD_FRONT = '#a5a5a6';

// ── Weather code classification ──────────────────────────────────────────--

const SNOW_CODES = new Set([71, 73, 75, 85, 86]);
const SLEET_CODES = new Set([56, 57, 66, 67]); // freezing drizzle / freezing rain
const MIX_CODES = new Set([68, 69]);           // rain and snow together (server-synthesized)
const GRAIN_CODES = new Set([77]);
const DRIZZLE_CODES = new Set([51, 53, 55, 56, 57]);
const SHOWER_CODES = new Set([80, 81, 82, 85, 86]);

type Precip = 'rain' | 'snow' | 'sleet' | 'mix' | 'grains' | null;
export type MoonPhase =
  | 'new'
  | 'waxing-crescent'
  | 'first-quarter'
  | 'waxing-gibbous'
  | 'full'
  | 'waning-gibbous'
  | 'last-quarter'
  | 'waning-crescent'
  // Backward-compatible aliases from the initial phase implementation.
  | 'quarter'
  | 'crescent';
type Spec = {
  sky: 'clear' | 'partly' | 'overcast';
  fog: boolean;
  rime: boolean;
  precip: Precip;
  intensity: 1 | 2 | 3;
  drizzle: boolean;
  shower: boolean;
  thunder: boolean;
  hail: boolean;
  cloudScale: number; // relative cloud size for partly skies (mainly-clear < partly cloudy)
};

function intensity(code: number): 1 | 2 | 3 {
  if ([51, 56, 61, 66, 68, 71, 80, 85, 96].includes(code)) return 1;
  if ([53, 63, 73, 81].includes(code)) return 2;
  if ([55, 57, 65, 67, 69, 75, 82, 86, 99].includes(code)) return 3;
  return 2;
}

export function glyphSpec(code: number): Spec {
  const base: Spec = { sky: 'overcast', fog: false, rime: false, precip: null, intensity: 2, drizzle: false, shower: false, thunder: false, hail: false, cloudScale: 1 };
  if (code === 0) return { ...base, sky: 'clear' };
  if (code === 1) return { ...base, sky: 'partly', cloudScale: 0.68 }; // mainly clear: small cloud
  if (code === 2) return { ...base, sky: 'partly' };
  if (code === 3) return { ...base, sky: 'overcast' };
  if (code === 45 || code === 48) return { ...base, fog: true, rime: code === 48 };

  const shower = SHOWER_CODES.has(code);
  const thunder = code >= 95;
  const hail = code === 96 || code === 99;
  let precip: Precip = 'rain';
  if (SNOW_CODES.has(code)) precip = 'snow';
  else if (SLEET_CODES.has(code)) precip = 'sleet';
  else if (MIX_CODES.has(code)) precip = 'mix';
  else if (GRAIN_CODES.has(code)) precip = 'grains';

  return {
    ...base,
    sky: shower ? 'partly' : 'overcast',
    precip,
    intensity: intensity(code),
    drizzle: DRIZZLE_CODES.has(code),
    shower,
    thunder,
    hail,
  };
}

// ── Human-readable WMO code names ──────────────────────────────────────────

export const WMO_NAMES: Record<number, string> = {
  0: 'Clear', 1: 'Mainly clear', 2: 'Partly cloudy', 3: 'Overcast',
  45: 'Fog', 48: 'Rime fog',
  51: 'Light drizzle', 53: 'Drizzle', 55: 'Dense drizzle',
  56: 'Freezing drizzle', 57: 'Dense freezing drizzle',
  61: 'Light rain', 63: 'Rain', 65: 'Heavy rain',
  66: 'Freezing rain', 67: 'Heavy freezing rain',
  68: 'Rain and snow', 69: 'Heavy rain and snow',
  71: 'Light snow', 73: 'Snow', 75: 'Heavy snow', 77: 'Snow grains',
  80: 'Light showers', 81: 'Showers', 82: 'Violent showers',
  85: 'Snow showers', 86: 'Heavy snow showers',
  95: 'Thunderstorm', 96: 'Thunderstorm with hail', 99: 'Thunderstorm with heavy hail',
};

export function wmoName(code: number): string {
  return WMO_NAMES[code] ?? `Code ${code}`;
}

// ── Geometry helpers ───────────────────────────────────────────────────────

const f = (n: number) => Math.round(n * 100) / 100;

function sun(out: Prim[], cx: number, cy: number, r: number) {
  for (let a = 0; a < 12; a++) {
    const ang = (a * Math.PI) / 6;
    out.push({
      kind: 'line',
      x1: cx + Math.cos(ang) * (r + 3), y1: cy + Math.sin(ang) * (r + 3),
      x2: cx + Math.cos(ang) * (r + 6), y2: cy + Math.sin(ang) * (r + 6),
      stroke: SUN_RAY, width: 1.7, cap: 'round',
    });
  }
  out.push({ kind: 'circle', cx, cy, r, fill: SUN });
}

function moonDiscPath(cx: number, cy: number, r: number): string {
  return `M ${f(cx)} ${f(cy - r)} A ${f(r)} ${f(r)} 0 1 1 ${f(cx)} ${f(cy + r)} A ${f(r)} ${f(r)} 0 1 1 ${f(cx)} ${f(cy - r)} Z`;
}

// One illuminated side of the lunar disc. Positive terminator values create a
// narrow crescent; negative values create the broad face of a gibbous moon.
function moonSidePath(cx: number, cy: number, r: number, side: 'left' | 'right', terminator: number): string {
  const sweep = side === 'right' ? 1 : 0;
  const tx = cx + (side === 'right' ? 1 : -1) * r * terminator;
  return `M ${f(cx)} ${f(cy - r)} A ${f(r)} ${f(r)} 0 0 ${sweep} ${f(cx)} ${f(cy + r)} `
    + `C ${f(tx)} ${f(cy + r * 0.55)} ${f(tx)} ${f(cy - r * 0.55)} ${f(cx)} ${f(cy - r)} Z`;
}

function moon(out: Prim[], cx: number, cy: number, r: number, phase: MoonPhase) {
  const disc = moonDiscPath(cx, cy, r);
  const canonical = phase === 'quarter' ? 'last-quarter' : phase === 'crescent' ? 'waning-crescent' : phase;
  const litSide: { side: 'left' | 'right'; terminator: number } | null =
    canonical === 'waxing-crescent' ? { side: 'right', terminator: 0.72 }
      : canonical === 'first-quarter' ? { side: 'right', terminator: 0.28 }
        : canonical === 'waxing-gibbous' ? { side: 'right', terminator: -0.72 }
          : canonical === 'waning-gibbous' ? { side: 'left', terminator: -0.72 }
            : canonical === 'last-quarter' ? { side: 'left', terminator: 0.28 }
              : canonical === 'waning-crescent' ? { side: 'left', terminator: 0.72 }
                : null;

  // Earthshine remains visible on every phase, including the new moon.
  out.push({ kind: 'path', d: disc, fill: MOON_SHADOW });
  out.push({ kind: 'circle', cx: cx - r * 0.34, cy: cy - r * 0.34, r: r * 0.17, fill: MOON_SHADOW_LIGHT });
  out.push({ kind: 'circle', cx: cx + r * 0.28, cy: cy - r * 0.2, r: r * 0.13, fill: MOON_SHADOW_DARK });
  out.push({ kind: 'circle', cx: cx + r * 0.15, cy: cy + r * 0.38, r: r * 0.2, fill: MOON_SHADOW_DARK });

  if (canonical === 'full') {
    out.push({ kind: 'path', d: disc, fill: MOON_LIGHT });
  } else if (litSide) {
    out.push({ kind: 'path', d: moonSidePath(cx, cy, r, litSide.side, litSide.terminator), fill: MOON_LIGHT });
  }

  const lightCraters = [
    { x: -0.34, y: -0.34, radius: 0.14, fill: MOON_LIGHT_HIGHLIGHT },
    { x: 0.3, y: -0.18, radius: 0.11, fill: MOON_LIGHT_DARK },
    { x: 0.12, y: 0.38, radius: 0.18, fill: MOON_LIGHT_DARK },
  ];
  for (const crater of lightCraters) {
    const curve = litSide ? litSide.terminator * (1 - crater.y * crater.y) : 0;
    const safelyLit = canonical === 'full'
      || !!litSide && (litSide.side === 'right'
        ? crater.x - crater.radius >= curve
        : crater.x + crater.radius <= -curve);
    if (safelyLit) {
      out.push({
        kind: 'circle',
        cx: cx + r * crater.x,
        cy: cy + r * crater.y,
        r: r * crater.radius,
        fill: crater.fill,
      });
    }
  }

  out.push({ kind: 'path', d: disc, fill: 'none', stroke: MOON_RIM, width: 0.6, cap: 'round' });
}

// The measured foreground contour from the 122×82 reference cloud.
// cx = horizontal center, by = bottom y.
function cloudPath(cx: number, by: number, w: number, h: number): string {
  const x = cx - w / 2;
  const P = (fx: number, fy: number) => `${f(x + fx * w)} ${f(by - fy * h)}`;
  return [
    `M ${P(0.447, 1)}`,
    `C ${P(0.549, 1)} ${P(0.639, 0.902)} ${P(0.656, 0.744)}`,
    `C ${P(0.713, 0.805)} ${P(0.82, 0.793)} ${P(0.902, 0.707)}`,
    `C ${P(0.967, 0.634)} ${P(1, 0.512)} ${P(1, 0.39)}`,
    `C ${P(1, 0.171)} ${P(0.902, 0)} ${P(0.795, 0)}`,
    `L ${P(0.172, 0)}`,
    `C ${P(0.074, 0)} ${P(0, 0.146)} ${P(0, 0.329)}`,
    `C ${P(0, 0.5)} ${P(0.082, 0.61)} ${P(0.23, 0.659)}`,
    `C ${P(0.221, 0.817)} ${P(0.311, 1)} ${P(0.447, 1)} Z`,
  ].join(' ');
}

// A swept raindrop like the reference artwork: its tip leans upper-right while the
// weight of the drop sits lower-left in a full, rounded base.
function dropPath(cx: number, tipY: number, w: number, h: number): string {
  const tipX = cx + w;
  const bodyCy = tipY + h - w;
  return `M ${f(tipX)} ${f(tipY)} `
    + `C ${f(tipX)} ${f(tipY + h * 0.36)} ${f(cx + w)} ${f(bodyCy - w * 0.35)} ${f(cx + w)} ${f(bodyCy)} `
    + `A ${f(w)} ${f(w)} 0 1 1 ${f(cx - w)} ${f(bodyCy)} `
    + `C ${f(cx - w)} ${f(bodyCy - w * 0.5)} ${f(cx + w * 0.12)} ${f(tipY + h * 0.22)} ${f(tipX)} ${f(tipY)} Z`;
}

function outlinedDrop(out: Prim[], cx: number, tipY: number, w: number, h: number, separator: string) {
  const d = dropPath(cx, tipY, w, h);
  out.push({ kind: 'path', d, fill: separator, stroke: separator, width: 2.2, cap: 'round', role: 'symbol-separator' });
  out.push({ kind: 'path', d, fill: RAIN });
}

type Seg = { x1: number; y1: number; x2: number; y2: number };

// Reference snowflake geometry: six rounded spokes, each ending in a three-spike fork (the main
// tip plus two side spikes angled toward it). Grouped by spoke, since the mixed precip mark leaves
// two of them out to clear room for its drop. Spoke a points at −90° + a·60°, so a=0 is straight
// up and the indices run clockwise from there.
function flakeSpokes(cx: number, cy: number, r: number): Seg[][] {
  return Array.from({ length: 6 }, (_, a) => {
    const ang = -Math.PI / 2 + (a * Math.PI) / 3;
    const ux = Math.cos(ang), uy = Math.sin(ang);
    const branchX = cx + ux * r * 0.62;
    const branchY = cy + uy * r * 0.62;
    const segments: Seg[] = [{ x1: cx, y1: cy, x2: cx + ux * r, y2: cy + uy * r }];

    for (const turn of [-1, 1]) {
      const branchAng = ang + turn * Math.PI / 3;
      segments.push({
        x1: branchX,
        y1: branchY,
        x2: branchX + Math.cos(branchAng) * r * 0.36,
        y2: branchY + Math.sin(branchAng) * r * 0.36,
      });
    }
    return segments;
  });
}

const flakeSegments = (cx: number, cy: number, r: number): Seg[] => flakeSpokes(cx, cy, r).flat();

const flakeLineWidth = (r: number) => Math.max(0.9, r * 0.18);

function flake(out: Prim[], cx: number, cy: number, r: number, separator = '#ffffff') {
  const lineWidth = flakeLineWidth(r);
  const halo = 0.7;
  const segments = flakeSegments(cx, cy, r);

  for (const segment of segments) {
    out.push({
      kind: 'line',
      ...segment,
      stroke: separator,
      width: lineWidth + halo * 2,
      cap: 'round',
      role: 'symbol-separator',
    });
  }
  for (const segment of segments) {
    out.push({ kind: 'line', ...segment, stroke: FLAKE, width: lineWidth, cap: 'round' });
  }
}

export type PrecipMarkKind = 'rain' | 'snow' | 'mix';

// Proportions of a drop in the icon set: half-width 3.5 against height 12.6. Shrinking a drop on
// this ratio keeps it looking like the set's drop rather than a bead or a spike.
const DROP_ASPECT = 3.5 / 12.6;
// A mixed mark keeps both symbols at full size: the flake gives up its right, bottom-right and
// bottom spokes, and the drop takes the wedge they vacate. Sharing one footprint this way beats
// shrinking both to stand side by side — each stays as large as a lone mark — and the three
// surviving arms still carry the flake's six-fold geometry.
const MIX_CUT_SPOKES = new Set([1, 2, 3]); // −30° (right), +30° (bottom right), +90° (bottom)
const MIX_DROP_H = 0.70;   // of h
// Offset of the drop's center from the flake's, out along the vacated wedge's 30° bisector. The
// surviving arms all point up or left, so nothing reaches into the drop's quarter.
const MIX_DROP_DX = 0.26;  // of h, right of center
const MIX_DROP_DY = 0.15;  // of h, below center
// The drop carries a ground-colored outline so that where it does meet an arm the two stay
// separate rather than merging into one blob.
const MIX_SEAM = 0.10;     // of h

const flakePrims = (cx: number, cy: number, r: number, color: string): Prim[] =>
  flakeSegments(cx, cy, r).map((segment) => ({
    kind: 'line' as const, ...segment, stroke: color, width: flakeLineWidth(r), cap: 'round' as const,
  }));

const dropPathAt = (cx: number, cy: number, h: number): string =>
  dropPath(cx, cy - h / 2, h * DROP_ASPECT, h);

// A bare precipitation mark — a drop, a flake, or both — with no cloud behind it, for bands too
// short to carry a full glyph. The geometry is the same drop and flake that live inside the full
// icons, so the two read as one set; what's dropped is the separator halo, since these are drawn
// on flat ground with nothing behind them to punch out of. `h` is the mark's total height. Colors
// are the caller's to pick rather than the icon set's rain blue and flake blue: these are used at
// sizes and densities where full saturation shouts, so the caller usually wants them muted into
// their ground. `ground` is that background — the mixed mark strokes it around its drop to hold
// the drop off the flake's arms, so it has to match what the mark is drawn on.
export function precipMark(
  kind: PrecipMarkKind, cx: number, cy: number, h: number,
  colors: { rain: string; snow: string; ground: string },
): Prim[] {
  if (kind === 'snow') return flakePrims(cx, cy, h / 2, colors.snow);
  if (kind === 'rain') return [{ kind: 'path', d: dropPathAt(cx, cy, h), fill: colors.rain }];

  const r = h / 2;
  const lineWidth = flakeLineWidth(r);
  const d = dropPathAt(cx + h * MIX_DROP_DX, cy + h * MIX_DROP_DY, h * MIX_DROP_H);
  return [
    ...flakeSpokes(cx, cy, r)
      .filter((_, spoke) => !MIX_CUT_SPOKES.has(spoke))
      .flat()
      .map((seg): Prim => ({ kind: 'line', ...seg, stroke: colors.snow, width: lineWidth, cap: 'round' })),
    { kind: 'path', d, fill: colors.ground, stroke: colors.ground, width: h * MIX_SEAM, cap: 'round' },
    { kind: 'path', d, fill: colors.rain },
  ];
}

// A cloud with a surface-matched halo, so it reads as a distinct shape when it overlaps the
// sun/moon without introducing an opaque white patch on night surfaces.
function cloudWithHalo(out: Prim[], cx: number, by: number, w: number, h: number, fill: string, night: boolean) {
  const d = cloudPath(cx, by, w, h);
  const separator = night ? NIGHT_BACKGROUND : '#ffffff';
  out.push({ kind: 'path', d, fill: separator, stroke: separator, width: 7, cap: 'round', role: 'cloud-separator' });
  out.push({ kind: 'path', d, fill, stroke: fill, width: 3, cap: 'round' });
}

// Reference front/rear scale and offset. The rear cloud remains a complete, natural
// silhouette; a narrow underlay around the foreground creates the separation between them.
function layeredCloud(out: Prim[], cx: number, by: number, h: number, night: boolean) {
  const scale = h / 82;
  const rear = cloudPath(cx - 39 * scale, by - 45 * scale, 78 * scale, 55 * scale);
  const front = cloudPath(cx + 14 * scale, by, 122 * scale, h);
  const separator = night ? NIGHT_BACKGROUND : '#ffffff';
  out.push({ kind: 'path', d: rear, fill: CLOUD_BACK });
  out.push({ kind: 'path', d: front, fill: separator, stroke: separator, width: 3.2, cap: 'round', role: 'cloud-separator' });
  out.push({ kind: 'path', d: front, fill: CLOUD_FRONT });
}

function drawPrecip(out: Prim[], cx: number, cloudBottom: number, s: Spec, night: boolean) {
  if (s.precip === 'rain') {
    const n = s.intensity + 1; // 2, 3, or 4 drops
    const layouts = n === 2
      ? [
          { x: -3.75, tip: -8.85, w: 3.5, h: 12.35 },
          { x: 4, tip: -3.75, w: 2.4, h: 9.4 },
        ]
      : n === 3
        ? [
            { x: -7, tip: -4, w: 2.8, h: 10.2 },
            { x: 0, tip: -8.85, w: 3.5, h: 12.35 },
            { x: 7, tip: -3, w: 2.4, h: 9.4 },
          ]
        : [
            { x: -9.5, tip: -3, w: 2.5, h: 9.2 },
            { x: -3.2, tip: -8, w: 3.2, h: 11.5 },
            { x: 3.2, tip: -2, w: 2.3, h: 8.5 },
            { x: 9.5, tip: -5, w: 2.7, h: 10 },
          ];
    const drizzleScale = s.drizzle ? 0.64 : 1;
    // Tighten the two light-drizzle drops more than the three drizzle drops;
    // dense drizzle keeps its original spacing so the separator outlines never touch.
    const spacingScale = s.drizzle ? (n === 2 ? 0.88 : n === 3 ? 0.95 : 1) : 1;
    const left = Math.min(...layouts.map((drop) => drop.x * spacingScale - drop.w * drizzleScale));
    const right = Math.max(...layouts.map((drop) => drop.x * spacingScale + drop.w * drizzleScale));
    const layoutDx = -(left + right) / 2;
    const separator = night ? NIGHT_BACKGROUND : '#ffffff';
    const rainAnchor = cloudBottom + 2;
    for (const drop of layouts) {
      const smallDrizzleLift = s.drizzle && n === 2 && drop.w < 3 ? 1.2 : 0;
      outlinedDrop(
        out,
        cx + layoutDx + drop.x * spacingScale,
        rainAnchor + drop.tip * drizzleScale - smallDrizzleLift,
        drop.w * drizzleScale,
        drop.h * drizzleScale,
        separator,
      );
    }
  } else if (s.precip === 'snow') {
    const separator = night ? NIGHT_BACKGROUND : '#ffffff';
    if (s.intensity === 1) {
      flake(out, cx - 3.8, cloudBottom, 3.6, separator);
      flake(out, cx + 4.2, cloudBottom + 1, 3.2, separator);
    } else if (s.intensity === 2) {
      flake(out, cx - 4.2, cloudBottom, 5.8, separator);
      flake(out, cx + 5.8, cloudBottom - 1, 4.2, separator);
    } else {
      flake(out, cx - 8.9, cloudBottom + 1, 4.2, separator);
      flake(out, cx - 0.9, cloudBottom, 6.4, separator);
      flake(out, cx + 8.6, cloudBottom - 1, 4.5, separator);
    }
  } else if (s.precip === 'sleet') {
    const separator = night ? NIGHT_BACKGROUND : '#ffffff';
    const weight = (s.intensity === 1 ? 0.82 : 1) * (s.drizzle ? 0.82 : 1);
    const flakeRadius = 7.2 * weight;
    const flakeLineWidth = Math.max(0.9, flakeRadius * 0.18);
    const flakeOuterHalf = Math.cos(Math.PI / 6) * flakeRadius + (flakeLineWidth + 1.4) / 2;
    const largeDropH = 12.6 * weight;
    const largeDropW = 3.5 * weight;
    const dropOuterHalf = largeDropW + 1.1;
    const symbolGap = 0.8;
    const flakeX = cx - dropOuterHalf - symbolGap / 2;
    const largeDropX = cx + flakeOuterHalf + symbolGap / 2;
    flake(out, flakeX, cloudBottom, flakeRadius, separator);
    outlinedDrop(out, largeDropX, cloudBottom + 4 - largeDropH, largeDropW, largeDropH, separator);
  } else if (s.precip === 'mix') {
    // Rain and snow falling together. The flake gives up its right, bottom-right and bottom
    // spokes and the drop nests into the wedge they vacate — the same shared footprint
    // precipMark('mix') uses for the bare strip marks, so the two read as one set. Deliberately
    // NOT the 'sleet' treatment (flake and drop standing side by side): freezing rain is ice on
    // the rock and a wintry mix is slush, and they must not draw the same glyph.
    const separator = night ? NIGHT_BACKGROUND : '#ffffff';
    const r = s.intensity === 1 ? 6.4 : 7.6;
    const h = r * 2;
    // Hang the composite below the cloud the way the snow and sleet marks do. Centering the flake
    // on cloudBottom (as a lone flake is) buries it in the cloud's lower lobe here, because the
    // drop occupies the wedge that would otherwise balance it — so drop the whole mark and nudge
    // it left, the flake's surviving arms all pointing up and left.
    const markCx = cx - r * 0.18;
    const cy = cloudBottom + r * 0.5;
    const lineWidth = flakeLineWidth(r);
    const halo = 0.7;
    const segments = flakeSpokes(markCx, cy, r)
      .filter((_, spoke) => !MIX_CUT_SPOKES.has(spoke))
      .flat();
    for (const segment of segments) {
      out.push({
        kind: 'line', ...segment, stroke: separator, width: lineWidth + halo * 2,
        cap: 'round', role: 'symbol-separator',
      });
    }
    for (const segment of segments) {
      out.push({ kind: 'line', ...segment, stroke: FLAKE, width: lineWidth, cap: 'round' });
    }
    const dropH = h * MIX_DROP_H;
    outlinedDrop(
      out,
      markCx + h * MIX_DROP_DX,
      cy + h * MIX_DROP_DY - dropH / 2,
      dropH * DROP_ASPECT,
      dropH,
      separator,
    );
  } else if (s.precip === 'grains') {
    for (let i = -1; i <= 1; i++) {
      out.push({ kind: 'circle', cx: cx + i * 6, cy: cloudBottom + 4 + (i % 2 ? 2 : 0), r: 1.3, fill: FLAKE });
    }
  }
}

function bolt(out: Prim[], cx: number, cy: number, separator: string) {
  const d = `M ${f(cx + 2)} ${f(cy - 2)} L ${f(cx - 4)} ${f(cy + 7)} L ${f(cx - 0.5)} ${f(cy + 7)} `
    + `L ${f(cx - 3)} ${f(cy + 15)} L ${f(cx + 5)} ${f(cy + 4)} L ${f(cx + 1)} ${f(cy + 4)} Z`;
  out.push({ kind: 'path', d, fill: separator, stroke: separator, width: 2.2, cap: 'round', role: 'symbol-separator' });
  out.push({ kind: 'path', d, fill: BOLT });
}

function fog(out: Prim[], cx: number, cy: number, rime: boolean, night: boolean) {
  const lines = rime
    ? [
        { y: -8, left: -14, right: 13 },
        { y: -1, left: -10, right: 7 },
        { y: 6, left: -14, right: 3 },
      ]
    : [
        { y: -9, left: -14, right: 14 },
        { y: -3, left: -11, right: 11 },
        { y: 3, left: -14, right: 14 },
        { y: 9, left: -11, right: 11 },
      ];

  for (const line of lines) {
    out.push({
      kind: 'line',
      x1: cx + line.left,
      y1: cy + line.y,
      x2: cx + line.right,
      y2: cy + line.y,
      stroke: FOG,
      width: 2.4,
      cap: 'round',
    });
  }

  if (rime) flake(out, cx + 10, cy + 7, 3.5, night ? NIGHT_BACKGROUND : '#ffffff');
}

// ── Composition ────────────────────────────────────────────────────────────

// Emit the glyph for `code` centered horizontally on `cx`, vertically within [top, top+h].
export function weatherGlyph(
  code: number,
  night: boolean,
  cx: number,
  top: number,
  h: number,
  moonPhase: MoonPhase = 'full',
): Prim[] {
  const s = glyphSpec(code);
  const cy = top + h / 2;
  const out: Prim[] = [];

  if (s.fog) {
    fog(out, cx + (s.rime ? 0.75 : 0), cy - (s.rime ? 0.5 : 0), s.rime, night);
    return out;
  }

  if (s.sky === 'clear') {
    if (night) moon(out, cx, cy - 1, 8.5, moonPhase);
    else sun(out, cx, cy - 1, 9);
    return out;
  }

  const cloudH = 22;

  // Partly cloudy and showers: the same 12-spoke sun (or phased moon) tucked behind a gray cloud
  // that occludes its lower-right. The cloud is drawn on top, so it hides part of the celestial body.
  if (s.sky === 'partly') {
    const scale = s.cloudScale;
    const layoutDx = (1 - scale) * 9.4;
    const sunCx = cx - 8 + layoutDx, sunCy = cy - 1;
    if (night) moon(out, sunCx, sunCy, 8.5, moonPhase);
    else sun(out, sunCx, sunCy, 9);
    const cloudCx = cx + 6 - (1 - scale) * 4 + layoutDx; // a smaller cloud tucks in closer to the sun
    const cloudBottom = cy + 13;
    cloudWithHalo(out, cloudCx, cloudBottom, 34 * scale, 20 * scale, PARTLY_CLOUD, night);
    if (s.precip) {
      drawPrecip(out, cloudCx, cloudBottom, s, night);
    }
    return out;
  }

  // Overcast and steady precip: layered double cloud.
  const groupCx = cx + 0.5;
  const cloudBottom = cy + 13;
  const frontCloudCx = groupCx + 14 * cloudH / 82;
  layeredCloud(out, groupCx, cloudBottom, cloudH, night);

  if (s.thunder) {
    const separator = night ? NIGHT_BACKGROUND : '#ffffff';
    const stormCenter = frontCloudCx;
    const stormAnchor = cloudBottom - 7;
    outlinedDrop(out, stormCenter - 6, cloudBottom - 8.6, 3.5, 12.6, separator);
    bolt(out, stormCenter + 4, stormAnchor, separator);
    if (s.hail) {
      const stones = s.intensity === 3
        ? [{ x: -11, y: cloudBottom + 11 }, { x: 0, y: cloudBottom + 13 }, { x: 11, y: cloudBottom + 11 }]
        : [{ x: -9, y: cloudBottom + 11.5 }, { x: 9, y: cloudBottom + 11.5 }];
      const radius = s.intensity === 3 ? 2 : 1.5;
      for (const stone of stones) {
        out.push({ kind: 'circle', cx: stormCenter + stone.x, cy: stone.y, r: radius, fill: GRAIN });
      }
    }
  } else if (s.precip) {
    drawPrecip(out, frontCloudCx, cloudBottom, s, night);
  }

  return out;
}
