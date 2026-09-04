// Imperative Skia drawing for the meteogram: the scene is recorded straight into SkPictures
// rather than described as a tree of Skia elements, so a tile mount hands the canvas one node
// instead of a thousand. Everything here is what that recording needs and nothing else: colors,
// paints, parsed paths and measured text are cached because a scene draws the same few hundred
// of them thousands of times.
import {
  BlendMode, ClipOp, PaintStyle, Skia, StrokeCap, StrokeJoin, TileMode,
  type SkCanvas, type SkColor, type SkFont, type SkPaint, type SkPath, type SkPathEffect,
  type SkPoint, type SkRect, type SkShader,
} from '@shopify/react-native-skia';
import type { Prim } from './weatherGlyph';

const colors = new Map<string, SkColor>();
export function skColor(css: string): SkColor {
  let color = colors.get(css);
  if (!color) {
    color = Skia.Color(css);
    colors.set(css, color);
  }
  return color;
}

// Shared paints are never mutated after creation; a caller needing a shader or an alpha of its
// own takes a copy (see gradientPaint, dashedStroke).
const fills = new Map<string, SkPaint>();
export function fillPaint(css: string): SkPaint {
  let paint = fills.get(css);
  if (!paint) {
    paint = Skia.Paint();
    paint.setAntiAlias(true);
    paint.setColor(skColor(css));
    fills.set(css, paint);
  }
  return paint;
}

const strokes = new Map<string, SkPaint>();
export function strokePaint(
  css: string, width: number, cap: StrokeCap = StrokeCap.Butt, join: StrokeJoin = StrokeJoin.Miter,
): SkPaint {
  const key = `${css}|${width}|${cap}|${join}`;
  let paint = strokes.get(key);
  if (!paint) {
    paint = Skia.Paint();
    paint.setAntiAlias(true);
    paint.setColor(skColor(css));
    paint.setStyle(PaintStyle.Stroke);
    paint.setStrokeWidth(width);
    paint.setStrokeCap(cap);
    paint.setStrokeJoin(join);
    strokes.set(key, paint);
  }
  return paint;
}

// A paint that punches through to transparent: what a glyph's separator outline is drawn with
// inside its own layer, so a cloud reads as cut out of whatever is behind it.
const clears = new Map<string, SkPaint>();
function clearPaint(width?: number, cap: StrokeCap = StrokeCap.Butt): SkPaint {
  const key = width == null ? 'fill' : `${width}|${cap}`;
  let paint = clears.get(key);
  if (!paint) {
    paint = Skia.Paint();
    paint.setAntiAlias(true);
    paint.setBlendMode(BlendMode.Clear);
    if (width != null) {
      paint.setStyle(PaintStyle.Stroke);
      paint.setStrokeWidth(width);
      paint.setStrokeCap(cap);
      paint.setStrokeJoin(StrokeJoin.Round);
    }
    clears.set(key, paint);
  }
  return paint;
}

const dashes = new Map<string, SkPathEffect>();
export function dashEffect(intervals: number[]): SkPathEffect {
  const key = intervals.join(',');
  let effect = dashes.get(key);
  if (!effect) {
    effect = Skia.PathEffect.MakeDash(intervals);
    dashes.set(key, effect);
  }
  return effect;
}

const dashedStrokes = new Map<string, SkPaint>();
export function dashedStroke(css: string, width: number, intervals: number[], alpha = 1): SkPaint {
  const key = `${css}|${width}|${intervals.join(',')}|${alpha}`;
  let paint = dashedStrokes.get(key);
  if (!paint) {
    paint = strokePaint(css, width).copy();
    paint.setPathEffect(dashEffect(intervals));
    if (alpha !== 1) paint.setAlphaf(alpha);
    dashedStrokes.set(key, paint);
  }
  return paint;
}

export function linearGradient(start: SkPoint, end: SkPoint, stops: string[], positions: number[]): SkShader {
  return Skia.Shader.MakeLinearGradient(start, end, stops.map(skColor), positions, TileMode.Clamp);
}

// A fresh fill paint carrying a gradient. Not cached: a gradient is specific to the geometry it
// paints.
export function gradientPaint(shader: SkShader, stroke?: number): SkPaint {
  const paint = Skia.Paint();
  paint.setAntiAlias(true);
  paint.setShader(shader);
  if (stroke != null) {
    paint.setStyle(PaintStyle.Stroke);
    paint.setStrokeWidth(stroke);
  }
  return paint;
}

