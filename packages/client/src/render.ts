import { WMO, ARROWS, BEAUFORT, MODEL_COLORS } from "./ui-constants.js";

export interface WindCell {
  ws: number;
  dir: string;
}

export interface DecodedPeriod {
  date: Date;
  wc: number;
  precip?: number;
  temp_f?: number;
  fz_ft?: number;
  snow?: number;
  snowUnit: number;
  p_sfc?: WindCell;
  p500?: WindCell;
  p600?: WindCell;
  p700?: WindCell;
}

export interface ForecastView {
  label: string;
  models: string[];
  timeStep: number;
  periods: DecodedPeriod[][];
}

function beaufort(mph: number): { bg: string; fg: string } {
  const i = BEAUFORT.findIndex(([t]) => mph < t);
  return { bg: BEAUFORT[i][2], fg: BEAUFORT[i][3] };
}

function wmoIcon(c: number): string {
  return (WMO[c] ?? ["", "", "❓"])[2];
}

function wmoShort(c: number): string {
  return (WMO[c] ?? ["", `wc${c}`, ""])[1];
}

function precipColor(pct: number): string {
  if (pct >= 60) return "#c04040";
  if (pct >= 30) return "#c08020";
  return "#4080c8";
}

type CellValue = string | { style: string; html: string };

function windCellHtml(ws: number, dir: string, colored: boolean): CellValue {
  const arrow = ARROWS[dir] ?? "";
  const inner = `<div class="wind-cell"><span class="bft-mph">${ws} mph</span> <span style="font-size:.75rem">${dir} ${arrow}</span></div>`;
  if (!colored || !ws) return inner;
  const b = beaufort(ws);
  return { style: `background:${b.bg};color:${b.fg}`, html: inner };
}

function nilCell(): string {
  return '<span class="nil">—</span>';
}

function periodLabel(date: Date, timeStep: number): string {
  const days = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  if (timeStep >= 24) {
    return `${days[date.getDay()]}<br><span style="font-weight:400;opacity:.7">${date.getMonth() + 1}/${date.getDate()}</span>`;
  } else if (timeStep === 1) {
    return `${String(date.getHours()).padStart(2, "0")}:00`;
  } else {
    return `${days[date.getDay()]}<br><span style="font-weight:400;opacity:.7">${date.getHours()}h</span>`;
  }
}

function row(lbl: string, cells: CellValue[], cls = ""): string {
  const tds = cells
    .map((c) => {
      if (c && typeof c === "object" && "html" in c)
        return `<td style="${c.style || ""}">${c.html}</td>`;
      return `<td>${c}</td>`;
    })
    .join("");
  return `<tr class="${cls}"><td class="lbl">${lbl}</td>${tds}</tr>`;
}

function sectionRow(lbl: string, n: number): string {
  return `<tr class="section-head"><td class="lbl">${lbl}</td>${Array(n).fill("<td></td>").join("")}</tr>`;
}

function sepRow(n: number): string {
  return `<tr class="model-sep">${Array(n + 1).fill("<td></td>").join("")}</tr>`;
}

function modelRow(name: string, n: number): string {
  const color = MODEL_COLORS[name] ?? "#666";
  return `<tr class="model-head"><td colspan="${n + 1}" style="background:${color}">${name}</td></tr>`;
}

function iconCells(ps: DecodedPeriod[]): string[] {
  return ps.map(
    (p) => `<span class="wx-icon">${wmoIcon(p.wc)}</span><div class="wx-short">${wmoShort(p.wc)}</div>`,
  );
}

function precipCells(ps: DecodedPeriod[]): string[] {
  return ps.map((p) => {
    if (p.precip == null) return nilCell();
    const c = precipColor(p.precip);
    return (
      `<div class="precip-pct" style="color:${c}">${p.precip}%</div>` +
      `<div class="precip-bar"><div class="precip-fill" style="width:${p.precip}%;background:${c}"></div></div>`
    );
  });
}

