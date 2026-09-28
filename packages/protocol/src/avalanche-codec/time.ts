// Issue times are carried in 15-minute steps: every archived bulletin was issued on a
// 15-minute mark, give or take a few seconds of publishing lag.
export const ISSUE_STEP_MS = 15 * 60 * 1000;

export const quantizeIssued = (ms: number): number => Math.floor(ms / ISSUE_STEP_MS) * ISSUE_STEP_MS;

const DAY_MS = 24 * 60 * 60 * 1000;

// Calendar dates as "YYYY-MM-DD".
export const utcDate = (ms: number): string => new Date(ms).toISOString().slice(0, 10);

export const addDays = (date: string, days: number): string => utcDate(Date.parse(date) + days * DAY_MS);

export const daysBetween = (from: string, to: string): number => Math.round((Date.parse(to) - Date.parse(from)) / DAY_MS);
