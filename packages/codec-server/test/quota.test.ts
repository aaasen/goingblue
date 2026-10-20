import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import { QUOTA_FREE_FORECASTS, WIRE_VERSION, headerFromString, wireCodec, type QuotaState } from "@weather/protocol";
import { fetchForecast, parseRequest } from "../src/forecast.js";
import { parseQuotaHeader } from "../src/quota.js";

describe("parseQuotaHeader", () => {
  it("reads the three states", () => {
    expect(parseQuotaHeader(undefined)).toEqual({ kind: "none" });
    expect(parseQuotaHeader("none")).toEqual({ kind: "none" });
    expect(parseQuotaHeader("over")).toEqual({ kind: "over" });
    expect(parseQuotaHeader("free:0")).toEqual({ kind: "free", remaining: 0 });
    expect(parseQuotaHeader(`free:${QUOTA_FREE_FORECASTS}`)).toEqual({ kind: "free", remaining: QUOTA_FREE_FORECASTS });
  });

  it("reads anything it does not recognize as none", () => {
    expect(parseQuotaHeader("")).toEqual({ kind: "none" });
    expect(parseQuotaHeader("free")).toEqual({ kind: "none" });
    expect(parseQuotaHeader("free:-1")).toEqual({ kind: "none" });
    expect(parseQuotaHeader(`free:${QUOTA_FREE_FORECASTS + 1}`)).toEqual({ kind: "none" });
    expect(parseQuotaHeader("FREE:2")).toEqual({ kind: "none" });
  });
});

// A screenshot fixture is a recorded weather request with its Open-Meteo bytes, which is enough
// to run the real fetch and encode path with no network. It was recorded under a longer variable
// list than the codec asks for now, and the codec reads response columns by name, so a recording
// whose `hourly` is a superset of the request's serves it.
const FIXTURE = JSON.parse(readFileSync(new URL("../../mobile/screenshots/fixtures/denali.json", import.meta.url), "utf8")) as {
  requests: { request: string; responses: Record<string, string> }[];
};

function stubUpstream(responses: Record<string, string>) {
  vi.stubGlobal("fetch", async (input: string | URL | Request) => {
    const want = new URL(String(input));
    const wantVars = new Set(want.searchParams.get("hourly")?.split(",") ?? []);
    for (const [key, body] of Object.entries(responses)) {
      const have = new URL(key, want.origin);
      const same = [...new Set([...have.searchParams.keys(), ...want.searchParams.keys()])]
        .filter((k) => k !== "hourly" && k !== "apikey")
        .every((k) => have.searchParams.get(k) === want.searchParams.get(k));
      const haveVars = new Set(have.searchParams.get("hourly")?.split(",") ?? []);
      if (have.pathname === want.pathname && same && [...wantVars].every((v) => haveVars.has(v))) {
        return new Response(Buffer.from(body, "base64"), { status: 200 });
      }
    }
    throw new Error(`unrecorded upstream request ${want.pathname}${want.search}`);
  });
}

describe("fetchForecast quota", () => {
  afterEach(() => vi.unstubAllGlobals());

  const entry = FIXTURE.requests[0]!;
  const params = parseRequest(entry.request.replace(/^v\d+/, `v${WIRE_VERSION}`));

  it.each<QuotaState>([
    { kind: "none" },
    { kind: "free", remaining: 3 },
    { kind: "free", remaining: 0 },
    { kind: "over" },
  ])("writes %o into the reply header", async (quota) => {
    stubUpstream(entry.responses);
    const { encoded } = await fetchForecast(params, wireCodec, quota);
    expect(headerFromString(encoded).quota).toEqual(quota);
  });

  it("writes none when no quota is given, with the body unchanged", async () => {
    stubUpstream(entry.responses);
    const plain = (await fetchForecast(params, wireCodec)).encoded;
    const over = (await fetchForecast(params, wireCodec, { kind: "over" })).encoded;
    expect(headerFromString(plain).quota).toEqual({ kind: "none" });
    expect(plain.length).toBe(over.length);
    expect(plain.slice(wireCodec.headerChars)).toBe(over.slice(wireCodec.headerChars));
  });
});
