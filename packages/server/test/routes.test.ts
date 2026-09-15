import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { randomBytes } from "node:crypto";
import { Hono } from "hono";
import { appUserAgent, generateToken } from "@weather/protocol";
import { createAccountRoute, forecast, sms } from "../src/routes.js";
import { accountExists, createAccount, recordRequest } from "../src/accounts.js";
import { receiveMessage } from "../src/delivery.js";
import { runEncodeTask } from "../src/encode-task.js";
import { log } from "../src/log.js";

// The account gate: a request whose token names no account is rejected before dispatch. The
// accounts module is mocked so no Postgres is needed; the codec call is a stubbed fetch, so a
// request that reaches dispatch is visible as a fetch call.
vi.mock("../src/accounts.js", () => ({
  accountExists: vi.fn(async () => true),
  recordRequest: vi.fn(async () => {}),
  createAccount: vi.fn(),
  deleteAccount: vi.fn(),
}));

// The SMS route records the message and hands it to the encode task; both are mocked here, and
// the task itself is covered in encode-task.test.ts.
vi.mock("../src/delivery.js", () => ({
  receiveMessage: vi.fn(async (r: { requestId: string }) => ({ id: "1", requestId: r.requestId })),
}));
vi.mock("../src/encode-task.js", () => ({
  runEncodeTask: vi.fn(async () => "done"),
}));

const TOKEN = generateToken((n) => Uint8Array.from(randomBytes(n)));
const BODY = `v1 p:a u:${TOKEN}`;
const SID = "SM" + "0".repeat(31) + "1";

const app = new Hono();
app.post("/forecast", forecast);
app.post("/sms", sms);

const post = (body: string) => app.request("/forecast", { method: "POST", body });
const postSms = (body: string, params: Record<string, string> = { MessageSid: SID }) =>
  app.request("/sms", { method: "POST", body: new URLSearchParams({ Body: body, From: "+15550100", ...params }) });

beforeEach(() => {
  process.env["CODEC_URL_V1"] = "http://codec-v1";
  vi.stubGlobal("fetch", vi.fn(async () => new Response("ENCODED", { status: 200 })));
  vi.mocked(accountExists).mockClear();
  vi.mocked(accountExists).mockResolvedValue(true);
  vi.mocked(recordRequest).mockClear();
  vi.mocked(receiveMessage).mockClear();
  vi.mocked(runEncodeTask).mockClear();
  vi.mocked(runEncodeTask).mockResolvedValue("done");
});

afterEach(() => {
  vi.unstubAllGlobals();
  delete process.env["CODEC_URL_V1"];
});

describe("off-axis start time", () => {
  it("names the side over HTTP and records the outcome", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("stale", { status: 422 })));
    let resp = await post(BODY);
    expect(resp.status).toBe(422);
    expect(await resp.text()).toBe("Request is stale. Build a new request and try again.");
    expect(vi.mocked(recordRequest)).toHaveBeenLastCalledWith(
      expect.objectContaining({ token: TOKEN, outcome: "stale", shape: null }),
    );

    vi.stubGlobal("fetch", vi.fn(async () => new Response("future", { status: 422 })));
    resp = await post(BODY);
    expect(resp.status).toBe(422);
    expect(await resp.text()).toBe("Request is from the future. Build a new request and try again.");
    expect(vi.mocked(recordRequest)).toHaveBeenLastCalledWith(
      expect.objectContaining({ token: TOKEN, outcome: "future", shape: null }),
    );
  });

});

// The webhook records the message by SID and runs the encode task inline, with no retry window.
// The reply goes out through the REST API, so the webhook response is always an empty TwiML.
describe("sms webhook", () => {
  it("records the message and runs the task, answering with an empty response", async () => {
    const resp = await postSms(BODY);
    expect(resp.status).toBe(200);
    expect(await resp.text()).toBe('<?xml version="1.0" encoding="UTF-8"?>\n<Response></Response>');
    expect(vi.mocked(receiveMessage)).toHaveBeenCalledWith(
      expect.objectContaining({ messageSid: SID, twilioReceivedAt: null }));
    expect(vi.mocked(runEncodeTask)).toHaveBeenCalledWith(SID, { retryWindowMs: 0, traceId: null });
    // Nothing is dispatched or recorded by the route itself.
    expect(fetch).not.toHaveBeenCalled();
    expect(vi.mocked(recordRequest)).not.toHaveBeenCalled();
  });

  it("asks Twilio to retry when the task could not finish", async () => {
    vi.mocked(runEncodeTask).mockResolvedValue("retry");
    const resp = await postSms(BODY);
    expect(resp.status).toBe(503);
  });

  it("fails the request when the message cannot be recorded", async () => {
    vi.mocked(receiveMessage).mockRejectedValueOnce(new Error("db down"));
    const resp = await postSms(BODY);
    expect(resp.status).toBe(503);
    expect(vi.mocked(runEncodeTask)).not.toHaveBeenCalled();
  });

  it("rejects a webhook without a message SID", async () => {
    const resp = await postSms(BODY, {});
    expect(resp.status).toBe(400);
    expect(vi.mocked(receiveMessage)).not.toHaveBeenCalled();
  });

  it("forwards the trace to the task", async () => {
    const TRACE = "0123456789abcdef0123456789abcdef";
    await app.request("/sms", {
      method: "POST",
      body: new URLSearchParams({ Body: BODY, From: "+15550100", MessageSid: SID }),
      headers: { "X-Cloud-Trace-Context": `${TRACE}/1234567890;o=1` },
    });
    expect(vi.mocked(runEncodeTask)).toHaveBeenCalledWith(SID, { retryWindowMs: 0, traceId: TRACE });
  });
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

  it("mints a fresh one per message", async () => {
    await post(BODY);
    await post(BODY);
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


// How POST /account reads its caller. It is observe-only: nothing is rejected yet, so the
// assertion that matters is that an account is still minted whatever the user agent says, and
// that the log line carries the state a rejection rule will later be written against.
describe("account creation client", () => {
  const accounts = new Hono();
  accounts.post("/account", createAccountRoute);
  const mint = (ua?: string) =>
    accounts.request("/account", { method: "POST", headers: ua ? { "User-Agent": ua } : undefined });

  beforeEach(() => {
    vi.mocked(createAccount).mockClear();
    vi.mocked(createAccount).mockResolvedValue(TOKEN);
  });

  it.each([
    ["app", appUserAgent("1.2.0")],
    // What the scanners that minted 20 rows actually sent.
    ["other", "Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/120.0.0.0"],
    // Android's default, which identifies nothing and is why the app names itself explicitly.
    ["other", "okhttp/4.12.0"],
    ["other", undefined],
  ] as const)("mints an account and logs client=%s", async (state, ua) => {
    const info = vi.spyOn(log, "info").mockImplementation(() => {});
    const resp = await mint(ua);
    expect(resp.status).toBe(200);
    expect(await resp.json()).toEqual({ token: TOKEN });
    expect(info).toHaveBeenCalledWith("account.create", { client: state });
    info.mockRestore();
  });

  // The version moves with every release, so only the leading name may be matched on.
  it("accepts the app under any version", async () => {
    const info = vi.spyOn(log, "info").mockImplementation(() => {});
    await mint(appUserAgent("99.0.0"));
    expect(info).toHaveBeenCalledWith("account.create", { client: "app" });
    info.mockRestore();
  });
});
