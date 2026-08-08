/**
 * Render the corpus location registry to a zoomable SVG world map.
 *
 * Reads LOCATIONS (locations.ts — favorites + the committed stratified sample), so it works
 * without the corpus DB and always reflects the registry as committed. One dot per site,
 * colored by climate group (Köppen letter, ocean, favorites); native browser zoom keeps it
 * crisp and each dot carries a <title> hover tooltip (name/class, coordinates, split).
 *
 * Basemap: Natural Earth 110m admin-0 countries (greyscale land + borders, no labels),
 * cached at data/ne_110m_admin_0_countries.geojson and downloaded on first run. The
 * equirectangular projection is a direct lat/lon mapping, so basemap and dots register
 * exactly. Colors adapt to light/dark via prefers-color-scheme.
 *
 * Output lands in docs/ (tracked, unlike data/) because the README embeds it — regenerate after
 * the registry changes so the committed map matches.
 *
 *   node packages/codec-server/scripts/corpus-map.ts [out.svg]   # default: docs/corpus-map.svg
 */
import { existsSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { REPO_ROOT } from "./corpus-db.ts";
import { LOCATIONS, type Location } from "./locations.ts";

const GEO_PATH = join(REPO_ROOT, "data", "ne_110m_admin_0_countries.geojson");
const GEO_URL =
  "https://raw.githubusercontent.com/nvkelso/natural-earth-vector/master/geojson/ne_110m_admin_0_countries.geojson";
const OUT_PATH = process.argv[2] ?? join(REPO_ROOT, "docs", "corpus-map.svg");

// Categorical palette (validated light/dark pair per slot), assigned in fixed order.
const GROUPS = [
  { label: "Tropical (A)", light: "#2a78d6", dark: "#3987e5" },
  { label: "Arid (B)", light: "#008300", dark: "#008300" },
  { label: "Temperate (C)", light: "#e87ba4", dark: "#d55181" },
  { label: "Continental (D)", light: "#eda100", dark: "#c98500" },
  { label: "Polar (E)", light: "#1baf7a", dark: "#199e70" },
  { label: "Ocean", light: "#eb6834", dark: "#d95926" },
  { label: "Favorites", light: "#4a3aa7", dark: "#9085e9" },
];

const KOPPEN_NAMES: Record<string, string> = {
  Af: "Tropical rainforest", Am: "Tropical monsoon", Aw: "Tropical savanna",
  BWh: "Hot desert", BWk: "Cold desert", BSh: "Hot steppe", BSk: "Cold steppe",
  Cfa: "Humid subtropical", Cfb: "Oceanic", Cfc: "Subpolar oceanic",
  Csa: "Hot-summer Mediterranean", Csb: "Warm-summer Mediterranean", Csc: "Cold-summer Mediterranean",
  Cwa: "Monsoon subtropical", Cwb: "Subtropical highland", Cwc: "Cold subtropical highland",
  Dfa: "Hot-summer humid continental", Dfb: "Warm-summer humid continental",
  Dfc: "Subarctic", Dfd: "Extreme subarctic",
  Dsa: "Hot dry-summer continental", Dsb: "Warm dry-summer continental",
  Dsc: "Dry-summer subarctic", Dsd: "Extreme dry-summer subarctic",
  Dwa: "Monsoon hot continental", Dwb: "Monsoon warm continental",
  Dwc: "Monsoon subarctic", Dwd: "Extreme monsoon subarctic",
  EF: "Ice cap", ET: "Tundra",
};

const SC = 4; // px per degree
const W = 360 * SC;
const H = 180 * SC;
const HDR = 78; // header band height
const TOT = H + HDR + 14;

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const x = (lon: number) => ((lon + 180) * SC).toFixed(1);
const y = (lat: number) => (HDR + (90 - lat) * SC).toFixed(1);
const fmtLat = (v: number) => (v === 0 ? "0°" : Math.abs(v) + "°" + (v > 0 ? "N" : "S"));
const fmtLon = (v: number) => (v === 0 ? "0°" : Math.abs(v) + "°" + (v > 0 ? "E" : "W"));
const count = (n: number) => n.toLocaleString("en-US");

function groupIndex(l: Location): number {
  if (l.stratum === "koppen") {
    const gi = "ABCDE".indexOf((l.koppen ?? "")[0] ?? "");
    if (gi < 0) throw new Error(`unclassified koppen site ${l.id}: ${l.koppen}`);
    return gi;
  }
  return l.stratum === "ocean" ? 5 : 6;
}

function tooltip(l: Location): string {
  const parts: string[] = [];
  if (l.stratum === "favorites") parts.push(l.name);
  const cls =
    l.stratum === "ocean" ? "Ocean"
    : l.stratum === "peaks" ? `Peak probe (${l.elev_m} m)`
    : `${l.koppen} ${KOPPEN_NAMES[l.koppen ?? ""] ?? ""}`.trim();
  parts.push(l.stratum === "favorites" ? "Favorites" : cls);
  parts.push(
    `${Math.abs(l.lat).toFixed(2)}°${l.lat >= 0 ? "N" : "S"}, ` +
      `${Math.abs(l.lon).toFixed(2)}°${l.lon >= 0 ? "E" : "W"}`,
  );
  parts.push(l.split === "eval" ? "eval" : "train");
  return parts.join(" · ");
}

type Ring = [number, number][];

async function countryRings(): Promise<Ring[]> {
  if (!existsSync(GEO_PATH)) {
    console.log(`downloading basemap → ${GEO_PATH}`);
    const res = await fetch(GEO_URL);
    if (!res.ok) throw new Error(`basemap download failed: HTTP ${res.status}`);
    await writeFile(GEO_PATH, await res.text());
  }
  const gj = JSON.parse(await readFile(GEO_PATH, "utf8"));
  const rings: Ring[] = [];
  for (const f of gj.features) {
    const polys: Ring[][] =
      f.geometry.type === "Polygon" ? [f.geometry.coordinates] : f.geometry.coordinates;
    for (const poly of polys) rings.push(...poly);
  }
  return rings;
}

function landPath(rings: Ring[]): string {
  const d: string[] = [];
  for (const ring of rings) {
    let last: string | null = null;
    const seg: string[] = [];
    for (const [lon, lat] of ring) {
      const key = x(lon) + "," + y(lat);
      if (key === last) continue;
      last = key;
      seg.push((seg.length ? "L" : "M") + key);
    }
    if (seg.length > 2) d.push(seg.join("") + "Z");
  }
  return d.join("");
}

async function main(): Promise<void> {
  const counts = GROUPS.map(() => 0);
  for (const l of LOCATIONS) counts[groupIndex(l)]++;

  const out: string[] = [];
  out.push(
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${TOT}" font-family="system-ui, -apple-system, 'Segoe UI', sans-serif">`,
  );
  out.push(`<style>
  :root, svg {
    --surface: #fcfcfb; --ink: #0b0b0b; --ink2: #52514e; --muted: #898781;
    --grid: #e1e0d9; --baseline: #c3c2b7;
    --land: #edece8; --coast: #cfcec7;
${GROUPS.map((g, i) => `    --g${i}: ${g.light};`).join("\n")}
  }
  @media (prefers-color-scheme: dark) {
    :root, svg {
      --surface: #1a1a19; --ink: #ffffff; --ink2: #c3c2b7; --muted: #898781;
      --grid: #2c2c2a; --baseline: #383835;
      --land: #262625; --coast: #454542;
${GROUPS.map((g, i) => `      --g${i}: ${g.dark};`).join("\n")}
    }
  }
  circle:hover { stroke: var(--ink); stroke-width: 1; }
</style>`);
  out.push(`<rect width="${W}" height="${TOT}" fill="var(--surface)"/>`);

  // header + legend
  out.push(
    `<text x="16" y="30" font-size="20" font-weight="650" fill="var(--ink)">Benchmark corpus — ${count(LOCATIONS.length)} sites</text>`,
  );
  out.push(
    `<text x="16" y="50" font-size="12" fill="var(--ink2)">locations.ts registry · √Köppen-stratified land sample + latitude-banded ocean sites + favorites · hover a point for details</text>`,
  );
  let lx = 16;
  out.push(`<g font-size="12">`);
  GROUPS.forEach((g, i) => {
    out.push(`<circle cx="${lx + 5}" cy="${HDR - 12}" r="4.5" fill="var(--g${i})"/>`);
    const label = `${g.label} ${count(counts[i])}`;
    out.push(
      `<text x="${lx + 14}" y="${HDR - 8}" fill="var(--ink)">${g.label} <tspan fill="var(--muted)">${count(counts[i])}</tspan></text>`,
    );
    lx += 14 + label.length * 6.4 + 22;
  });
  out.push(`</g>`);

  // land + country borders
  out.push(
    `<path d="${landPath(await countryRings())}" fill="var(--land)" stroke="var(--coast)" stroke-width="0.7" fill-rule="evenodd" stroke-linejoin="round"/>`,
  );

  // graticule
  out.push(`<g stroke="var(--grid)" stroke-width="0.75">`);
  for (let lon = -150; lon <= 150; lon += 30)
    out.push(`<line x1="${x(lon)}" y1="${HDR}" x2="${x(lon)}" y2="${HDR + H}"/>`);
  for (let lat = -60; lat <= 60; lat += 30)
    out.push(`<line x1="0" y1="${y(lat)}" x2="${W}" y2="${y(lat)}"/>`);
  out.push(`</g>`);
  out.push(`<line x1="0" y1="${y(0)}" x2="${W}" y2="${y(0)}" stroke="var(--baseline)" stroke-width="1"/>`);
  out.push(`<line x1="${x(0)}" y1="${HDR}" x2="${x(0)}" y2="${HDR + H}" stroke="var(--baseline)" stroke-width="1"/>`);
  out.push(`<g font-size="9" fill="var(--muted)">`);
  for (let lat = -60; lat <= 60; lat += 30)
    out.push(`<text x="4" y="${(+y(lat) - 3).toFixed(1)}">${fmtLat(lat)}</text>`);
  for (let lon = -150; lon <= 150; lon += 30)
    out.push(`<text x="${(+x(lon) + 3).toFixed(1)}" y="${HDR + 11}">${fmtLon(lon)}</text>`);
  out.push(`</g>`);
  out.push(
    `<rect x="0.5" y="${HDR}.5" width="${W - 1}" height="${H - 1}" fill="none" stroke="var(--baseline)" stroke-width="1"/>`,
  );

  // dots: ocean first (background field), then land groups, favorites on top with a ring
  const order = [5, 0, 1, 2, 3, 4, 6];
  for (const gi of order) {
    const special = gi === 6;
    const r = special ? 4 : 1.7;
    const stroke = special ? ` stroke="var(--surface)" stroke-width="1"` : "";
    out.push(`<g fill="var(--g${gi})"${stroke}>`);
    for (const l of LOCATIONS) {
      if (groupIndex(l) !== gi) continue;
      out.push(`<circle cx="${x(l.lon)}" cy="${y(l.lat)}" r="${r}"><title>${esc(tooltip(l))}</title></circle>`);
    }
    out.push(`</g>`);
  }
  out.push(`</svg>`);

  await writeFile(OUT_PATH, out.join("\n"));
  console.log(
    `wrote ${OUT_PATH} — ${count(LOCATIONS.length)} sites (${GROUPS.map((g, i) => `${g.label}: ${counts[i]}`).join(", ")})`,
  );
}

await main();
