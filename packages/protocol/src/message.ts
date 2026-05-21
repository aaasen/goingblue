import { VERSION, HEADER_BITS, HEADER_CHARS, RESOLUTION_HOURS, periodBitsForMask, nCharsForBits, LAT_BITS, LON_BITS, ELEV_BITS } from "./constants.js";
import { putInt, takeInt } from "./bits.js";
import { encode, decode } from "./codec.js";
import { type Period, periodToBits, periodFromBits } from "./period.js";

export interface ForecastMessage {
  version: number;
  location: number;
  days: number;
  resolution: number;
  models_mask: number;
  vars_mask: number;
  month: number;
  day: number;
  hour: number;
  lat: number;
  lon: number;
  elevation: number;
  periods: Period[][];
}

// Message format: encode(headerBits)[7 chars] + encode(bodyBits)[variable]
// This lets the decoder read vars_mask from the header before knowing period size.
export function messageToString(msg: ForecastMessage): string {
  const headerBits: number[] = [];
  putInt(headerBits, msg.version, 7);
  putInt(headerBits, msg.location, 3);
  putInt(headerBits, msg.days - 1, 4);
  putInt(headerBits, msg.resolution, 3);
  putInt(headerBits, msg.models_mask, 4);
  putInt(headerBits, msg.vars_mask, 14);
  putInt(headerBits, msg.month, 4);
  putInt(headerBits, msg.day, 5);
  putInt(headerBits, msg.hour, 5);
  putInt(headerBits, Math.round((msg.lat + 90) * ((1 << LAT_BITS) - 1) / 180), LAT_BITS);
  putInt(headerBits, Math.round((msg.lon + 180) * ((1 << LON_BITS) - 1) / 360), LON_BITS);
  putInt(headerBits, Math.min(Math.max(Math.round(msg.elevation), 0), (1 << ELEV_BITS) - 1), ELEV_BITS);

  const bodyBits: number[] = [];
  const nPeriods = msg.periods[0].length;
  for (let i = 0; i < nPeriods; i++) {
    for (const modelPeriods of msg.periods) {
      bodyBits.push(...periodToBits(modelPeriods[i], msg.vars_mask));
    }
  }

  return encode(headerBits) + encode(bodyBits);
}

export function messageFromString(s: string): ForecastMessage {
  if (s.length < HEADER_CHARS)
    throw new Error(`Unexpected message length: ${s.length} chars`);

  const headerBits = decode(s.slice(0, HEADER_CHARS), HEADER_BITS);
  let pos = 0;

  let version: number, location: number, daysRaw: number, resolution: number,
      models_mask: number, vars_mask: number, month: number, day: number, hour: number;
  [version,     pos] = takeInt(headerBits, pos, 7);
  [location,    pos] = takeInt(headerBits, pos, 3);
  [daysRaw,     pos] = takeInt(headerBits, pos, 4);
  [resolution,  pos] = takeInt(headerBits, pos, 3);
  [models_mask, pos] = takeInt(headerBits, pos, 4);
  [vars_mask,   pos] = takeInt(headerBits, pos, 14);
  [month,       pos] = takeInt(headerBits, pos, 4);
  [day,         pos] = takeInt(headerBits, pos, 5);
  [hour,        pos] = takeInt(headerBits, pos, 5);
  let lat_raw: number, lon_raw: number, elevation: number;
  [lat_raw,   pos] = takeInt(headerBits, pos, LAT_BITS);
  [lon_raw,   pos] = takeInt(headerBits, pos, LON_BITS);
  [elevation, pos] = takeInt(headerBits, pos, ELEV_BITS);
  const lat = lat_raw * 180 / ((1 << LAT_BITS) - 1) - 90;
  const lon = lon_raw * 360 / ((1 << LON_BITS) - 1) - 180;

  if (version !== VERSION)
    throw new Error(`Version mismatch: encoded v${version}, expected v${VERSION}`);

  const resHours = RESOLUTION_HOURS[resolution] ?? 24;
  const periodsPerDay = resHours >= 24 ? 1 : 24 / resHours;
  const nPeriods = (daysRaw + 1) * periodsPerDay;
  const nModels = popcount(models_mask);
  const periodBits = periodBitsForMask(vars_mask);
  const totalBodyBits = nPeriods * nModels * periodBits;

  const expectedBodyChars = nCharsForBits(totalBodyBits);
  const actualBodyChars = s.length - HEADER_CHARS;
  if (actualBodyChars !== expectedBodyChars)
    throw new Error(`Unexpected message length: ${s.length} chars`);

  const bodyBits = decode(s.slice(HEADER_CHARS), totalBodyBits);
  pos = 0;

  const allPeriods: Period[][] = Array.from({ length: nModels }, () => []);
  for (let i = 0; i < nPeriods; i++) {
    for (let m = 0; m < nModels; m++) {
      const [p, nextPos] = periodFromBits(bodyBits, pos, vars_mask);
      pos = nextPos;
      allPeriods[m].push(p);
    }
  }

  return { version, location, days: daysRaw + 1, resolution, models_mask, vars_mask, month, day, hour, lat, lon, elevation, periods: allPeriods };
}

export function startDatetime(msg: ForecastMessage): Date {
  const now = new Date();
  const d = new Date(now.getFullYear(), msg.month - 1, msg.day, msg.hour);
  if (now.getTime() - d.getTime() > 180 * 86400000) d.setFullYear(d.getFullYear() + 1);
  return d;
}

function popcount(n: number): number {
  let c = 0;
  while (n) { c += n & 1; n >>>= 1; }
  return c;
}
