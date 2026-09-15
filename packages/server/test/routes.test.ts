import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createHash, createHmac, randomBytes } from "node:crypto";
import { Hono } from "hono";
import { appUserAgent, generateToken } from "@weather/protocol";
import { createAccountRoute, forecast, sms, twilioSink } from "../src/routes.js";
import { fetchMessage } from "../src/twilio.js";
import { FORECAST_NUMBER } from "../src/constants.js";
import { accountExists, createAccount, recordRequest } from "../src/accounts.js";
import { markQueued, receiveMessage, recordReplyDelivery } from "../src/delivery.js";
import { runEncodeTask } from "../src/encode-task.js";
import { enqueueEncode, tasksConfigured } from "../src/tasks.js";
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
  receiveMessage: vi.fn(async (r: { requestId: string }) => ({ id: "1", requestId: r.requestId, queuedAt: null })),
  markQueued: vi.fn(async () => {}),
  recordReplyDelivery: vi.fn(async () => true),
}));
vi.mock("../src/encode-task.js", () => ({
  runEncodeTask: vi.fn(async () => "done"),
}));
vi.mock("../src/tasks.js", () => ({
  tasksConfigured: vi.fn(() => false),
  enqueueEncode: vi.fn(async () => "queued"),
}));
// The sink reads the message back from Twilio before writing anything; only that call is mocked.
vi.mock("../src/twilio.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/twilio.js")>()),
  fetchMessage: vi.fn(),
}));

const TOKEN = generateToken((n) => Uint8Array.from(randomBytes(n)));
const BODY = `v1 p:a u:${TOKEN}`;
const SID = "SM" + "0".repeat(31) + "1";

const app = new Hono();
app.post("/forecast", forecast);
app.post("/sms", sms);
app.post("/twilio-sink", twilioSink);

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
  vi.mocked(receiveMessage).mockImplementation(async (r) => ({ id: "1", requestId: r.requestId, queuedAt: null }));
  vi.mocked(markQueued).mockClear();
  vi.mocked(runEncodeTask).mockClear();
  vi.mocked(runEncodeTask).mockResolvedValue("done");
  vi.mocked(tasksConfigured).mockReturnValue(false);
  vi.mocked(enqueueEncode).mockClear();
  vi.mocked(enqueueEncode).mockResolvedValue("queued");
  vi.mocked(fetchMessage).mockReset();
  vi.mocked(fetchMessage).mockResolvedValue({ kind: "ok", message: INBOUND });
  vi.mocked(recordReplyDelivery).mockReset();
  vi.mocked(recordReplyDelivery).mockResolvedValue(true);
});

const REPLY_SID = "SM" + "c".repeat(32);
const deliveryEvent = (status: string, data: Record<string, unknown> = {}) => ({
  specversion: "1.0", type: `com.twilio.messaging.message.${status}`, id: "evt-2",
  data: { messageSid: REPLY_SID, messageStatus: status, timestamp: "2026-09-15T21:54:26.000Z", ...data },
});

