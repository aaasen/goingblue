import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createSign, generateKeyPairSync, type KeyObject } from "node:crypto";
import { Hono } from "hono";
import { requireInvoker, verifyInvoker } from "../src/invoker.js";
import { log } from "../src/log.js";

// The identity check against tokens signed here with a key served by a stubbed certs endpoint.

const AUDIENCE = "https://going.blue/encode";
const EMAIL = "123-compute@developer.gserviceaccount.com";

function keyPair() {
  const { publicKey, privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  return { publicKey, privateKey };
}
const k1 = keyPair();
const k2 = keyPair();

function jwk(kid: string, key: KeyObject) {
  return { ...key.export({ format: "jwk" }), kid, use: "sig", alg: "RS256" };
}

const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");

function token(over: Record<string, unknown> = {}, opts: { kid?: string; key?: KeyObject; alg?: string } = {}): string {
  const now = Math.floor(Date.now() / 1000);
  const header = b64({ alg: opts.alg ?? "RS256", kid: opts.kid ?? "k1", typ: "JWT" });
  const claims = b64({
    iss: "https://accounts.google.com", aud: AUDIENCE, azp: "x", email: EMAIL, email_verified: true,
    iat: now, exp: now + 3600, ...over,
  });
  const sig = createSign("RSA-SHA256").update(`${header}.${claims}`).sign(opts.key ?? k1.privateKey);
  return `${header}.${claims}.${sig.toString("base64url")}`;
}

let certs: () => Response;
let certFetches: number;
const serving = (...keys: ReturnType<typeof jwk>[]) => () =>
  new Response(JSON.stringify({ keys }), { status: 200, headers: { "Cache-Control": "public, max-age=3600" } });

beforeEach(() => {
  certFetches = 0;
  certs = serving(jwk("k1", k1.publicKey));
  vi.stubGlobal("fetch", vi.fn(async (url: string) => {
    if (url === "https://www.googleapis.com/oauth2/v3/certs") { certFetches++; return certs(); }
    throw new Error(`unexpected fetch ${url}`);
  }));
  vi.spyOn(log, "error").mockImplementation(() => {});
  vi.spyOn(log, "warn").mockImplementation(() => {});
  // Fresh module state (the key cache) per test.
  vi.resetModules();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

// Move the clock past the floor on refetching for an unknown key id.
function later() {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(Date.now() + 6 * 60_000);
}

async function fresh() {
  const m = await import("../src/invoker.js");
  return m;
}

describe("verifyInvoker", () => {
  it("accepts a token signed by a published key for this audience and account", async () => {
    const { verifyInvoker } = await fresh();
    expect(await verifyInvoker(token(), AUDIENCE, EMAIL)).toEqual({ kind: "ok", email: EMAIL });
  });

  it("caches the keys across tokens", async () => {
    const { verifyInvoker } = await fresh();
    await verifyInvoker(token(), AUDIENCE, EMAIL);
    await verifyInvoker(token(), AUDIENCE, EMAIL);
    expect(certFetches).toBe(1);
  });

  it("rejects a bad signature, and a token signed with a key Google does not publish", async () => {
    const { verifyInvoker } = await fresh();
    const [h, p] = token().split(".");
    expect(await verifyInvoker(`${h}.${p}.${Buffer.from("nope").toString("base64url")}`, AUDIENCE, EMAIL)).toMatchObject({ kind: "rejected", reason: "signature" });
    expect(await verifyInvoker(token({}, { kid: "k1", key: k2.privateKey }), AUDIENCE, EMAIL)).toMatchObject({ kind: "rejected", reason: "signature" });
  });

  it("refetches for an unknown key id once the floor has passed, and rejects if it is still unknown", async () => {
    const { verifyInvoker } = await fresh();
    await verifyInvoker(token(), AUDIENCE, EMAIL);
    // Within the floor an unknown key id is rejected without a fetch.
    expect(await verifyInvoker(token({}, { kid: "k3" }), AUDIENCE, EMAIL)).toMatchObject({ kind: "rejected", reason: "unknown_key" });
    expect(certFetches).toBe(1);
    later();
    expect(await verifyInvoker(token({}, { kid: "k3" }), AUDIENCE, EMAIL)).toMatchObject({ kind: "rejected", reason: "unknown_key" });
    expect(certFetches).toBe(2);
  });

  it("picks up a rotated key", async () => {
    const { verifyInvoker } = await fresh();
    await verifyInvoker(token(), AUDIENCE, EMAIL);
    certs = serving(jwk("k1", k1.publicKey), jwk("k2", k2.publicKey));
    later();
    expect(await verifyInvoker(token({}, { kid: "k2", key: k2.privateKey }), AUDIENCE, EMAIL)).toEqual({ kind: "ok", email: EMAIL });
    expect(certFetches).toBe(2);
  });

  it("rejects the wrong audience, account, issuer, or an unverified email", async () => {
    const { verifyInvoker } = await fresh();
    expect(await verifyInvoker(token({ aud: "https://going.blue/health-check" }), AUDIENCE, EMAIL)).toMatchObject({ reason: "audience" });
    expect(await verifyInvoker(token({ email: "other@example.com" }), AUDIENCE, EMAIL)).toMatchObject({ reason: "email" });
    expect(await verifyInvoker(token({ email_verified: false }), AUDIENCE, EMAIL)).toMatchObject({ reason: "email" });
    expect(await verifyInvoker(token({ iss: "https://example.com" }), AUDIENCE, EMAIL)).toMatchObject({ reason: "issuer" });
  });

  it("accepts the bare issuer form Google also uses", async () => {
    const { verifyInvoker } = await fresh();
    expect((await verifyInvoker(token({ iss: "accounts.google.com" }), AUDIENCE, EMAIL)).kind).toBe("ok");
  });

  it("rejects an expired token, allowing a minute of skew", async () => {
    const { verifyInvoker } = await fresh();
    const now = Math.floor(Date.now() / 1000);
    expect(await verifyInvoker(token({ exp: now - 120 }), AUDIENCE, EMAIL)).toMatchObject({ reason: "expired" });
    expect((await verifyInvoker(token({ exp: now - 30 }), AUDIENCE, EMAIL)).kind).toBe("ok");
    expect(await verifyInvoker(token({ iat: now + 120 }), AUDIENCE, EMAIL)).toMatchObject({ reason: "future" });
  });

  it("rejects anything but RS256 with a key id, and garbage", async () => {
    const { verifyInvoker } = await fresh();
    expect(await verifyInvoker(token({}, { alg: "none" }), AUDIENCE, EMAIL)).toMatchObject({ reason: "alg" });
    expect(await verifyInvoker("not.a.jwt", AUDIENCE, EMAIL)).toMatchObject({ reason: "malformed" });
    expect(await verifyInvoker("", AUDIENCE, EMAIL)).toMatchObject({ reason: "malformed" });
    expect(certFetches).toBe(0);
  });

  it("is unavailable, not a rejection, when the keys cannot be fetched", async () => {
    const { verifyInvoker } = await fresh();
    certs = () => new Response("", { status: 503 });
    expect(await verifyInvoker(token(), AUDIENCE, EMAIL)).toEqual({ kind: "unavailable" });
  });
});

describe("requireInvoker", () => {
  const app = new Hono();
  app.use("/encode", requireInvoker("ENCODE_URL"));
  app.post("/encode", (c) => c.text("ran", 200));
  const post = (headers: Record<string, string> = {}) => app.request("/encode", { method: "POST", headers });

  beforeEach(() => {
    process.env["INVOKER_EMAIL"] = EMAIL;
    process.env["ENCODE_URL"] = AUDIENCE;
  });
  afterEach(() => {
    delete process.env["INVOKER_EMAIL"];
    delete process.env["ENCODE_URL"];
  });

  it("lets a valid token through", async () => {
    const res = await post({ Authorization: `Bearer ${token()}` });
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("ran");
  });

  it("is a 401 with no token, logged as a warning", async () => {
    expect((await post()).status).toBe(401);
    expect(log.warn).toHaveBeenCalledWith("invoker.missing", { path: "/encode" });
    expect(log.error).not.toHaveBeenCalled();
  });

  it("is a 403 for a token that does not match, logged as an error with the reason", async () => {
    expect((await post({ Authorization: `Bearer ${token({ aud: "https://elsewhere" })}` })).status).toBe(403);
    expect(log.error).toHaveBeenCalledWith("invoker.rejected", { path: "/encode", reason: "audience" });
  });

  it("is a 503 when Google's keys cannot be fetched, so the task is retried", async () => {
    certs = () => { throw new Error("ECONNRESET"); };
    later();
    expect((await post({ Authorization: `Bearer ${token({}, { kid: "never-cached" })}` })).status).toBe(503);
  });

  it("is a 500 when the route's audience is not configured", async () => {
    delete process.env["ENCODE_URL"];
    expect((await post({ Authorization: `Bearer ${token()}` })).status).toBe(500);
  });

  it("checks nothing when no invoker account is set", async () => {
    delete process.env["INVOKER_EMAIL"];
    expect((await post()).status).toBe(200);
  });
});
