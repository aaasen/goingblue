import { RESOLUTION_HOURS, MODEL_BIT } from "./constants.js";

// Priority-mode fill layout (v3 of the fill scheme, protocol v2). v1 is shipped and frozen in
// its own container, so changes here land in v2 and never move v1's bits (see VERSIONING.md).
// The user picks a PRIORITY MODE (Detail / Auto / Range), not
// a duration or resolution; the server fills the message budget by walking that mode's
// refinement path and binary-searching the largest step whose encoding fits. The wire carries
// only the sequence number `seq` — both sides derive the identical period layout from
// (mode, requestUtcHour, utcOffsetHours, seq), all of which the client already has in its
// stored request context.
//
// A mode is an ORDERING, not a promise: every path step is either an extend-move (cover one
// more day slot at 12h) or a refine-move (one covered slot, one rung finer: 12h → 6h → 3h →
// 1h). Detail plays refine-moves first (hourly detail before coverage), Range extend-moves
// first (the full horizon before any refinement), Auto interleaves. All three paths share
// their bottom (a truncated 12h ramp) so a starved budget degrades to the same message in
// every mode.
//
// Each path is compiled from a short list of ANCHOR profiles (per-slot resolution indices,
// front to back) by a canonical interpolation rule: repeatedly fix the leftmost slot below its
// next-anchor target — extend with a 12h slot when the deficit is coverage, otherwise upgrade
// one rung. Profiles stay monotone front-to-back (finer never after coarser) and period count
// strictly grows along the path, so encoded size grows with seq and a server can binary-search
// the largest seq that fits a byte budget.
//
// THE ANCHORS AND THE INTERPOLATION RULE ARE WIRE FORMAT: changing either changes what
// already-encoded messages mean, and requires a protocol version bump. The anchor shapes were
// chosen against corpus measurements (data/benchmarks/2026-07-22T19-07-01_anchor-probe.txt).
//
// Periods align to LOCAL midnight (12h at 0:00/12:00; 6h at 0/6/12/18; …), where "local" is
// UTC shifted by a fixed integer-hour offset captured at request time. A fixed offset keeps
// every day exactly 24 hours; if a DST transition falls inside the window, day boundaries
// drift one hour past it — accepted for a ≤2-week horizon.
//
// The horizon covers FILL_SLOTS day slots: the remainder of the request day, then
// FILL_HORIZON_DAYS whole local days. Slot 0 (the request day) is partial: its first period is
// the one containing the request time (floor(request, resolution)), so refining slot 0
// discards earlier hours of today — the current period is a useful baseline, but the past is
// not. Later slots always start at local midnight. A request at exactly local midnight
// over-covers (its "remainder" is a whole day); accepted — a fixed slot count keeps the tables
// independent of the request hour.

export const FILL_HORIZON_DAYS = 12; // whole days ahead of the request day
export const FILL_SLOTS = FILL_HORIZON_DAYS + 1;

// Priority modes, by wire value (the `p:` request token / RequestContext.mode).
export const MODE_DETAIL = 0;
export const MODE_AUTO = 1;
export const MODE_RANGE = 2;
export const DEFAULT_MODE = MODE_AUTO;
export const MODE_NAMES = ["Detail", "Auto", "Range"] as const;

// Centers whose deepest model stops short of the window, by MODEL_BIT. Canada's GDPS runs 240h
// twice a day and lands ~7h after init, so a request is guaranteed only 240 - 12 - 7 = 221h,
// about 9 days against a window of 288-312h. NOAA (GFS 384h) and ECMWF (IFS 360h) clear it, as
// does every best_match branch (its shallowest bottoms out in a ≥360h global model).
const SHORT_HORIZON_MODELS = [MODEL_BIT.CA];

