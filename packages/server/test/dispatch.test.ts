import { afterEach, describe, expect, it, vi } from "vitest";
import { generateToken } from "@weather/protocol";
import { codecUrlFor, dispatchForecast, extractDevice, extractUserToken, extractVersion, parseShapeHeader } from "../src/dispatch.js";

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

describe("extractDevice", () => {
  it("finds the d: word anywhere in the body, case-insensitively", () => {
    expect(extractDevice("v2 d:i n:2 p:a")).toBe("i");
    expect(extractDevice("63.0630,-151.0810 D:G v2")).toBe("g");
  });

  it("is null when absent or not a device code — hand-typed and pre-d: requests name none", () => {
    expect(extractDevice("v2 p:a")).toBeNull();
    expect(extractDevice("v2 d:x")).toBeNull();
    expect(extractDevice("v2 d:")).toBeNull();
  });
});

describe("dispatchForecast", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    delete process.env["CODEC_URL_V1"];
  });

  it("reports a missing version without calling any codec", async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    expect(await dispatchForecast("63.0630,-151.0810 p:a")).toEqual({ kind: "missing_version" });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("reports an unmapped version as unsupported (never existed or sunset)", async () => {
    expect(await dispatchForecast("v9 p:a")).toEqual({ kind: "unsupported_version", version: 9 });
  });

  it("forwards the raw body to the mapped codec and relays its reply", async () => {
    process.env["CODEC_URL_V1"] = "http://codec-v1";
    const body = "v1 63.0630,-151.0810 p:a c:160";
    const fetchSpy = vi.fn(async () => new Response("ENCODED", { status: 200 }));
    vi.stubGlobal("fetch", fetchSpy);

    expect(await dispatchForecast(body)).toEqual({ kind: "ok", encoded: "ENCODED", shape: null });
    expect(fetchSpy).toHaveBeenCalledWith("http://codec-v1/encode", { method: "POST", body });
  });

  it("picks up the shape header when the codec sends one", async () => {
    process.env["CODEC_URL_V1"] = "http://codec-v1";
    const shape = { lat: 63.06, lon: -151.08, loc: "current", mode: "detail",
                    models: ["best"], vars: ["temp"], maxChars: 160, messages: 1 };
    vi.stubGlobal("fetch", vi.fn(async () =>
      new Response("ENCODED", { status: 200, headers: { "X-Request-Shape": JSON.stringify(shape) } })));

    expect(await dispatchForecast("v1 p:d")).toEqual({ kind: "ok", encoded: "ENCODED", shape });
  });

  it("maps codec errors and unreachable codecs to unavailable", async () => {
    process.env["CODEC_URL_V1"] = "http://codec-v1";
    vi.stubGlobal("fetch", vi.fn(async () => new Response("boom", { status: 503 })));
    expect(await dispatchForecast("v1 p:a")).toEqual({ kind: "unavailable" });

    vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("ECONNREFUSED"); }));
    expect(await dispatchForecast("v1 p:a")).toEqual({ kind: "unavailable" });
  });
});

describe("parseShapeHeader", () => {
  const shape = (over: Record<string, unknown> = {}) => JSON.stringify({
    lat: 63.06, lon: -151.08, loc: "current", mode: "detail",
    models: ["best"], vars: ["temp", "wind"], maxChars: 160, messages: 2, ...over,
  });

  it("keeps exactly the fields we store", () => {
    expect(parseShapeHeader(shape())).toEqual({
      lat: 63.06, lon: -151.08, loc: "current", mode: "detail",
      models: ["best"], vars: ["temp", "wind"], maxChars: 160, messages: 2,
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
      models: ["best"], vars: ["temp", "wind"], maxChars: null, messages: null,
    });
    expect(parseShapeHeader(shape({ models: "best", vars: [1, "temp", null] }))).toMatchObject({
      models: [], vars: ["temp"],
    });
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