const RECEIVED = new Date("2026-09-15T21:54:20Z");
const INBOUND = { sid: SID, direction: "inbound", from: "+15550100", to: FORECAST_NUMBER, body: BODY, dateCreated: RECEIVED };
const inboundEvent = (sid: unknown = SID) => ({
  specversion: "1.0", type: "com.twilio.messaging.inbound-message.received", id: "evt-1",
  time: "2026-09-15T21:54:20.100Z", data: { messageSid: sid, from: "+15550100", to: FORECAST_NUMBER, body: BODY },
});
const testEvent = { specversion: "1.0", type: "com.twilio.eventstreams.test-event", id: "evt-0", data: {} };
const postSink = (body: unknown) => app.request("/twilio-sink", {
  method: "POST", body: JSON.stringify(body), headers: { "Content-Type": "application/json" },
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

  describe("with a queue", () => {
    beforeEach(() => vi.mocked(tasksConfigured).mockReturnValue(true));

    it("enqueues the task, marks the row queued, and answers with an empty response", async () => {
      const resp = await postSms(BODY);
      expect(resp.status).toBe(200);
      expect(await resp.text()).toBe('<?xml version="1.0" encoding="UTF-8"?>\n<Response></Response>');
      expect(vi.mocked(enqueueEncode)).toHaveBeenCalledWith(SID);
      expect(vi.mocked(markQueued)).toHaveBeenCalledWith("1");
      expect(vi.mocked(runEncodeTask)).not.toHaveBeenCalled();
    });

    it("skips the enqueue for a message already queued", async () => {
      vi.mocked(receiveMessage).mockResolvedValue({ id: "1", requestId: "r", queuedAt: new Date() });
      const resp = await postSms(BODY);
      expect(resp.status).toBe(200);
      expect(vi.mocked(enqueueEncode)).not.toHaveBeenCalled();
      expect(vi.mocked(markQueued)).not.toHaveBeenCalled();
    });

    it("fails the webhook when the enqueue fails, leaving the row received", async () => {
      vi.mocked(enqueueEncode).mockRejectedValue(new Error("Cloud Tasks: HTTP 503"));
      const resp = await postSms(BODY);
      expect(resp.status).toBe(503);
      expect(vi.mocked(markQueued)).not.toHaveBeenCalled();
      expect(vi.mocked(runEncodeTask)).not.toHaveBeenCalled();
    });
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

// The event sink: the same record-and-queue step as the webhook, after reading the message back
// from Twilio so that only a real inbound message to the service number leaves a row.
describe("twilio sink", () => {
  beforeEach(() => vi.mocked(tasksConfigured).mockReturnValue(true));

  it("validates the message at Twilio, records it with Twilio's time, and enqueues", async () => {
    const resp = await postSink(inboundEvent());
    expect(resp.status).toBe(200);
    expect(vi.mocked(fetchMessage)).toHaveBeenCalledWith(SID);
    expect(vi.mocked(receiveMessage)).toHaveBeenCalledWith(
      expect.objectContaining({ messageSid: SID, twilioReceivedAt: RECEIVED }));
    expect(vi.mocked(enqueueEncode)).toHaveBeenCalledWith(SID);
    expect(vi.mocked(markQueued)).toHaveBeenCalledWith("1");
  });

  it("acknowledges and ignores any other event type, including the sink test", async () => {
    const resp = await postSink(testEvent);
    expect(resp.status).toBe(200);
    expect(vi.mocked(fetchMessage)).not.toHaveBeenCalled();
    expect(vi.mocked(receiveMessage)).not.toHaveBeenCalled();
  });

  // Twilio's opt-out handling already answered these; the webhook never sees them either.
  it("acknowledges and skips a STOP, START, or HELP keyword message", async () => {
    const event = inboundEvent();
    event.data = { ...event.data, optOutType: "STOP" };
    const resp = await postSink([event]);
    expect(resp.status).toBe(200);
    expect(vi.mocked(fetchMessage)).not.toHaveBeenCalled();
    expect(vi.mocked(receiveMessage)).not.toHaveBeenCalled();
  });

  it("is a 404 with no row for a SID Twilio does not know, or a message not inbound to us", async () => {
    vi.mocked(fetchMessage).mockResolvedValue({ kind: "not_found" });
    expect((await postSink(inboundEvent())).status).toBe(404);
    vi.mocked(fetchMessage).mockResolvedValue({ kind: "ok", message: { ...INBOUND, direction: "outbound-api" } });
    expect((await postSink(inboundEvent())).status).toBe(404);
    vi.mocked(fetchMessage).mockResolvedValue({ kind: "ok", message: { ...INBOUND, to: "+15559999" } });
    expect((await postSink(inboundEvent())).status).toBe(404);
    expect(vi.mocked(receiveMessage)).not.toHaveBeenCalled();
    expect(vi.mocked(enqueueEncode)).not.toHaveBeenCalled();
  });

  it("asks Twilio to retry the event when its API cannot be reached", async () => {
    vi.mocked(fetchMessage).mockResolvedValue({ kind: "retry" });
    expect((await postSink(inboundEvent())).status).toBe(503);
    expect(vi.mocked(receiveMessage)).not.toHaveBeenCalled();
  });

  it("rejects an event without a message SID, or that is not JSON", async () => {
    expect((await postSink(inboundEvent(null))).status).toBe(400);
    expect((await postSink(inboundEvent("SM123"))).status).toBe(400);
    const raw = await app.request("/twilio-sink", { method: "POST", body: "not json" });
    expect(raw.status).toBe(400);
    expect(vi.mocked(fetchMessage)).not.toHaveBeenCalled();
  });

  it("does not enqueue a message already queued by the webhook", async () => {
    vi.mocked(receiveMessage).mockResolvedValue({ id: "1", requestId: "r", queuedAt: new Date() });
    expect((await postSink(inboundEvent())).status).toBe(200);
    expect(vi.mocked(enqueueEncode)).not.toHaveBeenCalled();
  });

  it("asks Twilio to retry when the row or the enqueue fails", async () => {
    vi.mocked(enqueueEncode).mockRejectedValue(new Error("Cloud Tasks: HTTP 503"));
    expect((await postSink(inboundEvent())).status).toBe(503);
    vi.mocked(receiveMessage).mockRejectedValue(new Error("db down"));
    expect((await postSink(inboundEvent())).status).toBe(503);
  });

  // Twilio delivers an array whatever the batching setting: one element with batching off.
  it("handles the array Twilio delivers, answering by the worst element", async () => {
    expect((await postSink([inboundEvent()])).status).toBe(200);
    expect(vi.mocked(enqueueEncode)).toHaveBeenCalledTimes(1);
    expect((await postSink([testEvent])).status).toBe(200);
    vi.mocked(fetchMessage).mockResolvedValueOnce({ kind: "not_found" });
    expect((await postSink([inboundEvent(), inboundEvent()])).status).toBe(404);
    expect(vi.mocked(enqueueEncode)).toHaveBeenCalledTimes(2);
  });

  it("records a delivery outcome on the reply by its SID, with Twilio's time", async () => {
    expect((await postSink([deliveryEvent("delivered")])).status).toBe(200);
    expect(vi.mocked(recordReplyDelivery)).toHaveBeenCalledWith(
      REPLY_SID, "delivered", new Date("2026-09-15T21:54:26.000Z"), null);
    expect(vi.mocked(fetchMessage)).not.toHaveBeenCalled();
    expect(vi.mocked(receiveMessage)).not.toHaveBeenCalled();
  });

  it("records undelivered and failed with the carrier's error code, however it is typed", async () => {
    expect((await postSink([deliveryEvent("undelivered", { errorCode: 30003 })])).status).toBe(200);
    expect(vi.mocked(recordReplyDelivery)).toHaveBeenLastCalledWith(REPLY_SID, "undelivered", expect.any(Date), 30003);
    expect((await postSink([deliveryEvent("failed", { errorCode: "30008" })])).status).toBe(200);
    expect(vi.mocked(recordReplyDelivery)).toHaveBeenLastCalledWith(REPLY_SID, "failed", expect.any(Date), 30008);
  });

  it("falls back to now when the event has no usable timestamp", async () => {
    const before = Date.now();
    expect((await postSink([deliveryEvent("delivered", { timestamp: undefined })])).status).toBe(200);
    const at = vi.mocked(recordReplyDelivery).mock.calls[0]![2];
    expect(at.getTime()).toBeGreaterThanOrEqual(before);
  });

  it("is a 404 for a delivery event on a SID that is not one of the gateway's replies", async () => {
    vi.mocked(recordReplyDelivery).mockResolvedValue(false);
    expect((await postSink([deliveryEvent("delivered")])).status).toBe(404);
  });

  it("asks Twilio to retry a delivery event the database could not record", async () => {
    vi.mocked(recordReplyDelivery).mockRejectedValue(new Error("db down"));
    expect((await postSink([deliveryEvent("delivered")])).status).toBe(503);
  });

  // With the auth token set, a delivery must carry Twilio's signature over the public sink URL
  // plus the body hash it appends. The in-process URL has the wrong scheme, so the public one is
  // pinned by TWILIO_SINK_URL.
  describe("signature", () => {
    const AUTH = "test-auth-token";
    const SINK_URL = "https://going.blue/twilio-sink";
    const signed = (body: string, token = AUTH) => {
      const url = `${SINK_URL}?bodySHA256=${createHash("sha256").update(body, "utf8").digest("hex")}`;
      const signature = createHmac("sha1", token).update(url, "utf8").digest("base64");
      return app.request(`http://localhost${new URL(url).pathname}${new URL(url).search}`, {
        method: "POST", body, headers: { "Content-Type": "application/json", "X-Twilio-Signature": signature },
      });
    };

    beforeEach(() => {
      process.env["TWILIO_AUTH_TOKEN"] = AUTH;
      process.env["TWILIO_SINK_URL"] = SINK_URL;
    });
    afterEach(() => {
      delete process.env["TWILIO_AUTH_TOKEN"];
      delete process.env["TWILIO_SINK_URL"];
    });

    it("accepts a delivery Twilio signed", async () => {
      const resp = await signed(JSON.stringify([inboundEvent()]));
      expect(resp.status).toBe(200);
      expect(vi.mocked(enqueueEncode)).toHaveBeenCalledWith(SID);
    });

    it("rejects an unsigned delivery, one signed with another token, and a tampered body", async () => {
      expect((await postSink([inboundEvent()])).status).toBe(403);
      expect((await signed(JSON.stringify([inboundEvent()]), "other")).status).toBe(403);
      const body = JSON.stringify([inboundEvent()]);
      const url = `${SINK_URL}?bodySHA256=${createHash("sha256").update(body, "utf8").digest("hex")}`;
      const signature = createHmac("sha1", AUTH).update(url, "utf8").digest("base64");
      const tampered = await app.request(`http://localhost/twilio-sink${new URL(url).search}`, {
        method: "POST", body: body + " ", headers: { "Content-Type": "application/json", "X-Twilio-Signature": signature },
      });
      expect(tampered.status).toBe(403);
      expect(vi.mocked(fetchMessage)).not.toHaveBeenCalled();
      expect(vi.mocked(enqueueEncode)).not.toHaveBeenCalled();
    });
  });

  it("runs the task inline without a queue, like the webhook", async () => {
    vi.mocked(tasksConfigured).mockReturnValue(false);
    expect((await postSink(inboundEvent())).status).toBe(200);
    expect(vi.mocked(runEncodeTask)).toHaveBeenCalledWith(SID, { retryWindowMs: 0, traceId: null });
    expect(vi.mocked(enqueueEncode)).not.toHaveBeenCalled();
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
