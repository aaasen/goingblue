import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Hono } from "hono";
import { countPending, failOverdue, findUnknownSids, listUnqueued, markQueued, recordMissed } from "../src/delivery.js";
import { runEncodeTask } from "../src/encode-task.js";
import { enqueueEncode, tasksConfigured } from "../src/tasks.js";
import { log } from "../src/log.js";
import { listInboundMessages, type InboundMessage } from "../src/twilio.js";
import { FORECAST_NUMBER } from "../src/constants.js";
import { healthCheckRoute, runHealthCheck } from "../src/health-check.js";

// The health check against a stubbed store: what each run reports and what it hands to the queue.

vi.mock("../src/delivery.js", () => ({
  failOverdue: vi.fn(async () => []),
  listUnqueued: vi.fn(async () => []),
  countPending: vi.fn(async () => 0),
  markQueued: vi.fn(async () => {}),
  findUnknownSids: vi.fn(async () => []),
  recordMissed: vi.fn(async () => true),
}));
vi.mock("../src/twilio.js", () => ({
  listInboundMessages: vi.fn(async () => ({ kind: "ok", messages: [] })),
}));
vi.mock("../src/tasks.js", () => ({
  tasksConfigured: vi.fn(() => true),
  enqueueEncode: vi.fn(async () => "queued"),
}));
vi.mock("../src/encode-task.js", () => ({
  runEncodeTask: vi.fn(async () => "done"),
}));

const SID = "SM" + "c".repeat(32);
const SID2 = "SM" + "d".repeat(32);
const HOUR = 3_600_000;
const OPTS = { deadlineMs: 15 * 60_000, graceMs: 60_000, missedAfterMs: 4 * HOUR, lookbackMs: 28 * HOUR };

let info: ReturnType<typeof vi.spyOn>;
let warn: ReturnType<typeof vi.spyOn>;
let error: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  vi.mocked(failOverdue).mockResolvedValue([]);
  vi.mocked(listUnqueued).mockResolvedValue([]);
  vi.mocked(countPending).mockResolvedValue(0);
  vi.mocked(markQueued).mockClear();
  vi.mocked(enqueueEncode).mockClear().mockResolvedValue("queued");
  vi.mocked(tasksConfigured).mockReturnValue(true);
  vi.mocked(runEncodeTask).mockClear();
  vi.mocked(findUnknownSids).mockClear().mockResolvedValue([]);
  vi.mocked(recordMissed).mockClear().mockResolvedValue(true);
  vi.mocked(listInboundMessages).mockClear().mockResolvedValue({ kind: "ok", messages: [] });
  info = vi.spyOn(log, "info").mockImplementation(() => {});
  warn = vi.spyOn(log, "warn").mockImplementation(() => {});
  error = vi.spyOn(log, "error").mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
});

const events = (spy: ReturnType<typeof vi.spyOn>) => spy.mock.calls.map((c) => c[0]);

describe("a quiet run", () => {
  it("logs only the heartbeat", async () => {
    const counts = await runHealthCheck(OPTS);
    expect(counts).toEqual({ overdue: 0, enqueued: 0, scanned: 0, missed: 0, pending: 0 });
    expect(events(info)).toEqual(["health_check.heartbeat"]);
    expect(info).toHaveBeenCalledWith("health_check.heartbeat", counts);
    expect(warn).not.toHaveBeenCalled();
    expect(error).not.toHaveBeenCalled();
  });

  it("passes the deadline and grace to the store in seconds", async () => {
    await runHealthCheck(OPTS);
    expect(failOverdue).toHaveBeenCalledWith(900);
    expect(listUnqueued).toHaveBeenCalledWith(60);
  });
});