const svgPaths = new Map<string, SkPath>();
export function svgPath(d: string): SkPath {
  let path = svgPaths.get(d);
  if (!path) {
    const parsed = Skia.Path.MakeFromSVGString(d);
    if (!parsed) throw new Error(`invalid path: ${d}`);
    path = parsed;
    svgPaths.set(d, path);
  }
  return path;
}

const widths = new WeakMap<SkFont, Map<string, number>>();
export function textWidth(font: SkFont, text: string): number {
  let byText = widths.get(font);
  if (!byText) {
    byText = new Map();
    widths.set(font, byText);
  }
  let width = byText.get(text);
  if (width == null) {
    width = font.getTextWidth(text);
    byText.set(text, width);
  }
  return width;
}

export function drawText(canvas: SkCanvas, text: string, x: number, y: number, font: SkFont, css: string): void {
  canvas.drawText(text, x, y, fillPaint(css), font);
}

export function fillRect(canvas: SkCanvas, x: number, y: number, width: number, height: number, css: string): void {
  canvas.drawRect(Skia.XYWHRect(x, y, width, height), fillPaint(css));
}

export function drawLine(canvas: SkCanvas, x0: number, y0: number, x1: number, y1: number, paint: SkPaint): void {
  canvas.drawLine(x0, y0, x1, y1, paint);
}

// ── Weather glyphs ─────────────────────────────────────────────────────────

// A glyph's primitives resolved to Skia objects once, so stamping it down a row of columns costs
// a translate and a handful of draw calls. `recolor` is the caller's ground-aware substitution
// (a white separator becomes the strip's grey on the strip); `clip` bounds the layer the glyph
// needs when it carries separator strokes, in the same coordinates as the primitives.
export interface CompiledGlyph { draw(canvas: SkCanvas): void }

type Op = (canvas: SkCanvas) => void;

export function compileGlyph(prims: Prim[], recolor: (css: string) => string, clip: SkRect): CompiledGlyph {
  const ops: Op[] = [];
  let layered = false;
  for (const prim of prims) {
    switch (prim.kind) {
      case 'circle': {
        const paint = fillPaint(recolor(prim.fill));
        const { cx, cy, r } = prim;
        ops.push((canvas) => canvas.drawCircle(cx, cy, r, paint));
        break;
      }
      case 'line': {
        const cap = prim.cap === 'round' ? StrokeCap.Round : StrokeCap.Butt;
        const separator = prim.role === 'symbol-separator';
        layered ||= separator;
        const paint = separator ? clearPaint(prim.width, cap) : strokePaint(recolor(prim.stroke), prim.width, cap);
        const { x1, y1, x2, y2 } = prim;
        ops.push((canvas) => canvas.drawLine(x1, y1, x2, y2, paint));
        break;
      }
      case 'rrect': {
        const paint = fillPaint(recolor(prim.fill));
        const rrect = Skia.RRectXY(Skia.XYWHRect(prim.x, prim.y, prim.w, prim.h), prim.r, prim.r);
        ops.push((canvas) => canvas.drawRRect(rrect, paint));
        break;
      }
      case 'path': {
        const path = svgPath(prim.d);
        const separator = prim.role?.endsWith('separator') ?? false;
        layered ||= separator;
        if (prim.fill && prim.fill !== 'none') {
          const paint = separator ? clearPaint() : fillPaint(recolor(prim.fill));
          ops.push((canvas) => canvas.drawPath(path, paint));
        }
        if (prim.stroke && prim.stroke !== 'none') {
          const cap = prim.cap === 'round' ? StrokeCap.Round : StrokeCap.Butt;
          const paint = separator
            ? clearPaint(prim.width ?? 1, cap)
            : strokePaint(recolor(prim.stroke), prim.width ?? 1, cap, StrokeJoin.Round);
          ops.push((canvas) => canvas.drawPath(path, paint));
        }
        break;
      }
    }
  }
  if (!layered) {
    return { draw: (canvas) => { for (const op of ops) op(canvas); } };
  }
  // Separator strokes clear to transparent, so the glyph is composited through its own layer:
  // the clearing cuts the glyph, not the scene behind it.
  return {
    draw: (canvas) => {
      canvas.saveLayer();
      canvas.clipRect(clip, ClipOp.Intersect, true);
      for (const op of ops) op(canvas);
      canvas.restore();
    },
  };
}
