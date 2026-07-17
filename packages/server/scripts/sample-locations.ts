/**
 * Stratified global location sampler — generates sampled-locations.json, the committed
 * training half of the corpus registry (locations.ts loads it; favorites are the
 * validation half).
 *
 * Design (agreed 2026-07-17): 10,000 sites = 8,500 land + 1,500 ocean.
 *   - Land stratified by all 30 Köppen–Geiger subtypes (Beck et al. 2023, 1991–2020 map at
 *     0.1°); allocation ∝ √(area share) — flatter than area-proportional, so rare regimes are
 *     represented (the whole point of stratifying), while common ones still lead. No floors, no
 *     trims: micro-classes (Csc/Cwc/Dsd) request a handful of sites and the 25 km dedupe caps
 *     what actually fits.
 *   - Ocean stratified into six 30° latitude bands, same √(area) allocation.
 *   - Within a stratum: cells drawn ∝ cos(lat) (equal-area), jittered inside the 0.1° cell,
 *     rejected if within 25 km (≈ one GFS grid cell) of any accepted or existing location.
 *     No remoteness/usage weighting — v1 is a representative sample of global weather.
 *   - 12 windows per site (~one per 2 months): the 2-year lattice is split into 12 equal blocks,
 *     one window drawn per block. Committed as lattice indices (lattice.ts windowIso).
 *   - Split 85/15 train/eval per stratum, assigned per site.
 *
 * Deterministic: seeded PRNG (--seed to override), so a re-run with the same seed and raster
 * reproduces the file byte-for-byte. Re-running replaces the whole sample (dedupe runs against
 * favorites only, not the previous sample).
 *
 * Input raster: data/sampler/1991_2020/koppen_geiger_0p1.tif — from koppen_geiger_tif.zip at
 * https://figshare.com/articles/dataset/21789074 (Beck et al. 2023; gloh2o.org/koppen).
 *
 *   node packages/server/scripts/sample-locations.ts [--seed N]
 */
import { existsSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { fromFile } from "geotiff";
import { REPO_ROOT } from "./corpus-db.ts";
import { CADENCE_DAYS, GRID_ANCHOR_MS, sampleWindows } from "./lattice.ts";
import { LOCATIONS } from "./locations.ts";

const RASTER_PATH = join(REPO_ROOT, "data", "sampler", "1991_2020", "koppen_geiger_0p1.tif");
const OUT_PATH = join(dirname(fileURLToPath(import.meta.url)), "sampled-locations.json");

const LAND_SITES = 8_500;
const OCEAN_SITES = 1_500;
const WINDOWS_PER_SITE = 12;
const EVAL_FRACTION = 0.15;
const MIN_SEPARATION_KM = 25; // ≈ one GFS grid cell
const DEFAULT_SEED = 20260717;

// Beck et al. legend: raster value → subtype (index 0 = ocean/nodata).
const KOPPEN = [
  "", "Af", "Am", "Aw", "BWh", "BWk", "BSh", "BSk", "Csa", "Csb", "Csc", "Cwa", "Cwb", "Cwc",
  "Cfa", "Cfb", "Cfc", "Dsa", "Dsb", "Dsc", "Dsd", "Dwa", "Dwb", "Dwc", "Dwd", "Dfa", "Dfb",
  "Dfc", "Dfd", "ET", "EF",
];
const OCEAN_BANDS = [
  { id: "60N-90N", lo: 60, hi: 90 },
  { id: "30N-60N", lo: 30, hi: 60 },
  { id: "0-30N", lo: 0, hi: 30 },
  { id: "0-30S", lo: -30, hi: 0 },
  { id: "30S-60S", lo: -60, hi: -30 },
  { id: "60S-90S", lo: -90, hi: -60 },
];

// mulberry32 — tiny seeded PRNG; determinism matters more than quality here.
function makeRng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const EARTH_RADIUS_KM = 6371;
function haversineKm(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const rad = Math.PI / 180;
  const dLat = (lat2 - lat1) * rad, dLon = (lon2 - lon1) * rad;
  const a = Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1 * rad) * Math.cos(lat2 * rad) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_RADIUS_KM * Math.asin(Math.sqrt(a));
}

// Spatial index over accepted points: 0.5° latitude bands. 25 km ≈ 0.225° of latitude, so a
// candidate only needs its own band ±1 checked (longitude is not prefiltered — near the poles a
// 25 km circle spans many degrees of longitude, and bands are small enough to scan fully).
class SeparationIndex {
  private bands = new Map<number, { lat: number; lon: number }[]>();