describe("overdue requests", () => {
  it("logs one error per request the store failed, tagged with its request id", async () => {
    vi.mocked(failOverdue).mockResolvedValue([
      { id: "1", requestId: "req-1", messageSid: SID, state: "queued", queuedAt: new Date(Date.now() - 20 * 60_000), attempts: 7 },
      { id: "2", requestId: "req-2", messageSid: SID2, state: "encoded", queuedAt: new Date(Date.now() - 16 * 60_000), attempts: 3 },
    ]);
    vi.mocked(countPending).mockResolvedValue(1);
    const counts = await runHealthCheck(OPTS);
    expect(counts).toEqual({ overdue: 2, enqueued: 0, scanned: 0, missed: 0, pending: 1 });
    expect(events(error)).toEqual(["health_check.overdue", "health_check.overdue"]);
    expect(error).toHaveBeenCalledWith("health_check.overdue", { sid: SID, state: "queued", attempts: 7, age_s: 1200 });
    expect(error).toHaveBeenCalledWith("health_check.overdue", { sid: SID2, state: "encoded", attempts: 3, age_s: 960 });
  });
});

describe("received but never queued", () => {
  const unqueued = () => vi.mocked(listUnqueued).mockResolvedValue([
    { id: "1", requestId: "req-1", messageSid: SID, createdAt: new Date(Date.now() - 90_000) },
  ]);

  it("enqueues the task and marks the row", async () => {
    unqueued();
    const counts = await runHealthCheck(OPTS);
    expect(enqueueEncode).toHaveBeenCalledWith(SID);
    expect(markQueued).toHaveBeenCalledWith("1");
    expect(counts.enqueued).toBe(1);
    expect(warn).toHaveBeenCalledWith("health_check.enqueued", { sid: SID, enqueued: "queued", age_s: 90 });
    expect(error).not.toHaveBeenCalled();
  });

  it("marks the row when the queue already has the task", async () => {
    unqueued();
    vi.mocked(enqueueEncode).mockResolvedValue("exists");
    await runHealthCheck(OPTS);
    expect(markQueued).toHaveBeenCalledWith("1");
    expect(warn).toHaveBeenCalledWith("health_check.enqueued", expect.objectContaining({ enqueued: "exists" }));
  });

  it("logs an error and leaves the row when the enqueue fails, and still heartbeats", async () => {
    unqueued();
    vi.mocked(enqueueEncode).mockRejectedValue(new Error("Cloud Tasks: HTTP 503"));
    const counts = await runHealthCheck(OPTS);
    expect(markQueued).not.toHaveBeenCalled();
    expect(counts.enqueued).toBe(0);
    expect(events(error)).toEqual(["health_check.enqueue_failed"]);
    expect(events(info)).toEqual(["health_check.heartbeat"]);
  });

  it("runs the task inline when there is no queue", async () => {
    unqueued();
    vi.mocked(tasksConfigured).mockReturnValue(false);
    await runHealthCheck(OPTS);
    expect(runEncodeTask).toHaveBeenCalledWith(SID, { retryWindowMs: 0, traceId: null });
    expect(enqueueEncode).not.toHaveBeenCalled();
    expect(markQueued).not.toHaveBeenCalled();
    expect(events(info)).toEqual(["health_check.ran", "health_check.heartbeat"]);
  });
});

