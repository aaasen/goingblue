// Renders every weather glyph (each WMO code × day/night) to a single standalone SVG for review.
// The SVG consumes the same primitives as the Skia meteogram, so this gallery is a faithful
// preview of the shipped icons. Open the .svg in a browser for native zoom + hover tooltips.
//
//   node packages/mobile/scripts/render-glyph-gallery.ts

import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { weatherGlyph, WMO_NAMES, type MoonPhase, type Prim } from '../weatherGlyph.ts';

const CODES: [number, string][] = Object.entries(WMO_NAMES)
  .map(([code, name]): [number, string] => [Number(code), name])
  .sort((a, b) => a[0] - b[0]);

const CELL = 68;      // icon cell width/height
const GAP = 10;       // gap between day and night cell
const LABEL_H = 22;
const GROUP_W = CELL * 2 + GAP;
const GROUP_H = CELL + LABEL_H;
const COLS = 4;       // code-groups per row
const PAD = 24;
const COL_GAP = 28;
const ROW_GAP = 22;
const NIGHT_BG = '#eceef3';
const HEADER_H = 112;

function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function primToSvg(p: Prim): string {
  switch (p.kind) {
    case 'circle':
      return `<circle cx="${p.cx}" cy="${p.cy}" r="${p.r}" fill="${p.fill}"/>`;
    case 'line':
      return `<line x1="${p.x1}" y1="${p.y1}" x2="${p.x2}" y2="${p.y2}" stroke="${p.stroke}" stroke-width="${p.width}" stroke-linecap="${p.cap ?? 'butt'}"/>`;
    case 'rrect':
      return `<rect x="${p.x}" y="${p.y}" width="${p.w}" height="${p.h}" rx="${p.r}" fill="${p.fill}"/>`;
    case 'path': {
      const stroke = p.stroke ? ` stroke="${p.stroke}" stroke-width="${p.width ?? 1}" stroke-linecap="${p.cap ?? 'butt'}" stroke-linejoin="round"` : '';
      return `<path d="${p.d}" fill="${p.fill ?? 'none'}"${stroke}/>`;
    }
  }
}

function cell(code: number, night: boolean, x: number, y: number): string {
  const bg = night ? NIGHT_BG : '#ffffff';
  const prims = weatherGlyph(code, night, x + CELL / 2, y + 8, CELL - 16);
  return `<g>`
    + `<rect x="${x}" y="${y}" width="${CELL}" height="${CELL}" rx="8" fill="${bg}" stroke="#e2e4ea"/>`
    + prims.map(primToSvg).join('')
    + `</g>`;
}

function group(code: number, name: string, gx: number, gy: number): string {
  return `<g><title>${code} — ${esc(name)} (left: day, right: night)</title>`
    + cell(code, false, gx, gy)
    + cell(code, true, gx + CELL + GAP, gy)
    + `<text x="${gx + GROUP_W / 2}" y="${gy + CELL + 15}" font-family="ui-sans-serif, system-ui, sans-serif" font-size="11" fill="#48484a" text-anchor="middle">${code} · ${esc(name)}</text>`
    + `</g>`;
}

function phaseSample(phase: MoonPhase, label: string, x: number, y: number): string {
  const size = 28;
  const prims = weatherGlyph(0, true, x + size / 2, y + 4, size - 8, phase);
  return `<g><rect x="${x}" y="${y}" width="${size}" height="${size}" rx="6" fill="${NIGHT_BG}" stroke="#e2e4ea"/>`
    + prims.map(primToSvg).join('')
    + `<text x="${x + size + 7}" y="${y + 18}" font-family="ui-sans-serif, system-ui, sans-serif" font-size="11" fill="#48484a">${label}</text></g>`;
}

const rows = Math.ceil(CODES.length / COLS);
const width = PAD * 2 + COLS * GROUP_W + (COLS - 1) * COL_GAP;
const height = PAD * 2 + HEADER_H + rows * GROUP_H + (rows - 1) * ROW_GAP;

let body = '';
CODES.forEach(([code, name], i) => {
  const col = i % COLS;
  const row = Math.floor(i / COLS);
  const gx = PAD + col * (GROUP_W + COL_GAP);
  const gy = PAD + HEADER_H + row * (GROUP_H + ROW_GAP);
  body += group(code, name, gx, gy);
});

const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">`
  + `<rect width="${width}" height="${height}" fill="#fafbfc"/>`
  + `<text x="${PAD}" y="${PAD + 6}" font-family="ui-sans-serif, system-ui, sans-serif" font-size="15" font-weight="600" fill="#1c1c1e">Weather glyphs — each code shown day (white) / night (shaded)</text>`
  + phaseSample('new', 'New', PAD, PAD + 18)
  + phaseSample('waxing-crescent', 'Waxing crescent', PAD + 166, PAD + 18)
  + phaseSample('first-quarter', 'First quarter', PAD + 332, PAD + 18)
  + phaseSample('waxing-gibbous', 'Waxing gibbous', PAD + 498, PAD + 18)
  + phaseSample('full', 'Full', PAD, PAD + 56)
  + phaseSample('waning-gibbous', 'Waning gibbous', PAD + 166, PAD + 56)
  + phaseSample('last-quarter', 'Last quarter', PAD + 332, PAD + 56)
  + phaseSample('waning-crescent', 'Waning crescent', PAD + 498, PAD + 56)
  + body
  + `</svg>`;

const outDir = dirname(fileURLToPath(import.meta.url));
const outPath = join(outDir, 'weather-glyphs.svg');
writeFileSync(outPath, svg);
console.log(`Wrote ${outPath} (${width}×${height})`);