  tooClose(lat: number, lon: number): boolean {
    const band = Math.floor(lat / 0.5);
    for (let b = band - 1; b <= band + 1; b++) {
      for (const p of this.bands.get(b) ?? []) {
        if (haversineKm(lat, lon, p.lat, p.lon) < MIN_SEPARATION_KM) return true;
      }
    }
    return false;
  }

  add(lat: number, lon: number): void {
    const band = Math.floor(lat / 0.5);
    let arr = this.bands.get(band);
    if (!arr) this.bands.set(band, (arr = []));
    arr.push({ lat, lon });
  }
}

// Exact-total allocation of `total` slots ∝ weight, by largest remainder.
function allocate(weights: number[], total: number): number[] {
  const sum = weights.reduce((a, b) => a + b, 0);
  const exact = weights.map((w) => (total * w) / sum);
  const floors = exact.map(Math.floor);
  let left = total - floors.reduce((a, b) => a + b, 0);
  const order = exact.map((x, i) => ({ frac: x - floors[i], i })).sort((a, b) => b.frac - a.frac);
  for (const { i } of order) {
    if (left <= 0) break;
    floors[i]++; left--;
  }
  return floors;
}

interface Stratum {
  key: string;             // Köppen subtype, or "ocean <band>"
  koppen: string;          // the `k` field emitted per site ("ocean" for every ocean band)
  idPrefix: string;        // sites are s-<idPrefix>-NNNN
  cells: Uint32Array;      // raster cell indices belonging to the stratum
  cum: Float64Array;       // cumulative cos-lat weights over `cells` (equal-area draws)
  area: number;            // total cos-lat weight (∝ true area)
  target: number;          // allocated site count (filled after allocation)
}

interface Site { id: string; k: string; lat: number; lon: number; split: "train" | "eval"; wi: number[] }

