import { describe, expect, it } from "vitest";
import { FILL_SLOTS } from "@weather/protocol";
import { requestWindow } from "../src/forecast.js";

// A fixed clock: 2026-09-04T02:15Z, the moment the first stale request seen in production
// arrived. The axis it implies runs from 2026-09-03T00:00Z (past_days=1) for FILL_SLOTS + 2 days.
const NOW_MS = Date.parse("2026-09-04T02:15:00Z");
const hour = (iso: string) => Date.parse(iso) / 3600000;

describe("requestWindow", () => {
  it("accepts a start anywhere on the fetched axis", () => {
    expect(requestWindow(hour("2026-09-03T00:00Z"), NOW_MS)).toBe("ok");
    expect(requestWindow(hour("2026-09-04T02:00Z"), NOW_MS)).toBe("ok");
    expect(requestWindow(hour("2026-09-04T03:00Z"), NOW_MS)).toBe("ok");
  });

  it("is stale from the first hour before the axis", () => {
    expect(requestWindow(hour("2026-09-02T23:00Z"), NOW_MS)).toBe("stale");
    // The production request: t:496754 = 2026-09-02T02:00Z, 48 hours old on arrival.
    expect(requestWindow(496754, NOW_MS)).toBe("stale");
  });

  it("is future from the first hour past the axis", () => {
    const end = hour("2026-09-04T00:00Z") + (FILL_SLOTS + 2) * 24;
    expect(requestWindow(end - 1, NOW_MS)).toBe("ok");
    expect(requestWindow(end, NOW_MS)).toBe("future");
  });
});
