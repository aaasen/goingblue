import { afterEach, describe, expect, it, vi } from "vitest";
import { generateToken } from "@weather/protocol";
import { codecUrlFor, dispatchForecast, extractUserToken, extractVersion, parseShapeHeader } from "../src/dispatch.js";

// A real token so extraction exercises the same validity check parseRequest applies.
const TOKEN = generateToken((n) => Uint8Array.from({ length: n }, (_, i) => i * 7 + 3));

describe("extractVersion", () => {
  it("finds the vN word anywhere in the body", () => {
    expect(extractVersion("v1 63.0630,-151.0810 p:a c:160")).toBe(1);
    expect(extractVersion("63.0630,-151.0810 v12 p:a")).toBe(12);
  });

  it("is null when no version word is present — there is no default", () => {
    expect(extractVersion("")).toBeNull();
    expect(extractVersion("63.0630,-151.0810 p:a c:160")).toBeNull();
  });

  it("ignores near-misses: v: variable tokens and non-numeric words", () => {
    expect(extractVersion("v:cwf p:a")).toBeNull();
    expect(extractVersion("very nice weather")).toBeNull();
  });

  it("is case-insensitive, matching the lowercased parse in the codec", () => {
    expect(extractVersion("V2 p:a")).toBe(2);
  });
});

describe("extractUserToken", () => {
  it("returns the normalized token from a u: word", () => {
    expect(extractUserToken(`v1 u:${TOKEN.toLowerCase()} p:a`)).toBe(TOKEN);
  });

  it("is null when absent or malformed", () => {
    expect(extractUserToken("v1 p:a")).toBeNull();
    expect(extractUserToken("v1 u:notatoken p:a")).toBeNull();
  });
});

// Any id will do here: dispatch never reads either one, it only puts them on the wire.
const RID = "8f6b1c2e-0000-4000-8000-000000000001";
const TRACE = "0123456789abcdef0123456789abcdef";

describe("dispatchForecast", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    delete process.env["CODEC_URL_V1"];
  });

  it("reports a missing version without calling any codec", async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    expect(await dispatchForecast("63.0630,-151.0810 p:a", RID, null)).toEqual({ kind: "missing_version" });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("reports an unmapped version as unsupported (never existed or sunset)", async () => {
    expect(await dispatchForecast("v9 p:a", RID, null)).toEqual({ kind: "unsupported_version", version: 9 });
  });

  it("forwards the raw body to the mapped codec and relays its reply", async () => {
    process.env["CODEC_URL_V1"] = "http://codec-v1";
    const body = "v1 63.0630,-151.0810 p:a c:160";
    const fetchSpy = vi.fn(async () => new Response("ENCODED", { status: 200 }));
    vi.stubGlobal("fetch", fetchSpy);

    expect(await dispatchForecast(body, RID, null)).toEqual({
      kind: "ok", encoded: "ENCODED", shape: null, codecMs: expect.any(Number),
    });
    // The id rides along as a header so the codec's own log lines carry it too: the body is the
    // frozen wire message and nothing may be added to it.
    expect(fetchSpy).toHaveBeenCalledWith("http://codec-v1/encode", {
      method: "POST", body, headers: { "X-Request-Id": RID },
    });
  });

  // The codec builds the same resource name from this, so both services' lines nest under the
  // one request log rather than under a trace of the codec's own.
  it("forwards the trace to the codec when the request has one", async () => {
    process.env["CODEC_URL_V1"] = "http://codec-v1";
    const body = "v1 63.0630,-151.0810 p:a";
    const fetchSpy = vi.fn(async () => new Response("ENCODED", { status: 200 }));
    vi.stubGlobal("fetch", fetchSpy);

    await dispatchForecast(body, RID, TRACE);
    expect(fetchSpy).toHaveBeenCalledWith("http://codec-v1/encode", {
      method: "POST", body,
      headers: { "X-Request-Id": RID, "X-Cloud-Trace-Context": TRACE },
    });
  });

  it("picks up the shape header when the codec sends one", async () => {
    process.env["CODEC_URL_V1"] = "http://codec-v1";
    const header = { lat: 63.06, lon: -151.08, loc: "current", mode: "detail",
                     models: ["best"], vars: ["temp"], maxChars: 160, messages: 1 };
    vi.stubGlobal("fetch", vi.fn(async () =>
      new Response("ENCODED", { status: 200, headers: { "X-Request-Shape": JSON.stringify(header) } })));

    expect(await dispatchForecast("v1 p:d", RID, null)).toEqual({
      kind: "ok", encoded: "ENCODED", codecMs: expect.any(Number),
      shape: { lat: 63.06, lon: -151.08, loc: "current", mode: "detail",
               model: "best", vars: ["temp"], maxChars: 160, messages: 1, device: null,
               periods: null, fetchMs: null, encodeMs: null },
    });
  });

  it("maps a codec 400 to malformed, carrying the codec's reason", async () => {
    process.env["CODEC_URL_V1"] = "http://codec-v1";
    vi.stubGlobal("fetch", vi.fn(async () => new Response("invalid request: missing u:", { status: 400 })));
    expect(await dispatchForecast("v1 p:a", RID, null)).toEqual({
      kind: "malformed", reason: "invalid request: missing u:", codecMs: expect.any(Number),
    });
  });

  it("maps codec 5xx and unreachable codecs to unavailable", async () => {
    process.env["CODEC_URL_V1"] = "http://codec-v1";
    vi.stubGlobal("fetch", vi.fn(async () => new Response("boom", { status: 503 })));
    expect(await dispatchForecast("v1 p:a", RID, null)).toEqual({ kind: "unavailable", codecMs: expect.any(Number) });

    vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("ECONNREFUSED"); }));
    expect(await dispatchForecast("v1 p:a", RID, null)).toEqual({ kind: "unavailable", codecMs: expect.any(Number) });
  });
});