/**
 * The priority mode a request actually runs under.
 *
 * Range walks its whole coverage ramp at 12h before refining anything, so against a center that
 * can't fill the window it was the one mode that broke: a layout with a slot the model has no
 * data for is unservable, coverage only grows along a path, and the seq search therefore stopped
 * inside the 12h ramp — Canada asking for Range got 10 days at 12h with a third of the message
 * budget unspent. Auto interleaves refinement with coverage, so its servable steps already carry
 * finer periods; Detail likewise. Mapping Range onto Auto for those centers spends the budget
 * instead of stranding it.
 *
 * THE SERVER AND THE DECODER MUST BOTH APPLY THIS. The mode is not on the wire — the decoder
 * recovers it from the stored request (see RequestContext) and derives the period layout from
 * it. A request carries and a client stores the mode that was actually asked for; the
 * substitution is made where the message is built (parseRequest) and made again where it is
 * read (v2MessageFromString), against the same model, so both arrive at the same layout without
 * the client needing to know this rule exists.
 *
 * Known limitation: it fixes Range, not the underlying clamp. Detail and Auto stay budget-bound
 * only while the budget is around one 160-char message; a `c:` past roughly 200 chars runs them
 * into the same data cliff, wasting the excess. Capping the window per model (a per-center slot
 * cap that shortens every mode's path) is the general fix, deliberately not taken here.
 */
export function effectiveMode(mode: number, model: number): number {
  return mode === MODE_RANGE && SHORT_HORIZON_MODELS.includes(model) ? MODE_AUTO : mode;
}

// Anchor profiles per mode: resolution index (1 = 12h … 4 = 1h, see RESOLUTION_HOURS) per
// covered day slot. Rows shorter than FILL_SLOTS leave the remaining days uncovered at that
// point in the path. Every consecutive pair must be nested (pointwise ≥, length ≥).
const rep = (r: number, n: number): number[] => Array(n).fill(r);
const ANCHORS: number[][][] = [
  // Detail: 3 hourly days before coverage exceeds 5 slots, then taper outward.
  [
    [1],
    [1, 1, 1],
    [4, 2, 1],                                   // today → 1h as early as possible
    [4, 4, 4, 1, 1],                             // 3d @1h, coverage capped at 5
    [4, 4, 4, 3, 3, 2, 2, 2, 1, 1, 1],           // taper outward
    [4, 4, 4, 3, 3, 2, 2, 2, 1, 1, 1, 1, 1],     // full coverage
    [4, 4, 4, 4, 4, 3, 3, 3, 3, 3, 2, 2, 2],     // deepen hourly to 5d
    [...rep(4, 8), ...rep(3, 5)],                // top: 8d @1h + 3h rest
  ],
  // Auto: a week of coverage, 3h near term, the full horizon, then hourly.
  [
    [1],
    [1, 1, 1],
    rep(1, 7),                                   // 7 slots of 12h coverage
    [...rep(2, 5), 1, 1],                        // 6h breadth before 3h
    [...rep(3, 5), 1, 1],                        // 5 slots @3h
    [...rep(3, 5), ...rep(1, 5)],                // coverage to 10
    [4, ...rep(3, 4), ...rep(1, 5)],             // hourly refinement begins
    [4, 4, ...rep(3, 5), 2, 2, 2, 1, 1, 1],      // 2nd hourly day, full coverage
    [...rep(4, 6), ...rep(3, 7)],                // top: 6d @1h + 3h rest
  ],
  // Range: the whole horizon before any refinement, then breadth-first rungs.
  [
    [1],
    [1, 1, 1],
    rep(1, FILL_SLOTS),
    rep(2, FILL_SLOTS),
    rep(3, FILL_SLOTS),
    [...rep(4, 3), ...rep(3, 10)],               // top: 3d @1h + 3h rest
  ],
];

// The canonical interpolation rule (see the wire-format note above).
function interpolate(from: number[], to: number[]): number[][] {
  for (let i = 0; i < from.length; i++) {
    if (to[i] === undefined || to[i] < from[i])
      throw new Error(`layout: anchors not nested at slot ${i}`);
  }
  const cur = [...from];
  const out: number[][] = [];
  for (;;) {
    let s = -1;
    for (let i = 0; i < to.length; i++) {
      if (i >= cur.length || cur[i] < to[i]) { s = i; break; }
    }
    if (s === -1) return out;
    if (s >= cur.length) cur.push(1);
    else cur[s] += 1;
    out.push([...cur]);
  }
}

