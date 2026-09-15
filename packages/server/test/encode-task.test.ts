import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { randomBytes } from "node:crypto";
import { generateToken } from "@weather/protocol";
import { FORECAST_NUMBER } from "../src/constants.js";
import { Hono } from "hono";
import { ENCODE_RETRY_WINDOW_MS, encodeTaskRoute, runEncodeTask } from "../src/encode-task.js";
import { accountExists } from "../src/accounts.js";
import { log } from "../src/log.js";
import type { DeliveryRequest, EncodedRecord, Reply } from "../src/delivery.js";

// The task's state machine, run against an in-memory copy of the delivery store with the same
// guards as the SQL (delivery.ts), a Twilio stubbed by URL, and a stubbed codec.

vi.mock("../src/accounts.js", () => ({
  accountExists: vi.fn(async () => true),
}));

interface Row extends DeliveryRequest {
  outcome: string | null;
  chars: number | null;
  version: number | null;
  token: string | null;
}

const rows = new Map<string, Row>();

vi.mock("../src/delivery.js", () => ({
  loadDelivery: vi.fn(async (sid: string) => {
    const r = rows.get(sid);
    return r ? structuredClone(r) : null;
  }),
  countAttempt: vi.fn(async (id: string) => { byId(id).attempts += 1; }),
  recordEncoded: vi.fn(async (id: string, e: EncodedRecord) => {
    const r = byId(id);
    if (r.encodedAt !== null) return false;
    r.encodedAt = new Date();
    r.outcome = e.outcome;
    r.chars = e.chars;
    r.version = e.version;
    r.token = e.token;
    if (e.replies.length === 0) r.noReplyAt = new Date();
    r.replies = e.replies.map((body, i) => ({
      id: `${id}-${i + 1}`, part: i + 1, body, sid: null, sendingAt: null, sentAt: null, failedAt: null,
    }));
    return true;
  }),
  recordRejected: vi.fn(async (id: string) => {
    const r = byId(id);
    if (r.encodedAt === null && r.noReplyAt === null) { r.outcome = "rejected"; r.noReplyAt = new Date(); }
  }),
  claimReply: vi.fn(async (replyId: string) => {
    const p = reply(replyId);
    if (p.sendingAt !== null) return false;
    p.sendingAt = new Date();
    return true;
  }),
  releaseReply: vi.fn(async (replyId: string) => {
    const p = reply(replyId);
    if (p.sid === null) p.sendingAt = null;
  }),
  recordReplySent: vi.fn(async (replyId: string, sid: string) => {
    const p = reply(replyId);
    p.sid = sid;
    p.sentAt = new Date();
  }),
  recordReplyFailed: vi.fn(async (id: string, replyId: string) => {
    reply(replyId).failedAt = new Date();
    byId(id).failedAt = new Date();
  }),
  recordRequestSent: vi.fn(async (id: string) => {
    const r = byId(id);
    if (r.sentAt === null) r.sentAt = new Date();
  }),
}));

function byId(id: string): Row {
  for (const r of rows.values()) if (r.id === id) return r;
  throw new Error(`no row ${id}`);
}

function reply(replyId: string): Reply {
  for (const r of rows.values()) for (const p of r.replies) if (p.id === replyId) return p;
  throw new Error(`no reply ${replyId}`);
}

const SID = "SM" + "a".repeat(32);
const SENDER = "+15550100";
const TOKEN = generateToken((n) => Uint8Array.from(randomBytes(n)));
const BODY = `v1 p:a u:${TOKEN}`;

function receive(over: Partial<Row> = {}): Row {
  const row: Row = {
    id: "1", requestId: "req-1", messageSid: SID, createdAt: new Date(), queuedAt: null,
    encodedAt: null, sentAt: null, failedAt: null, noReplyAt: null, attempts: 0, replies: [],
    outcome: null, chars: null, version: null, token: null, ...over,
  };
  rows.set(SID, row);
  return row;
}

// The Twilio side, as a fetch stub keyed by URL. `inbound` is what the message lookup returns;
// `send` answers each REST send in turn (the last answer repeats).
type Inbound = { status: number; body?: Record<string, unknown> };
type Send = { status: number; body?: Record<string, unknown> } | "unreachable";

let inbound: Inbound;
let sends: Send[];
let codec: () => Response;
let sentBodies: string[];

function message(over: Record<string, unknown> = {}): Inbound {
  return {
    status: 200,
    body: { sid: SID, direction: "inbound", from: SENDER, to: FORECAST_NUMBER, body: BODY,
            date_created: "Tue, 15 Sep 2026 16:00:00 +0000", ...over },
  };
}