describe("parseShapeHeader", () => {
  const shape = (over: Record<string, unknown> = {}) => JSON.stringify({
    lat: 63.06, lon: -151.08, loc: "current", mode: "detail",
    models: ["best"], vars: ["temp", "wind"], maxChars: 160, messages: 2, ...over,
  });

  it("keeps exactly the fields we store", () => {
    expect(parseShapeHeader(shape({ device: "i", periods: { "3": 5, "12": 2 }, fetchMs: 480, encodeMs: 12 }))).toEqual({
      lat: 63.06, lon: -151.08, loc: "current", mode: "detail",
      model: "best", vars: ["temp", "wind"], maxChars: 160, messages: 2, device: "i",
      periods: { "3": 5, "12": 2 }, fetchMs: 480, encodeMs: 12,
    });
    // Absent from containers frozen before the codec reported them.
    expect(parseShapeHeader(shape())).toMatchObject({
      device: null, periods: null, fetchMs: null, encodeMs: null,
    });
  });

  it("drops fields the codec invented rather than storing them", () => {
    expect(parseShapeHeader(shape({ userToken: "SECRET", note: "hi" }))).not.toHaveProperty("userToken");
  });

  // Every one of these is a codec that is broken, old, or lying. None may cost the user a
  // forecast — the dispatcher has already produced one by the time this runs.
  it("degrades to null rather than throwing", () => {
    expect(parseShapeHeader(null)).toBeNull();
    expect(parseShapeHeader("")).toBeNull();
    expect(parseShapeHeader("not json")).toBeNull();
    expect(parseShapeHeader("[1,2,3]")).toBeNull();
    expect(parseShapeHeader('"a string"')).toBeNull();
    expect(parseShapeHeader(JSON.stringify({ pad: "x".repeat(4096) }))).toBeNull();
  });

  it("nulls individual fields of the wrong type or range", () => {
    expect(parseShapeHeader(shape({ lat: "63.06", lon: 999, mode: 7, maxChars: 1.5, messages: "2" }))).toEqual({
      lat: null, lon: null, loc: "current", mode: null,
      model: "best", vars: ["temp", "wind"], maxChars: null, messages: null, device: null,
      periods: null, fetchMs: null, encodeMs: null,
    });
    expect(parseShapeHeader(shape({ models: "best", vars: [1, "temp", null] }))).toMatchObject({
      model: null, vars: ["temp"],
    });
    // Ints must fit the Postgres integer columns they land in: pre-v4 containers report an
    // uncapped budget as MAX_SAFE_INTEGER, which must read as "no cap", not fail the insert.
    expect(parseShapeHeader(shape({ maxChars: Number.MAX_SAFE_INTEGER }))).toMatchObject({ maxChars: null });
    expect(parseShapeHeader(shape({ maxChars: -1 }))).toMatchObject({ maxChars: null });
    expect(parseShapeHeader(shape({ maxChars: 2 ** 31 }))).toMatchObject({ maxChars: null });
    expect(parseShapeHeader(shape({ maxChars: 2 ** 31 - 1 }))).toMatchObject({ maxChars: 2 ** 31 - 1 });
    // A periods dictionary that isn't a small digits→count map reads as "not reported".
    for (const bad of [
      [3, 5], { "3": "5" }, { "3": 0 }, { "3": 5000 }, { "-3": 5 }, { "3.5": 5 }, { note: 5 }, {},
    ]) {
      expect(parseShapeHeader(shape({ periods: bad }))).toMatchObject({ periods: null });
    }
  });

  // The codec already rounds, but this is the last point before the value is stored, so the
  // promise to keep only an approximate location can't rest on the codec having behaved.
  it("re-rounds coordinates to ~1km, whatever the codec sent", () => {
    expect(parseShapeHeader(shape({ lat: 63.0630419, lon: -151.0810871 })))
      .toMatchObject({ lat: 63.06, lon: -151.08 });
  });
});

describe("codecUrlFor", () => {
  it("reads CODEC_URL_V<N>, treating unset and empty as unsupported", () => {
    process.env["CODEC_URL_V7"] = "http://codec-v7";
    expect(codecUrlFor(7)).toBe("http://codec-v7");
    delete process.env["CODEC_URL_V7"];
    expect(codecUrlFor(7)).toBeNull();
    process.env["CODEC_URL_V7"] = "";
    expect(codecUrlFor(7)).toBeNull();
    delete process.env["CODEC_URL_V7"];
  });
});