describe("messages at Twilio that never arrived", () => {
  const at = (hoursAgo: number, over: Partial<InboundMessage> = {}): InboundMessage => ({
    sid: SID, direction: "inbound", from: "+15550100", to: FORECAST_NUMBER, body: "v1 p:a",
    dateCreated: new Date(Date.now() - hoursAgo * HOUR), ...over,
  });
  const listed = (...messages: InboundMessage[]) =>
    vi.mocked(listInboundMessages).mockResolvedValue({ kind: "ok", messages });

  it("reads the number's inbound messages back to the lookback", async () => {
    await runHealthCheck(OPTS);
    const [to, since] = vi.mocked(listInboundMessages).mock.calls[0]!;
    expect(to).toBe(FORECAST_NUMBER);
    expect(Date.now() - since.getTime()).toBeGreaterThanOrEqual(28 * HOUR);
    expect(Date.now() - since.getTime()).toBeLessThan(28 * HOUR + 10_000);
  });

  it("records a message with no row as missed and logs one error for it", async () => {
    const message = at(5);
    listed(message);
    vi.mocked(findUnknownSids).mockResolvedValue([SID]);
    const counts = await runHealthCheck(OPTS);
    expect(findUnknownSids).toHaveBeenCalledWith([SID]);
    expect(recordMissed).toHaveBeenCalledWith({
      requestId: expect.any(String), messageSid: SID, twilioReceivedAt: message.dateCreated,
    });
    expect(events(error)).toEqual(["health_check.missed"]);
    expect(error).toHaveBeenCalledWith("health_check.missed", { sid: SID, age_s: 5 * 3600 });
    expect(counts).toMatchObject({ scanned: 1, missed: 1 });
  });

  it("leaves a message that has a row alone", async () => {
    listed(at(5));
    vi.mocked(findUnknownSids).mockResolvedValue([]);
    const counts = await runHealthCheck(OPTS);
    expect(recordMissed).not.toHaveBeenCalled();
    expect(error).not.toHaveBeenCalled();
    expect(counts).toMatchObject({ scanned: 1, missed: 0 });
  });

  it("does not report a message another run recorded first", async () => {
    listed(at(5));
    vi.mocked(findUnknownSids).mockResolvedValue([SID]);
    vi.mocked(recordMissed).mockResolvedValue(false);
    const counts = await runHealthCheck(OPTS);
    expect(error).not.toHaveBeenCalled();
    expect(counts).toMatchObject({ scanned: 1, missed: 0 });
  });

  it("waits until Twilio has stopped delivering before calling a message missed", async () => {
    listed(at(3.5));
    vi.mocked(findUnknownSids).mockResolvedValue([SID]);
    const counts = await runHealthCheck(OPTS);
    expect(findUnknownSids).not.toHaveBeenCalled();
    expect(counts).toMatchObject({ scanned: 0, missed: 0 });
  });

  it("ignores messages older than the lookback, outbound ones, and undated ones", async () => {
    listed(at(30), at(5, { direction: "outbound-api", sid: SID2 }), at(5, { dateCreated: null }));
    await runHealthCheck(OPTS);
    expect(findUnknownSids).not.toHaveBeenCalled();
  });

  it("ignores opt-out keywords, which Twilio answers itself", async () => {
    listed(at(5, { body: "STOP" }), at(5, { body: " help " }), at(5, { body: "Unsubscribe" }), at(5, { sid: SID2, body: "STOP please" }));
    vi.mocked(findUnknownSids).mockResolvedValue([SID2]);
    const counts = await runHealthCheck(OPTS);
    expect(findUnknownSids).toHaveBeenCalledWith([SID2]);
    expect(counts).toMatchObject({ scanned: 1, missed: 1 });
  });

  it("scans nothing when Twilio cannot be read, and still heartbeats", async () => {
    vi.mocked(listInboundMessages).mockResolvedValue({ kind: "retry" });
    const counts = await runHealthCheck(OPTS);
    expect(findUnknownSids).not.toHaveBeenCalled();
    expect(counts).toMatchObject({ scanned: 0, missed: 0 });
    expect(events(info)).toEqual(["health_check.heartbeat"]);
  });
});

describe("POST /health-check", () => {
  const app = new Hono();
  app.post("/health-check", healthCheckRoute);
  const post = () => app.request("/health-check", { method: "POST" });

  it("answers with the run's counts", async () => {
    vi.mocked(countPending).mockResolvedValue(2);
    const res = await post();
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ overdue: 0, enqueued: 0, scanned: 0, missed: 0, pending: 2 });
  });

  it("is a 500 with no heartbeat when the store fails", async () => {
    vi.mocked(failOverdue).mockRejectedValue(new Error("connection refused"));
    const res = await post();
    expect(res.status).toBe(500);
    expect(events(info)).toEqual([]);
    expect(events(error)).toEqual(["health_check.failed"]);
  });
});
