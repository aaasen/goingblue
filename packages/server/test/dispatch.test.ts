import { afterEach, describe, expect, it, vi } from "vitest";
import { generateToken } from "@weather/protocol";
import { codecUrlFor, dispatchForecast, extractUserToken, extractVersion } from "../src/dispatch.js";

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

    expect(await dispatchForecast(body)).toEqual({ kind: "ok", encoded: "ENCODED" });
    expect(fetchSpy).toHaveBeenCalledWith("http://codec-v1/encode", { method: "POST", body });
  });

  it("maps codec errors and unreachable codecs to unavailable", async () => {
    process.env["CODEC_URL_V1"] = "http://codec-v1";
    vi.stubGlobal("fetch", vi.fn(async () => new Response("boom", { status: 503 })));
    expect(await dispatchForecast("v1 p:a")).toEqual({ kind: "unavailable" });

    vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("ECONNREFUSED"); }));
    expect(await dispatchForecast("v1 p:a")).toEqual({ kind: "unavailable" });
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
