import { readFileSync } from "node:fs";
import { gunzipSync } from "node:zlib";
import { afterEach, describe, it, expect, vi } from "vitest";
import {
  AVALANCHE_PIECES, DEVICE_TRANSPORT, WIRE_HEADER_CHARS, avalancheModelFile, decodeAvalancheMessage, loadModels,
  pieceAt, reassembleReply, withPlaceholders,
} from "@weather/protocol";
import { serveAvalanche } from "../src/avalanche.ts";
import { parseRequest } from "../src/forecast.ts";
import { isRated, NWAC_ZONE_IDS, toForecast, validDate, type NacProduct } from "../src/nac.ts";

// Recorded from the product endpoint: a Stevens Pass forecast, the off-season summary, and a Mt Hood
// forecast whose location is not every combination of its aspects and bands.
const fixture = (name: string) => JSON.parse(readFileSync(new URL(`fixtures/${name}`, import.meta.url), "utf8")) as NacProduct;
const STEVENS = fixture("nac-nwac-stevens-2026-01-08.json");
const SUMMARY = fixture("nac-nwac-summary-2026-09-15.json");
const CELLS = fixture("nac-nwac-cells.json");

const MODELS = loadModels(gunzipSync(readFileSync(new URL("../../protocol/assets/nwac-model.bin.gz", import.meta.url))));
const STEVENS_PIECE = AVALANCHE_PIECES.find((p) => p.center === "nwac" && p.names[0] === "Stevens Pass")!;
const [STEVENS_LAT, STEVENS_LON] = ["47.7500", "-121.0900"];
const ANCHOR = Date.parse("2026-01-08T19:00:00Z");

const request = (tokens: string, lat = STEVENS_LAT, lon = STEVENS_LON) =>
  parseRequest(`v8 ${lat},${lon} f:a u:0000000000000000 k:42 t:${ANCHOR / 3600000} ${tokens}`);

// One row of the listing per product; rows leave out the prose.
const row = (p: NacProduct, over: Partial<NacProduct> = {}) => ({
  id: p.id, product_type: p.product_type, published_time: p.published_time, expires_time: p.expires_time,
  updated_at: p.updated_at, forecast_zone: p.forecast_zone, ...over,
});

function answer(handler: (url: URL) => unknown, status = 200) {
  const fetch = vi.fn(async (url: URL) => new Response(JSON.stringify(handler(url)), { status }));
  vi.stubGlobal("fetch", fetch);
  return fetch;
}

afterEach(() => vi.unstubAllGlobals());

describe("toForecast", () => {
  const f = toForecast(STEVENS, STEVENS_PIECE);

  it("maps the danger days onto the dates they apply to", () => {
    expect(f.danger).toEqual([
      { date: "2026-01-08", btl: "considerable", tln: "considerable", alp: "high" },
      { date: "2026-01-09", btl: "moderate", tln: "considerable", alp: "considerable" },
    ]);
  });

  it("maps problems in rank order onto the protocol's scales", () => {
    expect(f.problems.map((p) => [p.type, p.likelihood, p.size])).toEqual([
      ["windSlab", "veryLikely", { min: 2, max: 3 }],
      ["stormSlab", "likely", { min: 1, max: 2 }],
    ]);
    expect(f.problems[0].elevations).toEqual(["tln", "alp"]);
    expect(f.problems[0].aspects).toHaveLength(8);
    expect(f.problems[0].cells).toBeUndefined();
  });

  it("reduces the prose to text and leaves out what the center doesn't publish", () => {
    expect(f.bottomLine).toMatch(/^Expect very dangerous conditions/);
    expect(f.hazardDiscussion).toMatch(/^Thursday will be another blustery/);
    expect(f.hazardDiscussion).not.toMatch(/<|&\w+;/);
    expect(f).toMatchObject({ center: "nwac", region: "Stevens Pass", pieces: [STEVENS_PIECE.id], advice: [], weather: [], snowpackSummary: "" });
    expect(f.confidence).toEqual({ rating: "noRating", statements: [] });
  });

  it("keeps the exact cells of a location that isn't every combination", () => {
    const wetLoose = toForecast(CELLS, STEVENS_PIECE).problems.find((p) => p.cells)!;
    expect(wetLoose.cells).toHaveLength(19);
    expect(wetLoose.elevations).toEqual(["btl", "tln", "alp"]);
    expect(wetLoose.aspects).toHaveLength(7);
  });

  it("maps an empty band to no rating and a summary to no danger and no problems", () => {
    const empty = { ...STEVENS, danger: [{ valid_day: "current", upper: 2, middle: null, lower: 0 }] };
    expect(toForecast(empty, STEVENS_PIECE).danger[0]).toMatchObject({ alp: "moderate", tln: "noRating", btl: "noRating" });
    const summary = toForecast(SUMMARY, STEVENS_PIECE);
    expect(summary.danger).toEqual([]);
    expect(summary.problems).toEqual([]);
    expect(summary.hazardDiscussion).not.toBe("");
    expect(isRated(SUMMARY)).toBe(false);
    expect(isRated(STEVENS)).toBe(true);
  });

  it("throws on values it doesn't know", () => {
    const problem = STEVENS.forecast_avalanche_problems![0];
    const withProblem = (over: object) => ({ ...STEVENS, forecast_avalanche_problems: [{ ...problem, ...over }] });
    expect(() => toForecast(withProblem({ name: "Slush Flow" }), STEVENS_PIECE)).toThrow(/unknown problem type/);
    expect(() => toForecast(withProblem({ likelihood: "maybe" }), STEVENS_PIECE)).toThrow(/unknown likelihood/);
    expect(() => toForecast(withProblem({ location: ["up upper"] }), STEVENS_PIECE)).toThrow(/unknown aspect/);
    expect(() => toForecast({ ...STEVENS, danger: [{ valid_day: "current", upper: 9, middle: 1, lower: 1 }] }, STEVENS_PIECE)).toThrow(/unknown danger rating/);
    expect(() => toForecast({ ...STEVENS, danger: [{ valid_day: "later", upper: 1, middle: 1, lower: 1 }] }, STEVENS_PIECE)).toThrow(/unknown valid day/);
  });
});

