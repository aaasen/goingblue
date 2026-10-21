import { afterEach, describe, expect, it, vi } from "vitest";
import { AGREEMENT_CENTERS } from "@weather/protocol";
import { fetchAgreementHourly } from "../src/forecast.js";
import { describeError } from "../src/log.js";

// A secondary center's fetch failing fails the request rather than leaving that center out of
// the agreement column: the gateway retries an unavailable codec, so the reply that goes out
// carries every center.
describe("fetchAgreementHourly", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("rejects when a center's fetch fails, naming the center", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("ECONNRESET"); }));
    const err = await fetchAgreementHourly("BEST", 5, 63.06, -151.08, "UTC").catch((e: unknown) => e);
    expect(describeError(err)).toMatch(/^agreement fetch failed for \w+: ECONNRESET$/);
  });

  it("retries a connection that failed before any response, then reports the cause", async () => {
    let calls = 0;
    vi.stubGlobal("fetch", vi.fn(async () => {
      calls++;
      const cause = Object.assign(new Error("other side closed"), { code: "UND_ERR_SOCKET" });
      throw new TypeError("fetch failed", { cause });
    }));
    const err = await fetchAgreementHourly("US", 5, 63.06, -151.08, "UTC").catch((e: unknown) => e);
    await vi.waitFor(() => expect(calls).toBe((AGREEMENT_CENTERS.length - 1) * 3));
    expect(describeError(err)).toMatch(/^agreement fetch failed for \w+: fetch failed: UND_ERR_SOCKET other side closed$/);
  });

  it("fetches every center but the served one", async () => {
    const calls: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request) => {
      calls.push(String(input));
      throw new Error("ECONNRESET");
    }));
    await fetchAgreementHourly("US", 5, 63.06, -151.08, "UTC").catch(() => {});
    expect(calls.length).toBe(AGREEMENT_CENTERS.length - 1);
    expect(calls.some((u) => u.includes("models=gfs_seamless"))).toBe(false);
  });
});
