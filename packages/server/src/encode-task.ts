import type { Context } from "hono";
import { FORECAST_NUMBER } from "./constants.js";
import {
  claimReply, countAttempt, loadDelivery, recordEncoded, recordRejected, recordReplyFailed,
  recordReplySent, recordRequestSent, releaseReply, type DeliveryRequest,
} from "./delivery.js";
import { replyChars, replyParts, resolveForecast } from "./forecast.js";
import { log, traceIdFrom, withRequestId, withTrace } from "./log.js";
import { extractUserToken, extractVersion } from "./dispatch.js";
import { fetchMessage, isMessageSid, sendMessage } from "./twilio.js";

// The encode task: answer one inbound message, identified by its Twilio SID, and record every
// step on its `requests` row. The task is idempotent: each
// step is skipped when the row shows it already taken, so it can be run again after any
// failure, and running it twice never sends a reply twice.
//
// "done" means the row reached a terminal state, or the run found nothing left to do; "retry"
// means a transient failure stopped it and a later run should pick up where it left off.
export type TaskResult = "done" | "retry";

export interface TaskOptions {
  // How long after receipt a codec or upstream failure is still worth retrying. Past it the
  // request is answered with the unavailable reply instead. Zero answers on the first failure.
  retryWindowMs: number;
  traceId: string | null;
}

// How long the Cloud Tasks route keeps retrying a codec or upstream failure before answering
// with the unavailable reply. Shorter than the queue's own retry limit, so the unavailable reply
// itself still has retries left to be sent.
export const ENCODE_RETRY_WINDOW_MS = 5 * 60_000;

export async function runEncodeTask(sid: string, opts: TaskOptions): Promise<TaskResult> {
  const row = await loadDelivery(sid);
  if (row === null) {
    log.error("encode.unknown_sid", { sid });
    return "done";
  }
  return withTrace(opts.traceId, () => withRequestId(row.requestId, () => runAttempt(row, opts)));
}

function terminal(row: DeliveryRequest): boolean {
  return row.sentAt !== null || row.failedAt !== null || row.noReplyAt !== null;
}

async function runAttempt(row: DeliveryRequest, opts: TaskOptions): Promise<TaskResult> {
  if (terminal(row)) {
    log.info("encode.already_done", { sid: row.messageSid });
    return "done";
  }
  await countAttempt(row.id);
  const attempt = row.attempts + 1;

  // The message is read back from Twilio on every run, not only the first: the reply's
  // recipient is never stored here, and reading it from the inbound message is also what
  // proves the SID names a real message sent to us.
  const fetched = await fetchMessage(row.messageSid);
  if (fetched.kind === "retry") return "retry";
  if (fetched.kind === "not_found") {
    log.error("encode.rejected", { sid: row.messageSid, reason: "not_found" });
    await recordRejected(row.id);
    return "done";
  }
  const message = fetched.message;
  if (message.direction !== "inbound" || message.to !== FORECAST_NUMBER) {
    log.error("encode.rejected", { sid: row.messageSid, reason: "not_inbound", direction: message.direction });
    await recordRejected(row.id);
    return "done";
  }

  let current = row;
  if (current.encodedAt === null) {
    const body = message.body.trim();
    log.info("encode.start", { sid: row.messageSid, attempt, len: body.length });
    const result = await resolveForecast(body, row.requestId, opts.traceId);
    if (result.kind === "unavailable") {
      const deadline = (row.queuedAt ?? row.createdAt).getTime() + opts.retryWindowMs;
      if (Date.now() < deadline) {
        log.info("encode.retry", { sid: row.messageSid, attempt });
        return "retry";
      }
      log.error("encode.gave_up", { sid: row.messageSid, attempt });
    }
    const recorded = await recordEncoded(row.id, {
      token: extractUserToken(body),
      chars: replyChars(result),
      version: extractVersion(body),
      outcome: result.kind,
      codecMs: "codecMs" in result ? result.codecMs : null,
      shape: result.kind === "ok" ? result.shape : null,
      twilioReceivedAt: message.dateCreated,
      replies: replyParts(result),
    });
    if (!recorded) log.info("encode.raced", { sid: row.messageSid });
    // Reload either way: the reply rows to send are whichever run's encode won.
    current = (await loadDelivery(row.messageSid))!;
    if (terminal(current)) return "done";
  }

  for (const reply of current.replies) {
    if (reply.sid !== null || reply.sendingAt !== null) continue;
    if (!(await claimReply(reply.id))) continue;
    const sent = await sendMessage(message.from, message.to, reply.body);
    if (sent.kind === "sent") {
      await recordReplySent(reply.id, sent.sid, sent.segments);
      log.info("reply.sent", { sid: row.messageSid, part: reply.part, reply_sid: sent.sid, segments: sent.segments });
      continue;
    }
    if (sent.kind === "rejected") {
      await recordReplyFailed(current.id, reply.id, sent.code);
      log.error("reply.failed", { sid: row.messageSid, part: reply.part, code: sent.code });
      return "done";
    }
    // Not sent, as far as Twilio said. The claim is given back so the part is tried again; the
    // one way a duplicate can happen is Twilio creating the message and then failing to say so.
    await releaseReply(reply.id);
    return "retry";
  }

  // Reloaded rather than tracked: parts sent by another run of the same task count too.
  const after = (await loadDelivery(row.messageSid))!;
  if (after.replies.every((r) => r.sid !== null)) {
    await recordRequestSent(after.id);
    log.info("encode.sent", { sid: row.messageSid, attempt, parts: after.replies.length });
  }
  return "done";
}

// POST /api/encode { sid }: the Cloud Tasks target. 200 clears the task from the queue and 503
// asks for it back. Not registered until the queue exists; only /sms runs the task today.
export async function encodeTaskRoute(c: Context) {
  const body = await c.req.json().catch(() => ({} as Record<string, unknown>));
  const sid = body?.sid;
  if (!isMessageSid(sid)) return c.text("Invalid sid", 400);
  const traceId = traceIdFrom(c.req.header("X-Cloud-Trace-Context"));
  const result = await runEncodeTask(sid, { retryWindowMs: ENCODE_RETRY_WINDOW_MS, traceId });
  return result === "done" ? c.text("ok", 200) : c.text("retry", 503);
}