describe("validDate", () => {
  it("dates a product published at or after local noon as the next day", () => {
    expect(validDate("2026-01-08T02:00:00+00:00")).toBe("2026-01-08"); // 18:00 PST on the 7th
    expect(validDate("2026-01-07T19:59:00+00:00")).toBe("2026-01-07"); // 11:59 PST
    expect(validDate("2026-01-07T20:00:00+00:00")).toBe("2026-01-08"); // 12:00 PST
    expect(validDate("2026-04-17T01:30:00+00:00")).toBe("2026-04-17"); // 18:30 PDT on the 16th
  });
});

describe("zones", () => {
  it("knows the API's id for every NWAC piece", () => {
    const pieces = AVALANCHE_PIECES.filter((p) => p.center === "nwac");
    expect(pieces).toHaveLength(10);
    for (const p of pieces) expect(NWAC_ZONE_IDS[p.names[0]], p.names[0]).toBeTypeOf("number");
  });

  it("chooses the model from the point on both sides of the 49th parallel", () => {
    // Mt Baker, in West Slopes North, and Manning Park just north of it.
    expect(pieceAt(48.78, -121.81)?.center).toBe("nwac");
    expect(avalancheModelFile(48.78, -121.81)).toBe("nwac-model.bin.gz");
    expect(pieceAt(49.06, -120.8)?.center).toBe("avalanche-canada");
    expect(avalancheModelFile(49.06, -120.8)).toBe("avcan-model.bin.gz");
    // Seattle is in no piece, and the model of a point in no piece is Avalanche Canada's.
    expect(pieceAt(47.6, -122.33)).toBeNull();
    expect(avalancheModelFile(47.6, -122.33)).toBe("avcan-model.bin.gz");
  });
});

