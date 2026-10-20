import { describe, expect, it } from "vitest";
import {
  QUOTA_HARD, QUOTA_SOFT, hardLimit, monthStartUtc, overHard, quotaExceededReply, quotaHeader,
} from "../src/quota.js";

// The rules on top of the monthly count. The count itself is one SQL query (quotaStatus) and is
// exercised against the database, not here.

describe("monthStartUtc", () => {
  it("is the first instant of the UTC month, whatever the local day", () => {
    expect(monthStartUtc(new Date("2026-10-20T23:30:00Z"))).toEqual(new Date("2026-10-01T00:00:00Z"));
    expect(monthStartUtc(new Date("2026-10-01T00:00:00Z"))).toEqual(new Date("2026-10-01T00:00:00Z"));
  });

  it("steps across the year boundary in both directions", () => {
    expect(monthStartUtc(new Date("2026-12-15T12:00:00Z"), 1)).toEqual(new Date("2027-01-01T00:00:00Z"));
    expect(monthStartUtc(new Date("2026-01-15T12:00:00Z"), -1)).toEqual(new Date("2025-12-01T00:00:00Z"));
  });
});

describe("hardLimit", () => {
  it("is the hard limit after a month under or at the stated quota", () => {
    expect(hardLimit(0)).toBe(QUOTA_HARD);
    expect(hardLimit(QUOTA_SOFT)).toBe(QUOTA_HARD);
  });

  it("drops to the stated quota after a month over it", () => {
    expect(hardLimit(QUOTA_SOFT + 1)).toBe(QUOTA_SOFT);
    expect(hardLimit(QUOTA_HARD)).toBe(QUOTA_SOFT);
  });
});

describe("quotaHeader", () => {
  it("counts the free forecasts left after this one", () => {
    expect(quotaHeader({ served: 0, hard: QUOTA_HARD, notified: false })).toBe(`free:${QUOTA_SOFT - 1}`);
    expect(quotaHeader({ served: QUOTA_SOFT - 1, hard: QUOTA_HARD, notified: false })).toBe("free:0");
  });

  it("is over from the first forecast past the stated quota", () => {
    expect(quotaHeader({ served: QUOTA_SOFT, hard: QUOTA_HARD, notified: false })).toBe("over");
    expect(quotaHeader({ served: QUOTA_HARD, hard: QUOTA_HARD, notified: false })).toBe("over");
  });
});

describe("overHard", () => {
  it("is reached when this month's served count meets the hard limit", () => {
    expect(overHard({ served: QUOTA_HARD - 1, hard: QUOTA_HARD, notified: false })).toBe(false);
    expect(overHard({ served: QUOTA_HARD, hard: QUOTA_HARD, notified: false })).toBe(true);
    expect(overHard({ served: QUOTA_SOFT, hard: QUOTA_SOFT, notified: false })).toBe(true);
  });
});

describe("quotaExceededReply", () => {
  it("names the first of the month the limit resets on", () => {
    expect(quotaExceededReply(new Date("2026-11-01T00:00:00Z"))).toBe(
      "Free weather forecast limit exceeded. Limit resets November 1. " +
      "Going Blue will stop responding until then. Subscribe for unlimited forecasts.");
  });

  it("fits one GSM-7 segment in every month", () => {
    for (let m = 0; m < 12; m++) {
      const text = quotaExceededReply(new Date(Date.UTC(2027, m, 1)));
      expect(text.length).toBeLessThanOrEqual(160);
      expect(text).toMatch(/^[\x20-\x7e]+$/);
    }
  });
});
