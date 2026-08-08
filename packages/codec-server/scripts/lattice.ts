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
export const ANCHOR_LAG_DAYS = 5;  // a window needs a few settled days before the best-estimate is final
export const GRID_ANCHOR_MS = Date.UTC(2026, 5, 25); // 2026-06-25, the imported corpus's newest window

// The corpus spans a FIXED range of windows, not a trailing N years. The trailing form (windows
// newer than `now - YEARS_BACK`) quietly shrank the corpus from the back as the calendar
// advanced: once a window fell off, the planner stopped seeing it, so its cells missed every
// later add-pass — the gust backfill and the 2026-07-31 variable expansion both left stale cells
// behind that way — and a newly added source could never cover them at all. Pinning both ends
// makes the window set reproducible (same corpus today and next month, so codebooks derived
// weeks apart train on the same data) and lets a new source backfill the whole of it.
//
// Both bounds must sit on the lattice; sampleWindows asserts it. Widening the span is a
// deliberate edit here, and costs one add-pass over the new windows for every source.
export const CORPUS_FIRST_WINDOW = Date.UTC(2024, 5, 25); // 2024-06-25, the corpus's oldest window
export const CORPUS_LAST_WINDOW = Date.UTC(2026, 6, 15);  // 2026-07-15

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
  const step = CADENCE_DAYS * DAY_MS;
  for (const [name, t] of [["CORPUS_FIRST_WINDOW", CORPUS_FIRST_WINDOW],
                           ["CORPUS_LAST_WINDOW", CORPUS_LAST_WINDOW]] as const) {
    if ((t - GRID_ANCHOR_MS) % step !== 0) {
      throw new Error(`lattice: ${name} (${runIso(t)}) is off the ${CADENCE_DAYS}-day grid`);
    }
  }
  if (CORPUS_LAST_WINDOW < CORPUS_FIRST_WINDOW) {
    throw new Error("lattice: CORPUS_LAST_WINDOW precedes CORPUS_FIRST_WINDOW");
  }
  // A window's last hour must be ANCHOR_LAG_DAYS in the past, or its tail comes back null from
  // the best-estimate archive. This throws rather than clamping: silently trimming the newest
  // window is exactly the sliding behaviour the fixed bounds exist to remove.
  const settled = Date.now() - (ANCHOR_LAG_DAYS + HORIZON_DAYS - 1) * DAY_MS;
  if (CORPUS_LAST_WINDOW > settled) {
    const newest = GRID_ANCHOR_MS + Math.floor((settled - GRID_ANCHOR_MS) / step) * step;
    throw new Error(`lattice: CORPUS_LAST_WINDOW (${runIso(CORPUS_LAST_WINDOW)}) has not settled yet — ` +
      `the newest usable window starts ${runIso(newest)}`);
  }
  const starts: number[] = [];
  for (let t = CORPUS_LAST_WINDOW; t >= CORPUS_FIRST_WINDOW; t -= step) starts.push(t);
  return starts;
}
