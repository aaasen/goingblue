import tzlookup from 'tz-lookup';

// The forecast point's own clock. Everything the app shows about a forecast — hour labels, day
// names, the local-midnight grid the periods align to — belongs to the location, not to wherever
// the reader happens to be holding the phone. The two coincide in the common satellite-messaging
// case and diverge entirely when someone plans a trip from home.
//
// The lookup is offline: tz-lookup packs the world's timezone boundaries into a ~70KB string and
// resolves a coordinate to an IANA zone without a network call, which is the whole point in a tool
// meant to be useful past the edge of coverage. The zone's offset for a given instant then comes
// from Intl, so DST is applied as of the forecast rather than as of today.
//
// Two limits, both inherited from the protocol's whole-hour `z:` token (see layout.ts):
// half-hour zones — India, Chatham, Kathmandu — round to the nearest hour, and a DST transition
// inside the forecast window can't be represented at all, since a single offset is captured at
// request time and covers the whole horizon.

const MIN_OFFSET_HOURS = -12; // the range layout.ts validates `z:` against
const MAX_OFFSET_HOURS = 14;

// The device's own UTC offset, in whole hours. The fallback when a coordinate can't be resolved,
// and the honest answer when the reader is standing at the forecast point.
export function deviceOffsetHours(): number {
  return -Math.round(new Date().getTimezoneOffset() / 60);
}

// A zone's offset from UTC at `when`, in minutes. Formatting the instant as wall-clock fields in
// the zone and reading them back as if they were UTC recovers the offset, which needs nothing from
// Intl beyond `timeZone` support itself — the narrower `timeZoneName: 'longOffset'` option would
// be shorter, but it's ES2022 and an engine that lacks it still has everything used here.
function zoneOffsetMinutes(zone: string, when: number): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: zone,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(new Date(when));
  const field = (type: string) => Number(parts.find((p) => p.type === type)?.value);
  const asUtc = Date.UTC(
    field('year'), field('month') - 1, field('day'),
    field('hour'), field('minute'), field('second'),
  );
  // The reconstruction lands on a whole second; the instant may not, so round the difference back
  // to whole minutes rather than letting sub-second slop through.
  return Math.round((asUtc - when) / 60000);
}

// The forecast point's UTC offset in whole hours at a given instant — the `z:` request token and
// the axis the meteogram labels its columns on. Falls back to the device's offset if the
// coordinate is unresolvable or the engine's Intl can't take a `timeZone`, which leaves the app
// exactly where it stood before the lookup existed.
export function offsetHoursAt(lat: number, lon: number, when: number): number {
  try {
    const hours = Math.round(zoneOffsetMinutes(tzlookup(lat, lon), when) / 60);
    return Math.max(MIN_OFFSET_HOURS, Math.min(MAX_OFFSET_HOURS, hours));
  } catch {
    return deviceOffsetHours();
  }
}
