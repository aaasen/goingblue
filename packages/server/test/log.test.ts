import { describe, it, expect, vi, afterEach } from "vitest";
import { log } from "../src/log.js";

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
    const lines = capture(() => log.info("sms.inbound", { from: "+15555550123", len: 42 }));
    expect(lines).toHaveLength(1);
    expect(lines[0]).not.toContain("\n");
    expect(JSON.parse(lines[0]!)).toEqual({
      severity: "INFO",
      message: "sms.inbound",
      event: "sms.inbound",
      from: "+15555550123",
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
