import { describe, expect, it } from "vitest";
import {
  QUOTA_HARD, QUOTA_SOFT, hardLimit, monthStartUtc, overHard, quotaExceededReply, quotaHeader, quotaNow,
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
    expect(quotaHeader({ served: 0, hard: QUOTA_HARD, notified: false, subscribed: false })).toBe(`free:${QUOTA_SOFT - 1}`);
    expect(quotaHeader({ served: QUOTA_SOFT - 1, hard: QUOTA_HARD, notified: false, subscribed: false })).toBe("free:0");
  });

  it("is over from the first forecast past the stated quota", () => {
    expect(quotaHeader({ served: QUOTA_SOFT, hard: QUOTA_HARD, notified: false, subscribed: false })).toBe("over");
    expect(quotaHeader({ served: QUOTA_HARD, hard: QUOTA_HARD, notified: false, subscribed: false })).toBe("over");
  });
});

describe("quotaNow", () => {
  it("is the free forecasts left this month, down to zero", () => {
    expect(quotaNow({ served: 0, hard: QUOTA_HARD, notified: false, subscribed: false })).toEqual({ kind: "free", remaining: QUOTA_SOFT });
    expect(quotaNow({ served: QUOTA_SOFT, hard: QUOTA_HARD, notified: false, subscribed: false })).toEqual({ kind: "free", remaining: 0 });
  });

  it("is over past the stated quota, whatever the hard limit", () => {
    expect(quotaNow({ served: QUOTA_SOFT + 1, hard: QUOTA_HARD, notified: false, subscribed: false })).toEqual({ kind: "over" });
    expect(quotaNow({ served: QUOTA_HARD + 5, hard: QUOTA_SOFT, notified: true, subscribed: false })).toEqual({ kind: "over" });
  });

  it("is one forecast ahead of the header", () => {
    for (let served = 0; served <= QUOTA_HARD; served++) {
      const now = quotaNow({ served: served + 1, hard: QUOTA_HARD, notified: false, subscribed: false });
      const header = quotaHeader({ served, hard: QUOTA_HARD, notified: false, subscribed: false });
      expect(header).toBe(now.kind === "free" ? `free:${now.remaining}` : "over");
    }
  });
});

describe("a subscriber", () => {
  const sub = { served: QUOTA_HARD + 5, hard: QUOTA_SOFT, notified: true, subscribed: true };

  it("has no quota, is never over the hard limit, and the codec is told none", () => {
    expect(quotaNow(sub)).toEqual({ kind: "none" });
    expect(overHard(sub)).toBe(false);
    expect(quotaHeader(sub)).toBe("none");
  });
});

describe("overHard", () => {
  it("is reached when this month's served count meets the hard limit", () => {
    expect(overHard({ served: QUOTA_HARD - 1, hard: QUOTA_HARD, notified: false, subscribed: false })).toBe(false);
    expect(overHard({ served: QUOTA_HARD, hard: QUOTA_HARD, notified: false, subscribed: false })).toBe(true);
    expect(overHard({ served: QUOTA_SOFT, hard: QUOTA_SOFT, notified: false, subscribed: false })).toBe(true);
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
