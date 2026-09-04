import { describe, it, expect, vi, afterEach } from "vitest";
import { log, withRequestId } from "../src/log.js";

// Capture what the logger actually wrote. Every assertion here is about the shape of the wire
// format — one parseable line per call — because that is the contract log consumers depend on.
function capture(fn: () => void): string[] {
  const lines: string[] = [];
  const record = (...args: unknown[]) => void lines.push(args.join(" "));
  const out = vi.spyOn(console, "log").mockImplementation(record);
  const err = vi.spyOn(console, "error").mockImplementation(record);
  try {
    fn();
  } finally {
    out.mockRestore();
    err.mockRestore();
  }
  return lines;
}

afterEach(() => vi.restoreAllMocks());

describe("log", () => {
  it("writes one line of JSON per call", () => {
    const lines = capture(() => log.info("sms.inbound", { sid: "SM0123456789abcdef0123456789abcdef", len: 42 }));
    expect(lines).toHaveLength(1);
    expect(lines[0]).not.toContain("\n");
    expect(JSON.parse(lines[0]!)).toEqual({
      severity: "INFO",
      message: "sms.inbound",
      event: "sms.inbound",
      sid: "SM0123456789abcdef0123456789abcdef",
      len: 42,
    });
  });

  it("maps each level to its Cloud Logging severity", () => {
    const lines = capture(() => {
      log.debug("a");
      log.info("b");
      log.error("c");
    });
    expect(lines.map((l) => JSON.parse(l).severity)).toEqual(["DEBUG", "INFO", "ERROR"]);
  });

  it("writes errors to stderr and everything else to stdout", () => {
    const out = vi.spyOn(console, "log").mockImplementation(() => {});
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    log.info("ok");
    log.error("bad");
    expect(out).toHaveBeenCalledTimes(1);
    expect(err).toHaveBeenCalledTimes(1);
  });

  it("keeps a multi-line stack on one line, under stack_trace", () => {
    const e = new Error("fetch failed");
    e.stack = "Error: fetch failed\n    at one\n    at two";
    const lines = capture(() => log.error("codec.unreachable", { version: 1, err: e }));
    expect(lines).toHaveLength(1);
    expect(lines[0]).not.toContain("\n");
    const entry = JSON.parse(lines[0]!);
    expect(entry.err).toBe("fetch failed");
    expect(entry.stack_trace).toBe(e.stack);
  });

  it("drops undefined fields rather than emitting nulls", () => {
    const lines = capture(() => log.info("forecast.dispatch", { kind: "ok", chars: undefined }));
    expect(JSON.parse(lines[0]!)).not.toHaveProperty("chars");
  });

  it("still emits the event when a field cannot be serialized", () => {
    const circular: Record<string, unknown> = {};
    circular["self"] = circular;
    const lines = capture(() => log.info("encode.request", { circular }));
    expect(lines).toHaveLength(1);
    const entry = JSON.parse(lines[0]!);
    expect(entry.event).toBe("encode.request");
    expect(entry.log_error).toBe("unserializable fields");
  });
});

describe("withRequestId", () => {
  const RID = "8f6b1c2e-0000-4000-8000-000000000001";

  it("tags every line logged inside the scope", () => {
    const lines = capture(() => withRequestId(RID, () => {
      log.info("sms.inbound", { len: 42 });
      log.error("codec.unreachable", { version: 4 });
    }));
    expect(lines.map((l) => JSON.parse(l).request_id)).toEqual([RID, RID]);
  });

  it("leaves lines outside any scope untagged", () => {
    const lines = capture(() => log.info("server.listening", { port: 8080 }));
    expect(JSON.parse(lines[0]!)).not.toHaveProperty("request_id");
  });

  it("does not tag when there is no id, rather than inventing one", () => {
    const lines = capture(() => withRequestId(null, () => log.info("encode.request")));
    expect(JSON.parse(lines[0]!)).not.toHaveProperty("request_id");
  });

  it("carries the id across awaits, which is how the deep events get it", async () => {
    const lines: string[] = [];
    const record = (...args: unknown[]) => void lines.push(args.join(" "));
    const out = vi.spyOn(console, "log").mockImplementation(record);
    try {
      await withRequestId(RID, async () => {
        await Promise.resolve();
        await new Promise((r) => setTimeout(r, 0));
        log.info("openmeteo.request");
      });
    } finally {
      out.mockRestore();
    }
    expect(JSON.parse(lines[0]!).request_id).toBe(RID);
  });

  it("keeps concurrent requests apart", async () => {
    const lines: string[] = [];
    const record = (...args: unknown[]) => void lines.push(args.join(" "));
    const out = vi.spyOn(console, "log").mockImplementation(record);
    const one = async (id: string) => withRequestId(id, async () => {
      await new Promise((r) => setTimeout(r, 0));
      log.info("forecast.dispatch", { kind: "ok" });
    });
    try {
      await Promise.all([one("a"), one("b")]);
    } finally {
      out.mockRestore();
    }
    expect(lines.map((l) => JSON.parse(l).request_id).sort()).toEqual(["a", "b"]);
  });

  it("keeps the id on the fallback line when the fields cannot be serialized", () => {
    const circular: Record<string, unknown> = {};
    circular["self"] = circular;
    const lines = capture(() => withRequestId(RID, () => log.info("encode.request", circular)));
    expect(JSON.parse(lines[0]!)).toEqual({
      severity: "INFO",
      message: "encode.request",
      event: "encode.request",
      request_id: RID,
      log_error: "unserializable fields",
    });
  });
});
