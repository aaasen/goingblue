/**
 * Prominent-peak probe sampler — generates peak-locations.json, an eval-only `peaks` stratum
 * that tests the codec on summit-pinned high-altitude forecasts (Open-Meteo lapse-rate-adjusts
 * to the requested elevation, so summits differ materially from the valley points the Köppen
 * sample lands on). Diagnostic first: if the codec holds up here, no corpus expansion is needed.
 *
 * Frame: the Kirmse/de Ferranti global prominence dataset (2023 GLO30 run) — every peak on
 * Earth with ≥100 ft prominence, computed from the Copernicus GLO30 DEM (the same DEM family
 * Open-Meteo resolves point elevations against, so pinned elevations stay consistent with the
 * model's terrain). Rows are `lat,lon,elev_m,saddle_lat,saddle_lon,prom_m`, sorted by
 * descending prominence, so the read stops at the P600 cutoff.
 *
 * Design:
 *   - Peaks with ≥600 m prominence (independent mountains, not sub-summits).
 *   - Stratified by summit elevation band, 30 sites per band — deliberately flat across bands
 *     (this is a probe of the high-altitude regime, not a representative sample).
 *   - ≥25 km separation from every registry location and each other, seeded PRNG, 12 committed
 *     lattice windows per site — all matching sample-locations.ts.
 *   - Every site is split "eval": the derive pipeline only visits train sites, so the probe can
 *     never leak into codebooks.
 *
 * Input: data/sampler/prominence/all-peaks-sorted-p100.txt — from the zip linked at
 * https://www.andrewkirmse.com/prominence-update-2023
 *
 *   node packages/server/scripts/sample-peaks.ts [--seed N]
 */
import { createReadStream, existsSync, writeFileSync } from "node:fs";
import { createInterface } from "node:readline";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { REPO_ROOT } from "./corpus-db.ts";
import { CADENCE_DAYS, GRID_ANCHOR_MS, sampleWindows } from "./lattice.ts";
import { LOCATIONS } from "./locations.ts";

const PEAKS_PATH = join(REPO_ROOT, "data", "sampler", "prominence", "all-peaks-sorted-p100.txt");
const OUT_PATH = join(dirname(fileURLToPath(import.meta.url)), "peak-locations.json");

const PROMINENCE_MIN_M = 600;
const SITES_PER_BAND = 30;
const WINDOWS_PER_SITE = 12;
const MIN_SEPARATION_KM = 25; // ≈ one GFS grid cell, same as sample-locations.ts
const DEFAULT_SEED = 20260721;

// Summit elevation bands (meters). Flat allocation: the top band would be a rounding error in
// any area- or count-proportional draw, and it is exactly the regime the probe exists to test.
const BANDS = [
  { id: "1500-2500", lo: 1500, hi: 2500 },
  { id: "2500-3500", lo: 2500, hi: 3500 },
  { id: "3500-4500", lo: 3500, hi: 4500 },
  { id: "4500-5500", lo: 4500, hi: 5500 },
  { id: "5500+", lo: 5500, hi: Infinity },
];

// mulberry32 — same PRNG as sample-locations.ts; determinism matters more than quality here.
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

// 0.5° latitude-band spatial index, as in sample-locations.ts.
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

interface Peak { lat: number; lon: number; elevM: number; promM: number }

// Stream the prominence file into per-band candidate pools. The file is sorted by descending
// prominence, so the read ends at the first row under the cutoff (~11.8M rows never parsed).
async function loadCandidates(): Promise<Peak[][]> {
  const pools: Peak[][] = BANDS.map(() => []);
  const rl = createInterface({ input: createReadStream(PEAKS_PATH), crlfDelay: Infinity });
  for await (const line of rl) {
    const parts = line.split(",");
    const promM = Number(parts[5]);
    if (promM < PROMINENCE_MIN_M) { rl.close(); break; }
    const elevM = Number(parts[2]);
    const band = BANDS.findIndex((b) => elevM >= b.lo && elevM < b.hi);
    if (band >= 0) pools[band].push({ lat: Number(parts[0]), lon: Number(parts[1]), elevM, promM });
  }
  return pools;
}

async function main(): Promise<void> {
  const seedArg = process.argv.indexOf("--seed");
  const seed = seedArg >= 0 ? Number(process.argv[seedArg + 1]) : DEFAULT_SEED;
  if (!Number.isInteger(seed)) throw new Error("--seed expects an integer");
  if (!existsSync(PEAKS_PATH)) {
    throw new Error(`prominence data missing: ${PEAKS_PATH} (see header for the download source)`);
  }
  const rng = makeRng(seed);

  const pools = await loadCandidates();

  const index = new SeparationIndex();
  for (const l of LOCATIONS) index.add(l.lat, l.lon);

  const lattice = sampleWindows();
  const latticeIdx = lattice.map((ms) => (GRID_ANCHOR_MS - ms) / (CADENCE_DAYS * 24 * 3600 * 1000));

  interface Site { id: string; lat: number; lon: number; elev_m: number; prom_m: number; wi: number[] }
  const sites: Site[] = [];
  let seq = 0;
  console.log(`band       pool     got`);
  for (let b = 0; b < BANDS.length; b++) {
    const pool = pools[b];
    // Uniform draw without replacement: partial Fisher–Yates, skipping too-close picks.
    let got = 0;
    for (let i = 0; i < pool.length && got < SITES_PER_BAND; i++) {
      const j = i + Math.floor(rng() * (pool.length - i));
      [pool[i], pool[j]] = [pool[j], pool[i]];
      const p = pool[i];
      if (index.tooClose(p.lat, p.lon)) continue;
      index.add(p.lat, p.lon);
      got++;
      const wi: number[] = [];
      for (let k = 0; k < WINDOWS_PER_SITE; k++) {
        const start = Math.floor((k * lattice.length) / WINDOWS_PER_SITE);
        const end = Math.floor(((k + 1) * lattice.length) / WINDOWS_PER_SITE);
        wi.push(latticeIdx[start + Math.floor(rng() * (end - start))]);
      }
      sites.push({
        id: `s-peak-${String(++seq).padStart(4, "0")}`,
        lat: p.lat, lon: p.lon,
        elev_m: Math.round(p.elevM), prom_m: Math.round(p.promM),
        wi: wi.sort((x, y) => x - y),
      });
    }
    console.log(`${BANDS[b].id.padEnd(9)} ${String(pool.length).padStart(6)} ${String(got).padStart(6)}${got < SITES_PER_BAND ? "  ← short (dedupe-limited)" : ""}`);
  }

  const body = sites.map((x) => "  " + JSON.stringify(x)).join(",\n");
  writeFileSync(OUT_PATH, `{\n"seed": ${seed},\n"sites": [\n${body}\n]\n}\n`);
  console.log(`wrote ${OUT_PATH.replace(REPO_ROOT + "/", "")} (seed ${seed}, ${sites.length} sites × ${WINDOWS_PER_SITE} windows)`);
}

await main();
