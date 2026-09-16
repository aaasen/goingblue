import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { generateToken } from "@weather/protocol";
import { codecUrlFor, dispatchForecast, extractUserToken, extractVersion, parseShapeHeader } from "../src/dispatch.js";
import { log } from "../src/log.js";
import { resetIdentityTokens } from "../src/identity.js";

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
      method: "POST", body, headers: { "X-Request-Id": RID }, signal: expect.any(AbortSignal),
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
      signal: expect.any(AbortSignal),
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
               model: "best", vars: ["temp"], maxChars: 160, messages: 1, device: null, platform: null,
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

  it("maps a codec 422 to the side of the axis its body names", async () => {
    process.env["CODEC_URL_V1"] = "http://codec-v1";
    vi.stubGlobal("fetch", vi.fn(async () => new Response("stale", { status: 422 })));
    expect(await dispatchForecast("v1 p:a", RID, null)).toEqual({ kind: "stale", codecMs: expect.any(Number) });

    vi.stubGlobal("fetch", vi.fn(async () => new Response("future", { status: 422 })));
    expect(await dispatchForecast("v1 p:a", RID, null)).toEqual({ kind: "future", codecMs: expect.any(Number) });

    // A 422 whose body names neither side is not one of ours: retryable, like any other status.
    vi.stubGlobal("fetch", vi.fn(async () => new Response("something else", { status: 422 })));
    expect(await dispatchForecast("v1 p:a", RID, null)).toEqual({ kind: "unavailable", codecMs: expect.any(Number) });
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
    expect(parseShapeHeader(shape({ device: "i", platform: "a", periods: { "3": 5, "12": 2 }, fetchMs: 480, encodeMs: 12 }))).toEqual({
      lat: 63.06, lon: -151.08, loc: "current", mode: "detail",
      model: "best", vars: ["temp", "wind"], maxChars: 160, messages: 2, device: "i", platform: "a",
      periods: { "3": 5, "12": 2 }, fetchMs: 480, encodeMs: 12,
    });
    // Absent from containers frozen before the codec reported them.
    expect(parseShapeHeader(shape())).toMatchObject({
      device: null, platform: null, periods: null, fetchMs: null, encodeMs: null,
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
      model: "best", vars: ["temp", "wind"], maxChars: null, messages: null, device: null, platform: null,
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

// The alert policy fires on ERROR, so a sender's own mistake must log below it while a service
// failure stays at ERROR.
describe("codec response severity", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    delete process.env["CODEC_URL_V1"];
  });

  it.each([
    [400, "invalid request", "warn"],
    [422, "stale", "warn"],
    [422, "future", "warn"],
    [422, "something else", "error"],
    [503, "boom", "error"],
  ] as const)("logs a %s '%s' at %s when this is the last attempt", async (status, body, level) => {
    process.env["CODEC_URL_V1"] = "http://codec-v1";
    vi.stubGlobal("fetch", vi.fn(async () => new Response(body, { status })));
    const warn = vi.spyOn(log, "warn").mockImplementation(() => {});
    const error = vi.spyOn(log, "error").mockImplementation(() => {});
    await dispatchForecast("v1 p:a", RID, null, false);
    expect((level === "warn" ? warn : error)).toHaveBeenCalledWith("codec.error_response", expect.objectContaining({ status }));
    expect((level === "warn" ? error : warn)).not.toHaveBeenCalled();
  });

  // A transient failure that the caller will retry is a warning; the same failure on the last
  // attempt is an error. The sender's own errors are warnings either way.
  it("logs an unavailable codec at warning when a retry will follow", async () => {
    process.env["CODEC_URL_V1"] = "http://codec-v1";
    const warn = vi.spyOn(log, "warn").mockImplementation(() => {});
    const error = vi.spyOn(log, "error").mockImplementation(() => {});

    vi.stubGlobal("fetch", vi.fn(async () => new Response("boom", { status: 503 })));
    await dispatchForecast("v1 p:a", RID, null, true);
    expect(warn).toHaveBeenLastCalledWith("codec.error_response", expect.objectContaining({ status: 503 }));

    vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("ECONNREFUSED"); }));
    await dispatchForecast("v1 p:a", RID, null, true);
    expect(warn).toHaveBeenLastCalledWith("codec.unreachable", expect.anything());
    expect(error).not.toHaveBeenCalled();

    await dispatchForecast("v1 p:a", RID, null, false);
    expect(error).toHaveBeenLastCalledWith("codec.unreachable", expect.anything());
  });
});