describe("serveAvalanche for an NWAC zone", () => {
  it("asks avalanche.org for the zone's latest product, with no Origin", async () => {
    const fetch = answer(() => STEVENS);
    const result = await serveAvalanche(request("d:d"));
    expect(fetch).toHaveBeenCalledOnce();
    const [url, init] = fetch.mock.calls[0] as unknown as [URL, RequestInit];
    expect(url.host).toBe("api.avalanche.org");
    expect(url.pathname).toBe("/v2/public/product");
    expect(Object.fromEntries(url.searchParams)).toEqual({ type: "forecast", center_id: "NWAC", zone_id: "3024" });
    expect(init.headers).toBeUndefined();
    if (result.kind !== "ok") throw new Error(result.kind);
    const { code, forecast } = decodeAvalancheMessage(MODELS, result.replies[0], ANCHOR, "base94");
    expect(code).toBe(42);
    expect(forecast).toEqual(withPlaceholders(toForecast(STEVENS, STEVENS_PIECE)));
    expect(forecast.pieces).toEqual([STEVENS_PIECE.id]);
  });

  it.each(["i", "g", "z", "s"] as const)("round-trips over as many messages as it needs on d:%s", async (device) => {
    answer(() => STEVENS);
    const result = await serveAvalanche(request(`d:${device}`));
    if (result.kind !== "ok") throw new Error(result.kind);
    const whole = reassembleReply(result.replies.join("\n"), () => WIRE_HEADER_CHARS);
    const { forecast } = decodeAvalancheMessage(MODELS, whole, ANCHOR, DEVICE_TRANSPORT[device].alphabet);
    expect(forecast).toEqual(withPlaceholders(toForecast(STEVENS, STEVENS_PIECE)));
  });

  it("round-trips the off-season summary and exact cells", async () => {
    for (const product of [SUMMARY, CELLS]) {
      answer(() => product);
      const anchor = Date.parse(product.published_time) + 3600000;
      const result = await serveAvalanche(parseRequest(`v8 ${STEVENS_LAT},${STEVENS_LON} f:a d:d u:0000000000000000 k:1 t:${Math.floor(anchor / 3600000)}`));
      if (result.kind !== "ok") throw new Error(result.kind);
      const { forecast } = decodeAvalancheMessage(MODELS, result.replies[0], Math.floor(anchor / 3600000) * 3600000, "base94");
      expect(forecast).toEqual(withPlaceholders(toForecast(product, STEVENS_PIECE)));
    }
  });

  it("finds a dated product in the listing and fetches it by id, latest publication first", async () => {
    const stevensZone = STEVENS.forecast_zone;
    const fetch = answer((url) => url.pathname.endsWith("/products")
      ? [
          row(STEVENS, { id: 1, published_time: "2026-01-07T02:00:00+00:00" }), // the day before
          row(STEVENS, { id: 2, updated_at: null }), // a stub
          row(STEVENS, { id: 3, forecast_zone: [{ id: 3020, name: "Olympics" }] }), // another zone
          row(STEVENS, { id: 4, product_type: "synopsis" }),
          row(STEVENS, { id: 5, published_time: "2026-01-08T02:00:00+00:00", forecast_zone: stevensZone }),
          row(STEVENS, { id: STEVENS.id, published_time: "2026-01-08T15:00:00+00:00", forecast_zone: [{ id: 3020, name: "Olympics" }, ...stevensZone!] }), // a reissue
        ]
      : STEVENS);
    const result = await serveAvalanche(request("d:d y:20260108"));
    expect(result.kind).toBe("ok");
    const urls = fetch.mock.calls.map((c) => c[0] as URL);
    expect(Object.fromEntries(urls[0].searchParams)).toEqual({ avalanche_center_id: "NWAC", date_start: "2026-01-07", date_end: "2026-01-09" });
    expect(urls[1].pathname).toBe(`/v2/public/product/${STEVENS.id}`);
  });

  it("falls back to the product still in force on a day with none of its own", async () => {
    const summary = row(SUMMARY, { expires_time: SUMMARY.expires_time });
    const lapsed = row(SUMMARY, { id: 1, published_time: "2026-04-20T01:30:00+00:00", expires_time: "2026-09-01T00:00:00+00:00" });
    const later = row(SUMMARY, { id: 2, published_time: "2026-10-21T00:00:00+00:00", expires_time: "2026-11-21T02:30:00+00:00" });
    const fetch = answer((url) => url.pathname.endsWith("/products")
      ? (url.searchParams.get("date_start") === "2026-10-19" ? [] : [lapsed, summary, later])
      : SUMMARY);
    const day = parseRequest(`v8 ${STEVENS_LAT},${STEVENS_LON} f:a d:d u:0000000000000000 k:1 t:${Date.parse("2026-11-01T00:00:00Z") / 3600000} y:20261020`);
    const result = await serveAvalanche(day);
    if (result.kind !== "ok") throw new Error(result.kind);
    const urls = fetch.mock.calls.map((c) => c[0] as URL);
    expect(urls.map((u) => u.searchParams.get("date_start"))).toEqual(["2026-10-19", "2025-11-15", null]);
    expect(urls[2].pathname).toBe(`/v2/public/product/${SUMMARY.id}`);
    const { forecast } = decodeAvalancheMessage(MODELS, result.replies[0], Date.parse("2026-10-20T19:00:00Z"), "base94");
    expect(forecast).toEqual(withPlaceholders(toForecast(SUMMARY, STEVENS_PIECE)));
  });

  it("answers no_forecast for a day nothing covers, a stub, and the API's empty answer", async () => {
    answer(() => []);
    expect(await serveAvalanche(request("d:s y:20260108"))).toEqual({ kind: "no_forecast" });
    answer(() => [row(SUMMARY, { published_time: "2025-11-01T00:00:00+00:00", expires_time: "2025-12-01T00:00:00+00:00" })]);
    expect(await serveAvalanche(request("d:s y:20260108"))).toEqual({ kind: "no_forecast" });
    answer(() => ({ ...STEVENS, updated_at: null }));
    expect(await serveAvalanche(request("d:s"))).toEqual({ kind: "no_forecast" });
    answer(() => ({ published_time: null, expires_time: null, created_at: null, updated_at: null }));
    expect(await serveAvalanche(request("d:s"))).toEqual({ kind: "no_forecast" });
  });

  it("surfaces an API failure rather than answering no forecast", async () => {
    answer(() => ({}), 500);
    await expect(serveAvalanche(request("d:s"))).rejects.toThrow(/nac: HTTP 500/);
  });

  it("still asks Avalanche Canada for a point outside NWAC's zones", async () => {
    const fetch = answer(() => ({ id: "" }));
    expect(await serveAvalanche(request("d:s", "49.0600", "-120.8000"))).toEqual({ kind: "no_forecast" });
    expect((fetch.mock.calls[0][0] as URL).host).toBe("api.avalanche.ca");
  });
});
