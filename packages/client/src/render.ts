import { WMO, ARROWS, BEAUFORT, MODEL_COLORS } from "./ui-constants.js";

export type UnitSystem = "metric" | "imperial";

export interface WindCell {
  ws: number; // kph
  dir: string;
}

export interface DecodedPeriod {
  date: Date;
  wc: number;
  precip?: number;
  temp_c?: number;
  temp_min_c?: number;
  fz_m?: number;
  snow_cm?: number;
  p_sfc?: WindCell;
  p500?: WindCell;
  p600?: WindCell;
  p700?: WindCell;
  cloud_total?: number;
  cloud_high?: number;
  cloud_mid?: number;
  cloud_low?: number;
  vis_km?: number;
}

export interface ForecastView {
  label: string;
  models: string[];
  timeStep: number;
  units: UnitSystem;
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

function windCellHtml(kph: number, dir: string, colored: boolean, units: UnitSystem): CellValue {
  const arrow = ARROWS[dir] ?? "";
  const mph = kph / 1.60934;
  const label = units === "imperial"
    ? `${Math.round(mph)} mph`
    : `${Math.round(kph)} kph`;
  const inner = `<div class="wind-cell"><span class="bft-mph">${label}</span> <span style="font-size:.75rem">${dir} ${arrow}</span></div>`;
  if (!colored || !kph) return inner;
  const b = beaufort(mph);
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

function tempCells(ps: DecodedPeriod[], key: "temp_c" | "temp_min_c", units: UnitSystem): string[] {
  return ps.map((p) => {
    const c = p[key];
    if (c == null) return nilCell();
    if (units === "imperial") {
      return `<span class="fz-val">${Math.round(c * 9 / 5 + 32)}°F</span>`;
    }
    return `<span class="fz-val">${Math.round(c)}°C</span>`;
  });
}

function snowCells(ps: DecodedPeriod[], units: UnitSystem): string[] {
  return ps.map((p) => {
    if (p.snow_cm == null) return nilCell();
    if (units === "imperial") {
      const inches = Math.round(p.snow_cm / 2.54);
      return inches
        ? `<span class="snow-val">${inches}</span> <span class="snow-unit">in</span>`
        : nilCell();
    }
    const cm = Math.round(p.snow_cm);
    return cm
      ? `<span class="snow-val">${cm}</span> <span class="snow-unit">cm</span>`
      : nilCell();
  });
}

function freezeCells(ps: DecodedPeriod[], units: UnitSystem): string[] {
  return ps.map((p) => {
    if (p.fz_m == null) return nilCell();
    if (units === "imperial") {
      return `<span class="fz-val">${Math.round(p.fz_m * 3.28084).toLocaleString()}</span> <span class="snow-unit">ft</span>`;
    }
    return `<span class="fz-val">${Math.round(p.fz_m).toLocaleString()}</span> <span class="snow-unit">m</span>`;
  });
}

function cloudCells(ps: DecodedPeriod[], key: keyof DecodedPeriod): CellValue[] {
  return ps.map((p) => {
    const v = p[key] as number | undefined;
    if (v == null) return nilCell();
    const alpha = (v / 100).toFixed(2);
    return {
      style: `background:rgba(150,150,150,${alpha})`,
      html: `<span style="font-family:monospace;font-size:.85rem;font-weight:600;color:#444">${v}%</span>`,
    };
  });
}

function windCells(ps: DecodedPeriod[], key: keyof DecodedPeriod, colored: boolean, units: UnitSystem): CellValue[] {
  return ps.map((p) => {
    const w = p[key] as WindCell | undefined;
    return w != null ? windCellHtml(w.ws, w.dir, colored, units) : nilCell();
  });
}

function visCells(ps: DecodedPeriod[], units: UnitSystem): string[] {
  return ps.map((p) => {
    if (p.vis_km == null) return nilCell();
    let label: string;
    if (units === "imperial") {
      const mi = p.vis_km * 0.621371;
      label = p.vis_km >= 15 ? "≥9 mi" : `${mi < 1 ? mi.toFixed(1) : Math.round(mi)} mi`;
    } else {
      label = p.vis_km >= 15 ? "≥15 km" : `${p.vis_km} km`;
    }
    return `<span style="font-family:monospace;font-size:.85rem;font-weight:600;color:#6688aa">${label}</span>`;
  });
}

function modelBlock(ps: DecodedPeriod[], n: number, units: UnitSystem): string {
  const hasPrecip  = ps.some((p) => p.precip      != null);
  const hasTempMax = ps.some((p) => p.temp_c      != null);
  const hasTempMin = ps.some((p) => p.temp_min_c  != null);
  const hasSnow    = ps.some((p) => p.snow_cm      != null);
  const hasFreeze  = ps.some((p) => p.fz_m         != null);
  const hasSfc     = ps.some((p) => p.p_sfc        != null);
  const has500     = ps.some((p) => p.p500         != null);
  const has600     = ps.some((p) => p.p600         != null);
  const has700     = ps.some((p) => p.p700         != null);
  const hasCloudT  = ps.some((p) => p.cloud_total  != null);
  const hasCloudH  = ps.some((p) => p.cloud_high   != null);
  const hasCloudM  = ps.some((p) => p.cloud_mid    != null);
  const hasCloudL  = ps.some((p) => p.cloud_low    != null);
  const hasVis     = ps.some((p) => p.vis_km       != null);
  const hasSurface = hasPrecip || hasTempMax || hasTempMin || hasSnow || hasFreeze || hasSfc;
  const hasUpper   = has500 || has600 || has700;
  const hasCloud   = hasCloudT || hasCloudH || hasCloudM || hasCloudL || hasVis;

  const imp = units === "imperial";

  let body = row("", iconCells(ps));
  if (hasSurface) {
    body += sectionRow("Surface", n);
    if (hasPrecip)  body += row("Precip",   precipCells(ps));
    if (hasTempMax) body += row("Max temp", tempCells(ps, "temp_c", units));
    if (hasTempMin) body += row("Min temp", tempCells(ps, "temp_min_c", units));
    if (hasSnow)    body += row("Snow",     snowCells(ps, units));
    if (hasFreeze)  body += row("Freeze",   freezeCells(ps, units));
    if (hasSfc)     body += row("Wind",     windCells(ps, "p_sfc", true, units));
  }
  if (hasCloud) {
    body += sectionRow("Cloud", n);
    if (hasCloudT) body += row("Total",  cloudCells(ps, "cloud_total"));
    if (hasCloudH) body += row("High",   cloudCells(ps, "cloud_high"));
    if (hasCloudM) body += row("Mid",    cloudCells(ps, "cloud_mid"));
    if (hasCloudL) body += row("Low",    cloudCells(ps, "cloud_low"));
    if (hasVis)    body += row("Vis",    visCells(ps, units));
  }
  if (hasUpper) {
    body += sectionRow("Pressure", n);
    if (has500) body += row(`500<br><span style="font-weight:400;letter-spacing:0;opacity:.65">~${imp ? "18k ft" : "5.5k m"}</span>`, windCells(ps, "p500", true, units));
    if (has600) body += row(`600<br><span style="font-weight:400;letter-spacing:0;opacity:.65">~${imp ? "14k ft" : "4.2k m"}</span>`, windCells(ps, "p600", true, units));
    if (has700) body += row(`700<br><span style="font-weight:400;letter-spacing:0;opacity:.65">~${imp ? "10k ft" : "3k m"}</span>`,   windCells(ps, "p700", true, units));
  }
  return body;
}

export function render(fc: ForecastView): string {
  const { label, models, timeStep, units, periods } = fc;
  const primary = periods[0];
  const extras = periods.slice(1);
  const n = primary.length;

  const th = `<th class="lbl"></th>${primary.map((p) => `<th class="day-h">${periodLabel(p.date, timeStep)}</th>`).join("")}`;

  let body = "";
  if (models.length > 1) body += modelRow(models[0], n);
  body += modelBlock(primary, n, units);
  if (models.length > 1) body += sepRow(n);

  extras.forEach((ps, mi) => {
    body += modelRow(models[mi + 1], n);
    body += modelBlock(ps, n, units);
    body += sepRow(n);
  });

  return `<div class="type-badge">${label}</div>
    <div class="table-wrap"><table>
      <thead><tr>${th}</tr></thead>
      <tbody>${body}</tbody>
    </table></div>`;
}