function compilePath(anchors: number[][]): number[][] {
  const path = [anchors[0]];
  for (let a = 1; a < anchors.length; a++) path.push(...interpolate(anchors[a - 1], anchors[a]));
  for (const p of path) {
    for (let i = 1; i < p.length; i++) {
      if (p[i] > p[i - 1]) throw new Error("layout: non-monotone profile in path");
    }
  }
  return path;
}

// seq → profile, per mode. seq is 1-based: PATHS[mode][seq - 1].
const PATHS: number[][][] = ANCHORS.map(compilePath);

// The 1-based seq of each anchor within its mode's path — the named waypoints of the ladder
// (reports mark them on fill axes; nothing on the wire depends on them).
export const FILL_ANCHOR_SEQS: number[][] = ANCHORS.map((anchors, mode) =>
  anchors.map((a) => PATHS[mode].findIndex((p) => p.length === a.length && p.every((r, i) => r === a[i])) + 1));

// The per-slot resolution profile a seq denotes (a defensive copy). For consumers that need the
// shape without the request-time period arithmetic (e.g. report strips).
export function fillProfile(mode: number, seq: number): number[] {
  const path = PATHS[mode];
  if (!path) throw new Error(`layout: invalid mode ${mode}`);
  if (!Number.isInteger(seq) || seq < 1 || seq > path.length)
    throw new Error(`layout: seq ${seq} outside 1..${path.length} for mode ${mode}`);
  return [...path[seq - 1]];
}

export interface FillLayout {
  seq: number;
  mode: number;
  // Day slots covered: the partial request day plus whole days (< FILL_SLOTS early in the
  // path, before the mode's extend-moves have run).
  days: number;
  // Resolution index (1..4, see RESOLUTION_HOURS) of each covered slot.
  dayResolution: number[];
  // Span of each period, in hours.
  periodHours: number[];
  // Start of each period, in UTC hours since the epoch.
  periodStartUtcHour: number[];
}

export function maxFillSeq(mode: number): number {
  const path = PATHS[mode];
  if (!path) throw new Error(`layout: invalid mode ${mode}`);
  return path.length;
}

// Derives the period layout for a fill-sequence number. `requestUtcHour` is the request time in
// UTC hours since the epoch (aligned down to the hour — the `t:` request token); `utcOffsetHours`
// is the location's fixed UTC offset in whole hours (the `z:` request token).
export function layoutFor(
  mode: number,
  requestUtcHour: number,
  utcOffsetHours: number,
  seq: number,
): FillLayout {
  const path = PATHS[mode];
  if (!path) throw new Error(`layout: invalid mode ${mode}`);
  if (!Number.isInteger(seq) || seq < 1 || seq > path.length)
    throw new Error(`layout: seq ${seq} outside 1..${path.length} for mode ${mode}`);
  if (!Number.isInteger(requestUtcHour) || requestUtcHour < 0)
    throw new Error(`layout: invalid request hour ${requestUtcHour}`);
  if (!Number.isInteger(utcOffsetHours) || utcOffsetHours < -12 || utcOffsetHours > 14)
    throw new Error(`layout: invalid UTC offset ${utcOffsetHours}`);

  const profile = path[seq - 1];
  const local = requestUtcHour + utcOffsetHours; // request time in local epoch hours
  const day0 = Math.floor(local / 24) * 24;      // local midnight of the request day

  const periodHours: number[] = [];
  const periodStartUtcHour: number[] = [];
  for (let d = 0; d < profile.length; d++) {
    const h = RESOLUTION_HOURS[profile[d]];
    const dayStart = day0 + 24 * d;
    // Slot 0 starts at the period containing the request time; later slots at local midnight.
    const first = d === 0 ? dayStart + Math.floor((local - dayStart) / h) * h : dayStart;
    for (let s = first; s < dayStart + 24; s += h) {
      periodHours.push(h);
      periodStartUtcHour.push(s - utcOffsetHours);
    }
  }

  return {
    seq, mode, days: profile.length, dayResolution: [...profile], periodHours, periodStartUtcHour,
  };
}
