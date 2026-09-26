import { readFileSync } from "node:fs";
import { gunzipSync } from "node:zlib";
import { afterEach, describe, it, expect, vi } from "vitest";
import {
  DEVICE_TRANSPORT, WIRE_HEADER_CHARS, decodeAvalancheMessage, headerFromString, loadModels,
  reassembleReply, withPlaceholders,
} from "@weather/protocol";
import { serveAvalanche } from "../src/avalanche.ts";
import { toForecast, type RawProduct } from "../src/avcan.ts";
import { parseRequest } from "../src/forecast.ts";

// Recorded from the point endpoint: the Sea to Sky bulletin valid 2026-03-01, and what the API
// answers for a point no center forecasts. The areas response is cut down to the Sea to Sky area.
const fixture = (name: string) => JSON.parse(readFileSync(new URL(`fixtures/${name}`, import.meta.url), "utf8")) as unknown;
const SEA_TO_SKY = fixture("avcan-point-sea-to-sky-2026-03-01.json") as RawProduct;
const EMPTY = fixture("avcan-point-empty.json");
const AREAS = fixture("avcan-areas-sea-to-sky-2026-03-01.json");
const SEA_TO_SKY_PIECES = [6, 27, 32, 67, 72, 76];

const MODELS = loadModels(gunzipSync(readFileSync(new URL("../../protocol/assets/avcan-model.bin.gz", import.meta.url))));
const ISSUED_HOUR = Date.parse(SEA_TO_SKY.report.dateIssued) / 3600000;

// The point endpoint answers with `body`; the areas endpoint with `areas`.
function answer(body: unknown, status = 200, areas: { body: unknown; status: number } = { body: AREAS, status: 200 }) {
  const fetch = vi.fn(async (url: URL) => url.pathname.endsWith("/areas")
    ? new Response(JSON.stringify(areas.body), { status: areas.status })
    : new Response(JSON.stringify(body), { status }));
  vi.stubGlobal("fetch", fetch);
  return fetch;
}

const request = (tokens: string, startEpochHour = ISSUED_HOUR + 19) =>
  parseRequest(`v5 50.1163,-122.9574 f:a u:0000000000000000 k:42 t:${startEpochHour} ${tokens}`);

afterEach(() => vi.unstubAllGlobals());

describe("serveAvalanche", () => {
  it("fetches the requested day and encodes the whole bulletin", async () => {
    const fetch = answer(SEA_TO_SKY);
    const params = request("d:d y:20260301");
    const result = await serveAvalanche(params);
    const url = fetch.mock.calls[0][0];
    expect(url.searchParams.get("lat")).toBe("50.1163");
    expect(url.searchParams.get("long")).toBe("-122.9574");
    expect(url.searchParams.get("date")).toBe("2026-03-01T19:00:00.000Z");
    if (result.kind !== "ok") throw new Error(result.kind);
    expect(result.replies).toHaveLength(1);
    // The code sits where a weather header keeps it.
    expect(headerFromString(result.replies[0]).code).toBe(42);
    const { code, forecast } = decodeAvalancheMessage(MODELS, result.replies[0], Date.parse("2026-03-01T19:00:00Z"), "base94");
    expect(code).toBe(42);
    expect(forecast).toEqual(withPlaceholders(toForecast(SEA_TO_SKY, SEA_TO_SKY_PIECES)));
    expect(forecast.pieces).toEqual(SEA_TO_SKY_PIECES);
    expect(forecast.issued).toBe(Date.parse("2026-03-01T00:00:00Z"));
    expect(forecast.expires).toBe(Date.parse("2026-03-02T00:00:00Z"));
  });

  it.each(["i", "g", "z", "s"] as const)("splits over as many messages as the bulletin needs on d:%s", async (device) => {
    answer(SEA_TO_SKY);
    const result = await serveAvalanche(request(`d:${device} y:20260301`));
    if (result.kind !== "ok") throw new Error(result.kind);
    const whole = reassembleReply(result.replies.join("\n"), () => WIRE_HEADER_CHARS);
    const { alphabet, maxChars } = DEVICE_TRANSPORT[device];
    if (device === "i") expect(result.replies.length).toBeGreaterThan(1);
    if (result.replies.length === 1 && device !== "s") expect(whole.length).toBeLessThanOrEqual(maxChars);
    const { forecast } = decodeAvalancheMessage(MODELS, whole, Date.parse("2026-03-01T19:00:00Z"), alphabet);
    expect(forecast).toEqual(withPlaceholders(toForecast(SEA_TO_SKY, SEA_TO_SKY_PIECES)));
  });

  it("asks for the current bulletin when no day is given, anchored to the request time", async () => {
    const fetch = answer(SEA_TO_SKY);
    const result = await serveAvalanche(request("d:g", ISSUED_HOUR + 3));
    expect(fetch.mock.calls[0][0].searchParams.has("date")).toBe(false);
    if (result.kind !== "ok") throw new Error(result.kind);
    const whole = reassembleReply(result.replies.join("\n"), () => WIRE_HEADER_CHARS);
    const { forecast } = decodeAvalancheMessage(MODELS, whole, (ISSUED_HOUR + 3) * 3600000, "base85");
    expect(forecast.issued).toBe(Date.parse("2026-03-01T00:00:00Z"));
  });

  it("reports no forecast when the API answers with an empty product", async () => {
    answer(EMPTY);
    expect(await serveAvalanche(request("d:s"))).toEqual({ kind: "no_forecast" });
  });

  it("fails when the API does", async () => {
    answer({}, 500);
    await expect(serveAvalanche(request("d:s"))).rejects.toThrow(/HTTP 500/);
  });

  // Each case uses an area no earlier test has cached.
  it("fetches the areas in force on the requested day and remembers what an area covers", async () => {
    const product = { ...SEA_TO_SKY, area: { id: "cached-area" } };
    const areas = { type: "FeatureCollection", features: [{ ...(AREAS as { features: object[] }).features[0], id: "cached-area" }] };
    const fetch = answer(product, 200, { body: areas, status: 200 });
    await serveAvalanche(request("d:s y:20260301"));
    const areasUrl = fetch.mock.calls[1][0];
    expect(areasUrl.pathname).toBe("/forecasts/en/areas");
    expect(areasUrl.searchParams.get("date")).toBe("2026-03-01T19:00:00.000Z");
    await serveAvalanche(request("d:s y:20260301"));
    expect(fetch.mock.calls.filter(([url]) => url.pathname.endsWith("/areas"))).toHaveLength(1);
  });

  it("fails when the areas endpoint does or lacks the product's area", async () => {
    answer({ ...SEA_TO_SKY, area: { id: "failing-area" } }, 200, { body: {}, status: 503 });
    await expect(serveAvalanche(request("d:s"))).rejects.toThrow(/areas: HTTP 503/);
    answer({ ...SEA_TO_SKY, area: { id: "missing-area" } });
    await expect(serveAvalanche(request("d:s"))).rejects.toThrow(/no area missing-area/);
  });
});