// With CODEC_AUTH=iam every codec call carries an identity token from the metadata server,
// minted for the codec's URL as audience and reused until it nears expiry.
describe("dispatchForecast codec auth", () => {
  const METADATA = "http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/identity";
  const jwt = (exp: number) =>
    `${Buffer.from("{}").toString("base64url")}.${Buffer.from(JSON.stringify({ exp })).toString("base64url")}.sig`;
  const body = "v4 63.0630,-151.0810 p:a c:160";

  beforeEach(() => {
    process.env["CODEC_URL_V4"] = "https://codec-v4.example";
    process.env["CODEC_AUTH"] = "iam";
    resetIdentityTokens();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    delete process.env["CODEC_URL_V4"];
    delete process.env["CODEC_AUTH"];
  });

  // A fetch stub that answers the metadata server and the codec, recording each call.
  const stub = (token: string | (() => Response)) => {
    const calls: { url: string; headers: Record<string, string> }[] = [];
    vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
      calls.push({ url, headers: (init?.headers ?? {}) as Record<string, string> });
      if (url.startsWith(METADATA)) return typeof token === "string" ? new Response(token) : token();
      return new Response("ENCODED", { status: 200 });
    }));
    return calls;
  };

  it("mints a token for the codec URL and sends it as a bearer", async () => {
    const calls = stub(jwt(Math.floor(Date.now() / 1000) + 3600));
    const result = await dispatchForecast(body, RID, null);
    expect(result.kind).toBe("ok");
    expect(calls[0].url).toBe(`${METADATA}?audience=${encodeURIComponent("https://codec-v4.example")}`);
    expect(calls[0].headers).toEqual({ "Metadata-Flavor": "Google" });
    expect(calls[1].url).toBe("https://codec-v4.example/encode");
    expect(calls[1].headers["Authorization"]).toBe(`Bearer ${jwt(Math.floor(Date.now() / 1000) + 3600)}`);
  });

  it("reuses the token until it nears expiry", async () => {
    const calls = stub(jwt(Math.floor(Date.now() / 1000) + 3600));
    await dispatchForecast(body, RID, null);
    await dispatchForecast(body, RID, null);
    expect(calls.filter((c) => c.url.startsWith(METADATA))).toHaveLength(1);
  });

  it("mints again once the token is about to expire", async () => {
    const calls = stub(jwt(Math.floor(Date.now() / 1000) + 30));
    await dispatchForecast(body, RID, null);
    await dispatchForecast(body, RID, null);
    expect(calls.filter((c) => c.url.startsWith(METADATA))).toHaveLength(2);
  });

  it("reports unavailable without calling the codec when no token can be minted", async () => {
    const error = vi.spyOn(log, "error").mockImplementation(() => {});
    const calls = stub(() => new Response("nope", { status: 500 }));
    expect(await dispatchForecast(body, RID, null)).toEqual({ kind: "unavailable", codecMs: expect.any(Number) });
    expect(calls.map((c) => c.url)).toHaveLength(1);
    expect(error).toHaveBeenCalledWith("codec.identity_unavailable", expect.objectContaining({ version: 4 }));
    error.mockRestore();
  });

  it("calls the codec bare when auth is not configured", async () => {
    delete process.env["CODEC_AUTH"];
    const calls = stub("unused");
    await dispatchForecast(body, RID, null);
    expect(calls.map((c) => c.url)).toEqual(["https://codec-v4.example/encode"]);
    expect(calls[0].headers["Authorization"]).toBeUndefined();
  });
});