function json(status: number, body: Record<string, unknown> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

let sendCount = 0;
function stubFetch() {
  vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
    if (url.startsWith("http://codec-v1/")) return codec();
    if (url.includes("/Messages.json") && init?.method === "POST") {
      const n = sendCount++;
      const answer = sends[Math.min(n, sends.length - 1)]!;
      if (answer === "unreachable") throw new Error("ECONNRESET");
      sentBodies.push(String(new URLSearchParams(init.body as string).get("Body")));
      return json(answer.status, answer.body ?? { sid: `SMreply${n}`, num_segments: "1" });
    }
    if (url.includes(`/Messages/${SID}.json`)) return json(inbound.status, inbound.body ?? {});
    throw new Error(`unexpected fetch ${url}`);
  }));
}

const run = (retryWindowMs = ENCODE_RETRY_WINDOW_MS) => runEncodeTask(SID, { retryWindowMs, traceId: null });

beforeEach(() => {
  rows.clear();
  process.env["CODEC_URL_V1"] = "http://codec-v1";
  process.env["TWILIO_ACCOUNT_SID"] = "ACtest";
  process.env["TWILIO_AUTH_TOKEN"] = "token";
  inbound = message();
  sends = [{ status: 201 }];
  sendCount = 0;
  sentBodies = [];
  codec = () => new Response("ENCODED", { status: 200 });
  vi.mocked(accountExists).mockResolvedValue(true);
  stubFetch();
});

afterEach(() => {
  vi.unstubAllGlobals();
  delete process.env["CODEC_URL_V1"];
  delete process.env["TWILIO_ACCOUNT_SID"];
  delete process.env["TWILIO_AUTH_TOKEN"];
});

