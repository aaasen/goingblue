import { invokerEmail } from "./invoker.js";
import { log } from "./log.js";

// Cloud Tasks enqueue for the encode task, over the REST API with a token from the Cloud Run
// metadata server: no client library, since this is the gateway's only Google API call.
//
// Configured by ENCODE_QUEUE, the queue's full resource name, and ENCODE_URL, the public
// /encode URL each task posts to. With neither set there is no queue, and /sms runs the task
// inline instead. With INVOKER_EMAIL set each task carries an identity token for that service
// account, minted by Cloud Tasks with the /encode URL as its audience, which is what /encode
// checks (invoker.ts).

const TASKS_API = "https://cloudtasks.googleapis.com/v2";
const METADATA_TOKEN_URL =
  "http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token";
const TIMEOUT_MS = 5_000;
// The task's own deadline for /encode to answer, from the queue design.
const DISPATCH_DEADLINE = "40s";

export function tasksConfigured(): boolean {
  return Boolean(process.env["ENCODE_QUEUE"] && process.env["ENCODE_URL"]);
}

// The service account token, kept until shortly before it expires. The metadata server caches
// tokens itself, so the margin only has to cover this process's clock.
let cached: { token: string; expiresAt: number } | null = null;

async function accessToken(): Promise<string> {
  if (cached && Date.now() < cached.expiresAt - 60_000) return cached.token;
  const resp = await fetch(METADATA_TOKEN_URL, {
    headers: { "Metadata-Flavor": "Google" },
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!resp.ok) throw new Error(`metadata token: HTTP ${resp.status}`);
  const body = await resp.json() as { access_token?: unknown; expires_in?: unknown };
  if (typeof body.access_token !== "string") throw new Error("metadata token: no access_token");
  const ttl = typeof body.expires_in === "number" ? body.expires_in : 0;
  cached = { token: body.access_token, expiresAt: Date.now() + ttl * 1000 };
  return body.access_token;
}

// Enqueue the encode task for one message. The task is named by the SID, so a second enqueue
// of the same message, from a webhook retry or the event sink, is refused by the queue and
// reads as "exists". Anything else that stops the enqueue throws: the caller has no task and
// must say so.
export async function enqueueEncode(sid: string): Promise<"queued" | "exists"> {
  const queue = process.env["ENCODE_QUEUE"];
  const url = process.env["ENCODE_URL"];
  if (!queue || !url) throw new Error("Cloud Tasks not configured");
  const token = await accessToken();
  const resp = await fetch(`${TASKS_API}/${queue}/tasks`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      task: {
        name: `${queue}/tasks/${sid}`,
        httpRequest: {
          url: `${url}?sid=${sid}`,
          httpMethod: "POST",
          ...(invokerEmail() ? { oidcToken: { serviceAccountEmail: invokerEmail(), audience: url } } : {}),
        },
        dispatchDeadline: DISPATCH_DEADLINE,
      },
    }),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (resp.ok) return "queued";
  if (resp.status === 409) return "exists";
  const text = await resp.text().catch(() => "");
  log.error("tasks.create_failed", { sid, status: resp.status, body: text.slice(0, 500) });
  throw new Error(`Cloud Tasks: HTTP ${resp.status}`);
}