async function main(): Promise<void> {
  const seedArg = process.argv.indexOf("--seed");
  const seed = seedArg >= 0 ? Number(process.argv[seedArg + 1]) : DEFAULT_SEED;
  if (!Number.isInteger(seed)) throw new Error("--seed expects an integer");
  if (!existsSync(RASTER_PATH)) {
    throw new Error(`Köppen raster missing: ${RASTER_PATH} (see header for the download source)`);
  }
  const rng = makeRng(seed);

  // ── Load the raster and partition cells into strata ────────────────────────────
  const tif = await fromFile(RASTER_PATH);
  const image = await tif.getImage();
  const width = image.getWidth(), height = image.getHeight();
  const [west, south, east, north] = image.getBoundingBox();
  const values = (await image.readRasters())[0] as Uint8Array;
  const dLon = (east - west) / width, dLat = (north - south) / height;

  const cellLat = (idx: number): number => north - (Math.floor(idx / width) + 0.5) * dLat;
  const cellLon = (idx: number): number => west + ((idx % width) + 0.5) * dLon;

  // Strata 0–29 = the 30 Köppen subtypes (raster value − 1); 30–35 = the six ocean bands.
  const strataDefs = [
    ...KOPPEN.slice(1).map((k) => ({ key: k, koppen: k, idPrefix: k.toLowerCase() })),
    ...OCEAN_BANDS.map((b) => ({ key: `ocean ${b.id}`, koppen: "ocean", idPrefix: "ocean" })),
  ];
  const strata: Stratum[] = strataDefs.map((d) => ({ ...d, cells: new Uint32Array(0), cum: new Float64Array(0), area: 0, target: 0 }));
  const strholder: number[][] = strata.map(() => []);
  for (let idx = 0; idx < values.length; idx++) {
    const v = values[idx];
    const lat = cellLat(idx);
    const s = v === 0
      ? 30 + OCEAN_BANDS.findIndex((b) => lat >= b.lo && (lat < b.hi || (b.hi === 90 && lat >= b.lo)))
      : v - 1;
    strholder[s].push(idx);
  }
  for (let i = 0; i < strata.length; i++) {
    const cells = Uint32Array.from(strholder[i]);
    const cum = new Float64Array(cells.length);
    let acc = 0;
    for (let j = 0; j < cells.length; j++) {
      acc += Math.cos((cellLat(cells[j]) * Math.PI) / 180);
      cum[j] = acc;
    }
    strata[i] = { ...strata[i], cells, cum, area: acc };
  }

  // ── √area allocation, land and ocean pools separately ──────────────────────────
  const land = strata.slice(0, 30), ocean = strata.slice(30);
  allocate(land.map((s) => Math.sqrt(s.area)), LAND_SITES).forEach((n, i) => (land[i].target = n));
  allocate(ocean.map((s) => Math.sqrt(s.area)), OCEAN_SITES).forEach((n, i) => (ocean[i].target = n));

  // ── Draw sites: equal-area cell pick, in-cell jitter, ≥25 km separation ───────
  const index = new SeparationIndex();
  const existing = LOCATIONS.filter((l) => l.stratum === "favorites");
  for (const l of existing) index.add(l.lat, l.lon);

  const lattice = sampleWindows();
  const latticeIdx = lattice.map((ms) => (GRID_ANCHOR_MS - ms) / (CADENCE_DAYS * 24 * 3600 * 1000));

  const sites: Site[] = [];
  const summary: { key: string; target: number; got: number; evals: number }[] = [];
  let oceanSeq = 0; // ocean ids number across bands (one koppen label, one prefix)
  for (const s of strata) {
    const accepted: { lat: number; lon: number }[] = [];
    const maxAttempts = s.target * 200;
    for (let att = 0; att < maxAttempts && accepted.length < s.target; att++) {
      // Weighted draw: binary search the cumulative cos-lat weights.
      const r = rng() * s.area;
      let lo = 0, hi = s.cum.length - 1;
      while (lo < hi) {
        const mid = (lo + hi) >> 1;
        if (s.cum[mid] < r) lo = mid + 1; else hi = mid;
      }
      const idx = s.cells[lo];
      const lat = Math.round((cellLat(idx) + (rng() - 0.5) * dLat) * 1000) / 1000;
      let lon = Math.round((cellLon(idx) + (rng() - 0.5) * dLon) * 1000) / 1000;
      if (lon >= 180) lon -= 360;
      if (index.tooClose(lat, lon)) continue;
      index.add(lat, lon);
      accepted.push({ lat, lon });
    }

    // Per-site windows: one draw per block of the lattice → spans all seasons of both years.
    // Per-stratum split: seeded shuffle, first 15% eval.
    const order = accepted.map((_, i) => i);
    for (let i = order.length - 1; i > 0; i--) {
      const j = Math.floor(rng() * (i + 1));
      [order[i], order[j]] = [order[j], order[i]];
    }
    const evals = new Set(order.slice(0, Math.round(accepted.length * EVAL_FRACTION)));
    accepted.forEach((p, i) => {
      const wi: number[] = [];
      for (let b = 0; b < WINDOWS_PER_SITE; b++) {
        const start = Math.floor((b * lattice.length) / WINDOWS_PER_SITE);
        const end = Math.floor(((b + 1) * lattice.length) / WINDOWS_PER_SITE);
        wi.push(latticeIdx[start + Math.floor(rng() * (end - start))]);
      }
      const seq = s.koppen === "ocean" ? ++oceanSeq : i + 1;
      sites.push({
        id: `s-${s.idPrefix}-${String(seq).padStart(4, "0")}`,
        k: s.koppen, lat: p.lat, lon: p.lon,
        split: evals.has(i) ? "eval" : "train",
        wi: wi.sort((a, b) => a - b),
      });
    });
    summary.push({ key: s.key, target: s.target, got: accepted.length, evals: evals.size });
  }

  // ── Emit (one site per line, so registry diffs stay reviewable) ────────────────
  const body = sites.map((x) => "  " + JSON.stringify(x)).join(",\n");
  writeFileSync(OUT_PATH, `{\n"seed": ${seed},\n"sites": [\n${body}\n]\n}\n`);

  const landGot = summary.slice(0, 30).reduce((a, r) => a + r.got, 0);
  const oceanGot = summary.slice(30).reduce((a, r) => a + r.got, 0);
  console.log(`wrote ${OUT_PATH.replace(REPO_ROOT + "/", "")} (seed ${seed})`);
  console.log(`  land ${landGot}/${LAND_SITES}, ocean ${oceanGot}/${OCEAN_SITES}, windows/site ${WINDOWS_PER_SITE}, lattice ${lattice.length} windows`);
  console.log(`  stratum        target    got   eval`);
  for (const r of summary) {
    const short = r.got < r.target ? `  ← short ${r.target - r.got} (dedupe-limited)` : "";
    console.log(`  ${r.key.padEnd(14)} ${String(r.target).padStart(5)} ${String(r.got).padStart(6)} ${String(r.evals).padStart(6)}${short}`);
  }
}

await main();
