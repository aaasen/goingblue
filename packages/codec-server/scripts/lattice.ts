/**
 * The corpus window lattice, shared by the collector (benchmark.ts) and the stratified sampler
 * (sample-locations.ts). Window starts live on a FIXED 10-day grid (anchored to the existing
 * corpus's newest window) rather than counting back from today — otherwise every collection day
 * would shift the whole grid and the planner would see the entire corpus as missing. New windows
 * only appear when the calendar crosses the next lattice point. The sampler commits its per-site
 * window picks as lattice indices (windowIso resolves them), so they can never drift off-grid.
 */

// Window geometry. 14 days keeps every benchmarked duration (≤10d) fully covered including the
// local-midnight shift — see the layout note in benchmark.ts.
export const HORIZON_DAYS = 14;
export const WINDOW_HOURS = HORIZON_DAYS * 24;

export const CADENCE_DAYS = 10;    // one window every ~10 days
export const YEARS_BACK = 2;       // sample windows across the past two years (per-source archive depth varies)
export const ANCHOR_LAG_DAYS = 5;  // newest window ends a few days ago so the best-estimate has settled
export const GRID_ANCHOR_MS = Date.UTC(2026, 5, 25); // 2026-06-25, the imported corpus's newest window

const DAY_MS = 24 * 3600 * 1000;

export function runIso(ms: number): string {
  // ISO 8601 without seconds, UTC (e.g. 2025-07-15T00:00) — the window's anchor / start.
  return new Date(ms).toISOString().slice(0, 16);
}

// A lattice index counts CADENCE_DAYS steps back from the anchor (0 = 2026-06-25, 1 = ten days
// earlier, …). The committed sample stores these instead of ISO strings: compact, and windowIso
// keeps them tied to the one grid definition.
export function windowIso(index: number): string {
  return runIso(GRID_ANCHOR_MS - index * CADENCE_DAYS * DAY_MS);
}

// The window start timestamps (00:00 UTC) to sample, newest first.
export function sampleWindows(): number[] {
  const now = new Date();
  // Newest usable window ends ANCHOR_LAG_DAYS ago (so the best-estimate archive has settled)…
  const latest = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()) -
    (ANCHOR_LAG_DAYS + HORIZON_DAYS - 1) * DAY_MS;
  // …snapped DOWN to the lattice.
  const newest = GRID_ANCHOR_MS +
    Math.floor((latest - GRID_ANCHOR_MS) / (CADENCE_DAYS * DAY_MS)) * (CADENCE_DAYS * DAY_MS);
  const earliest = newest - YEARS_BACK * 365 * DAY_MS;
  const starts: number[] = [];
  for (let t = newest; t >= earliest; t -= CADENCE_DAYS * DAY_MS) starts.push(t);
  return starts;
}
