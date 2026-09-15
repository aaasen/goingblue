import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { enqueueEncode, tasksConfigured } from "../src/tasks.js";

// The enqueue against a stubbed metadata server and Cloud Tasks API.

const QUEUE = "projects/p/locations/r/queues/encode";
const URL_ = "https://going.blue/encode";
const SID = "SM" + "b".repeat(32);

let createStatus: number;
let tokens: number;
function stub() {
  tokens = 0;
  vi.stubGlobal("fetch", vi.fn(async (url: string) => {
    if (url.startsWith("http://metadata.google.internal/")) {
      tokens++;
      return new Response(JSON.stringify({ access_token: `tok${tokens}`, expires_in: 3600 }), { status: 200 });
    }
    if (url.startsWith("https://cloudtasks.googleapis.com/")) {
      return new Response(createStatus === 409 ? '{"error":{"status":"ALREADY_EXISTS"}}' : "{}", { status: createStatus });
    }
    throw new Error(`unexpected fetch ${url}`);
  }));
}

beforeEach(() => {
  process.env["ENCODE_QUEUE"] = QUEUE;
  process.env["ENCODE_URL"] = URL_;
  createStatus = 200;
  stub();
});

afterEach(() => {
  vi.unstubAllGlobals();
  delete process.env["ENCODE_QUEUE"];
  delete process.env["ENCODE_URL"];
});

describe("tasksConfigured", () => {
  it("needs both the queue and the task URL", () => {
    expect(tasksConfigured()).toBe(true);
    delete process.env["ENCODE_URL"];
    expect(tasksConfigured()).toBe(false);
  });
});

describe("enqueueEncode", () => {
  it("creates a task named by the SID that posts the SID to the encode URL", async () => {
    expect(await enqueueEncode(SID)).toBe("queued");
    const create = vi.mocked(fetch).mock.calls.find((c) => String(c[0]).startsWith("https://cloudtasks"))!;
    expect(create[0]).toBe(`https://cloudtasks.googleapis.com/v2/${QUEUE}/tasks`);
    const init = create[1] as RequestInit;
    expect((init.headers as Record<string, string>)["Authorization"]).toMatch(/^Bearer tok\d+$/);
    expect(JSON.parse(init.body as string)).toEqual({
      task: {
        name: `${QUEUE}/tasks/${SID}`,
        httpRequest: { url: `${URL_}?sid=${SID}`, httpMethod: "POST" },
        dispatchDeadline: "40s",
      },
    });
  });

  it("reads a task that already exists as enqueued", async () => {
    createStatus = 409;
    expect(await enqueueEncode(SID)).toBe("exists");
  });

  it("throws when the queue refuses for any other reason", async () => {
    createStatus = 403;
    await expect(enqueueEncode(SID)).rejects.toThrow("HTTP 403");
  });

  it("throws when unconfigured, without calling anything", async () => {
    delete process.env["ENCODE_QUEUE"];
    await expect(enqueueEncode(SID)).rejects.toThrow("not configured");
    expect(fetch).not.toHaveBeenCalled();
  });

  // The cache lives in the module, so the count here covers whatever earlier tests left in it.
  it("reuses the token across enqueues", async () => {
    await enqueueEncode(SID);
    await enqueueEncode(SID);
    expect(tokens).toBeLessThanOrEqual(1);
    const bearers = vi.mocked(fetch).mock.calls
      .filter((c) => String(c[0]).startsWith("https://cloudtasks"))
      .map((c) => ((c[1] as RequestInit).headers as Record<string, string>)["Authorization"]);
    expect(new Set(bearers).size).toBe(1);
  });
});
