import type { Period } from "./model.js";

export interface VersionedCodec {
  encode(msg: ForecastMessage): string;
  decode(str: string): ForecastMessage;
}

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

export function startDatetime(msg: ForecastMessage): Date {
  const now = new Date();
  const d = new Date(now.getFullYear(), msg.month - 1, msg.day, msg.hour);
  if (now.getTime() - d.getTime() > 180 * 86400000) d.setFullYear(d.getFullYear() + 1);
  return d;
}
