// Issue times are carried in 15-minute steps: every archived bulletin was issued on a
// 15-minute mark, give or take a few seconds of publishing lag.
export const ISSUE_STEP_MS = 15 * 60 * 1000;

export const quantizeIssued = (ms: number): number => Math.floor(ms / ISSUE_STEP_MS) * ISSUE_STEP_MS;