function tempCells(ps: DecodedPeriod[]): string[] {
  return ps.map((p) =>
    p.temp_f != null
      ? `<span class="fz-val">${p.temp_f}°F</span>`
      : nilCell(),
  );
}

function snowCells(ps: DecodedPeriod[]): string[] {
  return ps.map((p) => {
    if (p.snow == null) return nilCell();
    const val = p.snow * p.snowUnit;
    return val
      ? `<span class="snow-val">${val.toFixed(p.snowUnit < 1 ? 1 : 0)}</span> <span class="snow-unit">in</span>`
      : nilCell();
  });
}

function freezeCells(ps: DecodedPeriod[]): string[] {
  return ps.map((p) =>
    p.fz_ft != null
      ? `<span class="fz-val">${p.fz_ft.toLocaleString()}</span> <span class="snow-unit">ft</span>`
      : nilCell(),
  );
}

function windCells(ps: DecodedPeriod[], key: keyof DecodedPeriod, colored: boolean): CellValue[] {
  return ps.map((p) => {
    const w = p[key] as WindCell | undefined;
    return w != null ? windCellHtml(w.ws, w.dir, colored) : nilCell();
  });
}

function modelBlock(ps: DecodedPeriod[], n: number): string {
  const hasPrecip  = ps.some((p) => p.precip  != null);
  const hasTemp    = ps.some((p) => p.temp_f   != null);
  const hasSnow    = ps.some((p) => p.snow     != null);
  const hasFreeze  = ps.some((p) => p.fz_ft    != null);
  const hasSfc     = ps.some((p) => p.p_sfc    != null);
  const has500     = ps.some((p) => p.p500     != null);
  const has600     = ps.some((p) => p.p600     != null);
  const has700     = ps.some((p) => p.p700     != null);
  const hasAlt     = has500 || has600 || has700;
  const hasSurface = hasPrecip || hasTemp || hasSnow || hasFreeze || hasSfc;

  let body = row("", iconCells(ps));
  if (hasSurface) {
    body += sectionRow("Surface", n);
    if (hasPrecip) body += row("Precip",   precipCells(ps));
    if (hasTemp)   body += row("Temp",     tempCells(ps));
    if (hasSnow)   body += row("Snow",     snowCells(ps));
    if (hasFreeze) body += row("Freeze",   freezeCells(ps));
    if (hasSfc)    body += row("Sfc wind", windCells(ps, "p_sfc", true));
  }
  if (hasAlt) {
    body += sectionRow("Alt", n);
    if (has500) body += row('500<br><span style="font-weight:400;letter-spacing:0;opacity:.65">~18k ft</span>', windCells(ps, "p500", true));
    if (has600) body += row('600<br><span style="font-weight:400;letter-spacing:0;opacity:.65">~14k ft</span>', windCells(ps, "p600", true));
    if (has700) body += row('700<br><span style="font-weight:400;letter-spacing:0;opacity:.65">~10k ft</span>', windCells(ps, "p700", true));
  }
  return body;
}

export function render(fc: ForecastView): string {
  const { label, models, timeStep, periods } = fc;
  const primary = periods[0];
  const extras = periods.slice(1);
  const n = primary.length;

  const th = `<th class="lbl"></th>${primary.map((p) => `<th class="day-h">${periodLabel(p.date, timeStep)}</th>`).join("")}`;

  let body = "";
  if (models.length > 1) body += modelRow(models[0], n);
  body += modelBlock(primary, n);
  if (models.length > 1) body += sepRow(n);

  extras.forEach((ps, mi) => {
    body += modelRow(models[mi + 1], n);
    body += modelBlock(ps, n);
    body += sepRow(n);
  });

  return `<div class="type-badge">${label}</div>
    <div class="table-wrap"><table>
      <thead><tr>${th}</tr></thead>
      <tbody>${body}</tbody>
    </table></div>`;
}
