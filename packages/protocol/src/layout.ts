import { RESOLUTION_HOURS } from "./constants.js";

// Duration-first fill layout (v2). The user requests a duration in days; the server fills the
// message budget by refining whole days from the front of the window, one resolution step at a
// time (12h → 6h → 3h → 1h). The wire carries only a sequence number `seq` — both sides
// derive the identical period layout from (durationDays, requestUtcHour, utcOffsetHours, seq),
// all of which the client already has in its stored request context. This function is therefore
// WIRE FORMAT: changing how a seq maps to a layout changes what already-encoded v2 messages
// mean, and requires a protocol version bump.
//
// Periods align to LOCAL midnight (12h at 0:00/12:00; 6h at
// 0/6/12/18; …), where "local" is UTC shifted by a fixed integer-hour offset captured at request
// time. A fixed offset keeps every day exactly 24 hours; if a DST transition falls inside the
// window, day boundaries drift one hour past it — accepted for a ≤10-day horizon.
//
// A duration of D days covers D + 1 day SLOTS: the remainder of the request day, then D whole
// local days. D is therefore a floor on forward coverage (≥ 24D hours, whatever the request
// hour) rather than a ceiling, and every whole day in the window reports a complete daily
// high/low. Slot 0 (the request day) is partial: its first period is the one containing the
// request time (floor(request, resolution)), so refining slot 0 discards earlier hours of today
// — the current period is a useful baseline, but the past is not. Later slots always start at
// local midnight. A request at exactly local midnight is the one case that over-covers: its
// "remainder" is a whole day, so a D-day request spans D + 1 whole days and the fill lands a
// rung coarser. Accepted — keeping the slot count a pure function of D keeps seq arithmetic
// (and maxFillSeq) independent of the request hour.
//
// The sequence, over S = D + 1 slots:
//   seq = 1..S-1   truncated: seq whole slots, all at 12h (fallback when even 12h × S
//                  doesn't fit the budget)
//   seq = S        the full duration, all at 12h
//   seq = S + j    (j = 1..S)  the first j slots at 6h, the rest at 12h
//   seq = 2S + j   (j = 1..S)  the first j slots at 3h, the rest at 6h
//   seq = 3S + j   (j = 1..S)  the first j slots at 1h, the rest at 3h
// so seq = 4S is the whole window at 1h. Stage boundaries coincide (seq = kS as "j = S of stage
// k" is the same layout as "j = 0 of stage k+1"), and encoded size grows along the sequence, so
// a server can binary-search the largest seq that fits a byte budget.

// The refinement ladder uses resolution indices 1..4 (see RESOLUTION_HOURS). Index 0 remains
// reserved for the unchanged resolution-keyed codebooks, but fill layouts never emit it.
export const FILL_STAGES = 4;

export interface FillLayout {
  seq: number;
  durationDays: number;
  // seq < slotsFor(durationDays): pure-12h forecast covering fewer day slots than requested.
  truncated: boolean;
  // Day slots covered — the partial request day plus whole days (== slotsFor(durationDays)
  // unless truncated).
  days: number;
  // Resolution index (0..4, see RESOLUTION_HOURS) of each covered slot.
  dayResolution: number[];
  // Span of each period, in hours.
  periodHours: number[];
  // Start of each period, in UTC hours since the epoch.
  periodStartUtcHour: number[];
}

// Day slots a duration covers: the remainder of the request day, then `durationDays` whole days.
export function slotsFor(durationDays: number): number {
  return durationDays + 1;
}

export function maxFillSeq(durationDays: number): number {
  return FILL_STAGES * slotsFor(durationDays);
}

// Derives the period layout for a fill-sequence number. `requestUtcHour` is the request time in
// UTC hours since the epoch (aligned down to the hour — the `t:` request token); `utcOffsetHours`
// is the location's fixed UTC offset in whole hours (the `z:` request token).
export function layoutFor(
  durationDays: number,
  requestUtcHour: number,
  utcOffsetHours: number,
  seq: number,
): FillLayout {
  if (!Number.isInteger(durationDays) || durationDays < 1)
    throw new Error(`layout: invalid duration ${durationDays}`);
  if (!Number.isInteger(seq) || seq < 1 || seq > maxFillSeq(durationDays))
    throw new Error(`layout: seq ${seq} outside 1..${maxFillSeq(durationDays)} for ${durationDays}d`);
  if (!Number.isInteger(requestUtcHour) || requestUtcHour < 0)
    throw new Error(`layout: invalid request hour ${requestUtcHour}`);
  if (!Number.isInteger(utcOffsetHours) || utcOffsetHours < -12 || utcOffsetHours > 14)
    throw new Error(`layout: invalid UTC offset ${utcOffsetHours}`);

  const local = requestUtcHour + utcOffsetHours; // request time in local epoch hours
  const day0 = Math.floor(local / 24) * 24;      // local midnight of the request day

  const slots = slotsFor(durationDays);
  const truncated = seq < slots;
  const days = truncated ? seq : slots;
  // Refinement progress t = 0..3S past the all-12h layout: the first nFine slots sit at
  // resolution index `fine`, the rest one step coarser. t = 0 (and every truncated layout)
  // is uniform 12h, expressed as "all slots at stage 1".
  const t = truncated ? 0 : seq - slots;
  const fine = t === 0 ? 1 : Math.ceil(t / slots) + 1;
  const nFine = t === 0 ? days : t - (fine - 2) * slots;

  const dayResolution: number[] = [];
  const periodHours: number[] = [];
  const periodStartUtcHour: number[] = [];
  for (let d = 0; d < days; d++) {
    const res = d < nFine ? fine : fine - 1;
    dayResolution.push(res);
    const h = RESOLUTION_HOURS[res];
    const dayStart = day0 + 24 * d;
    // Slot 0 starts at the period containing the request time; later slots at local midnight.
    const first = d === 0 ? dayStart + Math.floor((local - dayStart) / h) * h : dayStart;
    for (let s = first; s < dayStart + 24; s += h) {
      periodHours.push(h);
      periodStartUtcHour.push(s - utcOffsetHours);
    }
  }

  return { seq, durationDays, truncated, days, dayResolution, periodHours, periodStartUtcHour };
}