describe("the happy path", () => {
  it("encodes, sends one part to the sender from our number, and marks the request sent", async () => {
    const row = receive();
    expect(await run()).toBe("done");
    expect(row.outcome).toBe("ok");
    expect(row.token).toBe(TOKEN);
    expect(row.version).toBe(1);
    expect(row.chars).toBe("ENCODED".length);
    expect(row.attempts).toBe(1);
    expect(row.replies).toEqual([expect.objectContaining({ part: 1, body: "ENCODED", sid: "SMreply0" })]);
    expect(row.sentAt).not.toBeNull();
    expect(sentBodies).toEqual(["ENCODED"]);
    const send = vi.mocked(fetch).mock.calls.find((c) => (c[1] as RequestInit)?.method === "POST"
      && String(c[0]).includes("Messages.json"))!;
    const form = new URLSearchParams((send[1] as RequestInit).body as string);
    expect(form.get("To")).toBe(SENDER);
    expect(form.get("From")).toBe(FORECAST_NUMBER);
  });

  it("sends a multi-message reply as one part per line, in order", async () => {
    codec = () => new Response("ONE\nTWO", { status: 200 });
    const row = receive();
    expect(await run()).toBe("done");
    expect(sentBodies).toEqual(["ONE", "TWO"]);
    expect(row.replies.map((p) => p.sid)).toEqual(["SMreply0", "SMreply1"]);
    expect(row.sentAt).not.toBeNull();
  });

  it("answers a rejected request with the human reply", async () => {
    vi.mocked(accountExists).mockResolvedValue(false);
    const row = receive();
    expect(await run()).toBe("done");
    expect(row.outcome).toBe("unknown_token");
    expect(sentBodies[0]).toContain("Download the app at going.blue");
    expect(row.sentAt).not.toBeNull();
  });

  it("does nothing more for a request already sent", async () => {
    const row = receive({ sentAt: new Date(), attempts: 1 });
    expect(await run()).toBe("done");
    expect(row.attempts).toBe(1);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("reports a SID it has no row for", async () => {
    expect(await run()).toBe("unknown");
    expect(fetch).not.toHaveBeenCalled();
  });
});

describe("validation against Twilio", () => {
  it("rejects a SID Twilio does not know, with no reply", async () => {
    inbound = { status: 404, body: { code: 20404 } };
    const row = receive();
    expect(await run()).toBe("done");
    expect(row.outcome).toBe("rejected");
    expect(row.noReplyAt).not.toBeNull();
    expect(row.encodedAt).toBeNull();
    expect(sentBodies).toEqual([]);
  });

  it("rejects a message that is not inbound, or not sent to us", async () => {
    inbound = message({ direction: "outbound-api" });
    let row = receive();
    expect(await run()).toBe("done");
    expect(row.outcome).toBe("rejected");

    rows.clear();
    inbound = message({ to: "+15559999" });
    row = receive();
    expect(await run()).toBe("done");
    expect(row.outcome).toBe("rejected");
    expect(sentBodies).toEqual([]);
  });

  it("retries when the lookup fails, encoding nothing", async () => {
    inbound = { status: 503 };
    const row = receive();
    expect(await run()).toBe("retry");
    expect(row.encodedAt).toBeNull();
    expect(row.attempts).toBe(1);
  });

  it("retries when it has no Twilio credentials", async () => {
    delete process.env["TWILIO_ACCOUNT_SID"];
    receive();
    expect(await run()).toBe("retry");
  });
});

describe("no reply owed", () => {
  it.each(["stale", "future"])("records %s with no reply rows and no send", async (side) => {
    codec = () => new Response(side, { status: 422 });
    const row = receive();
    expect(await run()).toBe("done");
    expect(row.outcome).toBe(side);
    expect(row.encodedAt).not.toBeNull();
    expect(row.noReplyAt).not.toBeNull();
    expect(row.replies).toEqual([]);
    expect(sentBodies).toEqual([]);
  });
});

describe("codec unavailable", () => {
  it("retries inside the window without writing an outcome", async () => {
    codec = () => new Response("boom", { status: 503 });
    const row = receive();
    expect(await run()).toBe("retry");
    expect(row.encodedAt).toBeNull();
    expect(row.outcome).toBeNull();
    expect(sentBodies).toEqual([]);
  });

  it("answers with the unavailable reply once the window has passed", async () => {
    codec = () => new Response("boom", { status: 503 });
    const row = receive({ createdAt: new Date(Date.now() - ENCODE_RETRY_WINDOW_MS - 1) });
    expect(await run()).toBe("done");
    expect(row.outcome).toBe("unavailable");
    expect(sentBodies[0]).toContain("not available right now");
    expect(row.sentAt).not.toBeNull();
  });

  it("measures the window from the enqueue time when there is one", async () => {
    codec = () => new Response("boom", { status: 503 });
    const row = receive({
      createdAt: new Date(Date.now() - ENCODE_RETRY_WINDOW_MS - 1),
      queuedAt: new Date(),
    });
    expect(await run()).toBe("retry");
    expect(row.encodedAt).toBeNull();
  });

  // The alert fires on errors, so the attempt that will be retried logs the codec failure as a
  // warning and only the attempt that gives up logs an error.
  it("logs the codec failure as a warning while retrying and as an error on giving up", async () => {
    codec = () => new Response("boom", { status: 503 });
    const warn = vi.spyOn(log, "warn").mockImplementation(() => {});
    const error = vi.spyOn(log, "error").mockImplementation(() => {});
    receive();
    expect(await run()).toBe("retry");
    expect(warn).toHaveBeenCalledWith("codec.error_response", expect.objectContaining({ status: 503 }));
    expect(error).not.toHaveBeenCalled();

    rows.clear();
    receive({ createdAt: new Date(Date.now() - ENCODE_RETRY_WINDOW_MS - 1) });
    expect(await run()).toBe("done");
    expect(error).toHaveBeenCalledWith("codec.error_response", expect.objectContaining({ status: 503 }));
    expect(error).toHaveBeenCalledWith("encode.gave_up", expect.anything());
    warn.mockRestore();
    error.mockRestore();
  });

  it("answers on the first failure with no window", async () => {
    codec = () => new Response("boom", { status: 503 });
    const row = receive();
    expect(await run(0)).toBe("done");
    expect(row.outcome).toBe("unavailable");
  });

  // The codec was reached and answered in time on the retry.
  it("serves the forecast on a later run", async () => {
    codec = () => new Response("boom", { status: 503 });
    const row = receive();
    expect(await run()).toBe("retry");
    codec = () => new Response("ENCODED", { status: 200 });
    expect(await run()).toBe("done");
    expect(row.outcome).toBe("ok");
    expect(row.attempts).toBe(2);
    expect(sentBodies).toEqual(["ENCODED"]);
  });
});

describe("sending", () => {
  it("retries a send Twilio refused with 429 or 5xx, and sends it once on the next run", async () => {
    sends = [{ status: 429, body: { code: 20429 } }, { status: 201 }];
    const row = receive();
    expect(await run()).toBe("retry");
    expect(row.replies[0]!.sid).toBeNull();
    expect(row.replies[0]!.sendingAt).toBeNull();
    expect(row.sentAt).toBeNull();
    expect(await run()).toBe("done");
    expect(row.replies[0]!.sid).toBe("SMreply1");
    expect(row.sentAt).not.toBeNull();
    // Encoded once: the second run reused the stored reply.
    expect(vi.mocked(fetch).mock.calls.filter((c) => String(c[0]).startsWith("http://codec-v1/")).length).toBe(1);
  });

  it("retries when Twilio is unreachable", async () => {
    sends = ["unreachable"];
    const row = receive();
    expect(await run()).toBe("retry");
    expect(row.replies[0]!.sendingAt).toBeNull();
  });

  it("fails the request on a terminal send error, recording the code, and stops", async () => {
    codec = () => new Response("ONE\nTWO", { status: 200 });
    sends = [{ status: 400, body: { code: 21610, message: "opted out" } }];
    const row = receive();
    expect(await run()).toBe("done");
    expect(row.failedAt).not.toBeNull();
    expect(row.replies[0]!.failedAt).not.toBeNull();
    expect(row.replies[1]!.sendingAt).toBeNull();
    expect(sentBodies).toEqual(["ONE"]);
    // A later run finds it terminal.
    expect(await run()).toBe("done");
    expect(row.attempts).toBe(1);
  });

  it("never sends a part again once it has a SID, or once claimed by a run that did not finish", async () => {
    codec = () => new Response("ONE\nTWO", { status: 200 });
    sends = [{ status: 201 }, "unreachable", { status: 201 }];
    const row = receive();
    expect(await run()).toBe("retry");
    // The first part is sent, the second was released after the failed send.
    expect(row.replies.map((p) => p.sid)).toEqual(["SMreply0", null]);
    expect(await run()).toBe("done");
    expect(sentBodies).toEqual(["ONE", "TWO"]);
    expect(row.replies.map((p) => p.sid)).toEqual(["SMreply0", "SMreply2"]);
    expect(row.sentAt).not.toBeNull();

    // A claim with no outcome is left alone: the send may have gone out.
    rows.clear();
    sentBodies = [];
    const stuck = receive({ encodedAt: new Date(), replies: [
      { id: "1-1", part: 1, body: "ONE", sid: null, sendingAt: new Date(), sentAt: null, failedAt: null },
    ] });
    expect(await run()).toBe("done");
    expect(sentBodies).toEqual([]);
    expect(stuck.sentAt).toBeNull();
  });

  it("resumes at the sending step when the request is already encoded", async () => {
    const row = receive({ encodedAt: new Date(), outcome: "ok", replies: [
      { id: "1-1", part: 1, body: "STORED", sid: null, sendingAt: null, sentAt: null, failedAt: null },
    ] });
    expect(await run()).toBe("done");
    expect(sentBodies).toEqual(["STORED"]);
    expect(row.sentAt).not.toBeNull();
    expect(vi.mocked(fetch).mock.calls.some((c) => String(c[0]).startsWith("http://codec-v1/"))).toBe(false);
  });
});

// The public route: the SID is a query parameter, and the status is the task's result, with a
// SID never received as a 404 rather than an error.
describe("POST /encode", () => {
  const app = new Hono();
  app.post("/encode", encodeTaskRoute);
  const post = (sid: string) => app.request(`/encode?sid=${sid}`, { method: "POST" });

  it("runs the task for the SID", async () => {
    receive();
    expect((await post(SID)).status).toBe(200);
    expect(sentBodies).toEqual(["ENCODED"]);
  });

  it("rejects a missing or malformed SID without touching anything", async () => {
    expect((await app.request("/encode", { method: "POST" })).status).toBe(400);
    expect((await post("SM123")).status).toBe(400);
    // A body is not where the SID lives.
    const body = await app.request("/encode", {
      method: "POST", body: JSON.stringify({ sid: SID }), headers: { "Content-Type": "application/json" },
    });
    expect(body.status).toBe(400);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("is a 404 for a SID never received", async () => {
    expect((await post(SID)).status).toBe(404);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("asks for the task back with 503 when the run must retry", async () => {
    codec = () => new Response("boom", { status: 503 });
    receive();
    expect((await post(SID)).status).toBe(503);
  });

  it("uses the full retry window", async () => {
    codec = () => new Response("boom", { status: 503 });
    const row = receive({ createdAt: new Date(Date.now() - ENCODE_RETRY_WINDOW_MS + 60_000) });
    expect((await post(SID)).status).toBe(503);
    expect(row.outcome).toBeNull();
  });
});
