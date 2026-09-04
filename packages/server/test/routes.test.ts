import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { randomBytes } from "node:crypto";
import { Hono } from "hono";
import { generateToken } from "@weather/protocol";
import { forecast, sms } from "../src/routes.js";
import { accountExists, recordRequest } from "../src/accounts.js";

// The account gate: a request whose token names no account is rejected before dispatch. The
// accounts module is mocked so no Postgres is needed; the codec call is a stubbed fetch, so a
// request that reaches dispatch is visible as a fetch call.
vi.mock("../src/accounts.js", () => ({
  accountExists: vi.fn(async () => true),
  recordRequest: vi.fn(async () => {}),
  createAccount: vi.fn(),
  deleteAccount: vi.fn(),
}));

const TOKEN = generateToken((n) => Uint8Array.from(randomBytes(n)));
const BODY = `v1 p:a u:${TOKEN}`;

const app = new Hono();
app.post("/forecast", forecast);
app.post("/sms", sms);

const post = (body: string) => app.request("/forecast", { method: "POST", body });
const postSms = (body: string) =>
  app.request("/sms", { method: "POST", body: new URLSearchParams({ Body: body, From: "+15550100" }) });

beforeEach(() => {
  process.env["CODEC_URL_V1"] = "http://codec-v1";
  vi.stubGlobal("fetch", vi.fn(async () => new Response("ENCODED", { status: 200 })));
  vi.mocked(accountExists).mockClear();
  vi.mocked(accountExists).mockResolvedValue(true);
  vi.mocked(recordRequest).mockClear();
});

afterEach(() => {
  vi.unstubAllGlobals();
  delete process.env["CODEC_URL_V1"];
});

describe("account gate", () => {
  it("serves a request whose token names an account", async () => {
    const resp = await post(BODY);
    expect(resp.status).toBe(200);
    expect(await resp.text()).toBe("ENCODED");
    expect(vi.mocked(accountExists)).toHaveBeenCalledWith(TOKEN);
  });

  it("rejects an unknown token before dispatch, with the malformed reply", async () => {
    vi.mocked(accountExists).mockResolvedValue(false);
    const resp = await post(BODY);
    expect(resp.status).toBe(400);
    expect(await resp.text()).toContain("Download the app at going.blue");
    // Rejected before dispatch: the codec was never called, and the attempt is recorded.
    expect(fetch).not.toHaveBeenCalled();
    expect(vi.mocked(recordRequest)).toHaveBeenCalledWith(
      expect.objectContaining({ token: TOKEN, outcome: "unknown_token", version: 1, shape: null }),
    );
  });

  it("rejects an unknown token over SMS with the same reply, as TwiML", async () => {
    vi.mocked(accountExists).mockResolvedValue(false);
    const resp = await postSms(BODY);
    expect(resp.status).toBe(200);
    const xml = await resp.text();
    expect(xml).toContain("Download the app at going.blue");
    expect(fetch).not.toHaveBeenCalled();
  });

  it("leaves a tokenless request to the codec, whose reply names what is missing", async () => {
    const resp = await post("v1 p:a");
    expect(resp.status).toBe(200); // the stubbed codec accepts it; the point is dispatch happened
    expect(vi.mocked(accountExists)).not.toHaveBeenCalled();
    expect(fetch).toHaveBeenCalled();
  });

  it("fails open when the account lookup itself fails", async () => {
    vi.mocked(accountExists).mockRejectedValue(new Error("db down"));
    const resp = await post(BODY);
    expect(resp.status).toBe(200);
    expect(await resp.text()).toBe("ENCODED");
  });
});

// One inbound message gets one id: the gateway mints it, sends it to the codec, and stores it on
// the row, so a row leads to the logs of both services and back again.
describe("request id", () => {
  const sentIds = () =>
    vi.mocked(fetch).mock.calls.map(
      (call) => ((call[1] as RequestInit).headers as Record<string, string>)["X-Request-Id"],
    );
  const recordedIds = () =>
    vi.mocked(recordRequest).mock.calls.map((call) => call[0].requestId);

  it("sends the recorded id to the codec", async () => {
    await post(BODY);
    expect(sentIds()).toEqual(recordedIds());
    expect(recordedIds()[0]).toEqual(expect.any(String));
  });

  it("records one for a request that never reaches a codec", async () => {
    vi.mocked(accountExists).mockResolvedValue(false);
    await post(BODY);
    expect(fetch).not.toHaveBeenCalled();
    expect(recordedIds()[0]).toEqual(expect.any(String));
  });

  it("mints a fresh one per message, on both routes", async () => {
    await post(BODY);
    await postSms(BODY);
    expect(new Set(recordedIds()).size).toBe(2);
    expect(sentIds()).toEqual(recordedIds());
  });
});

// The trace Cloud Run puts on the inbound request, forwarded so the codec's lines land under the
// same request log. Only the id travels: the span and sampling flag are the caller's, and the
// header reaches a public endpoint.
describe("trace propagation", () => {
  const TRACE = "0123456789abcdef0123456789abcdef";
  const sentTraces = () =>
    vi.mocked(fetch).mock.calls.map(
      (call) => ((call[1] as RequestInit).headers as Record<string, string>)["X-Cloud-Trace-Context"],
    );
  const headers = { "X-Cloud-Trace-Context": `${TRACE}/1234567890;o=1` };

  it("forwards the id from POST /forecast", async () => {
    await app.request("/forecast", { method: "POST", body: BODY, headers });
    expect(sentTraces()).toEqual([TRACE]);
  });

  it("forwards the id from POST /sms", async () => {
    await app.request("/sms", {
      method: "POST",
      body: new URLSearchParams({ Body: BODY, From: "+15550100" }),
      headers,
    });
    expect(sentTraces()).toEqual([TRACE]);
  });

  it("sends no trace header when the request arrived without one", async () => {
    await post(BODY);
    expect(sentTraces()).toEqual([undefined]);
  });

  it("sends none when the header is malformed", async () => {
    await app.request("/forecast", {
      method: "POST", body: BODY, headers: { "X-Cloud-Trace-Context": "not-a-trace" },
    });
    expect(sentTraces()).toEqual([undefined]);
  });
});

