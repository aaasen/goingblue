import type { Context } from "hono";
import { countPending, failOverdue, listUnqueued, markQueued } from "./delivery.js";
import { runEncodeTask } from "./encode-task.js";
import { log, withRequestId } from "./log.js";
import { enqueueEncode, tasksConfigured } from "./tasks.js";

// The health check: a periodic pass over the delivery store that makes sure every message reaches
// a terminal state in bounded time, and says so when one did not. The encode task and the queue
// carry a message to its reply on their own; this catches what falls between them, which is a
// task that was never enqueued or one the queue gave up on. Each run:
//
//   1. Fails every request whose task was queued longer ago than the queue will retry, and logs
//      an error for each. That line is the alert: a message went unanswered.
//   2. Enqueues the task for every message received a while ago that never got one, because
//      both the webhook and the event sink failed to enqueue it.
//   3. Logs a heartbeat with the run's counts, whose absence is the other alert.
//
// Every step is idempotent, so runs may overlap or repeat: a request is failed once, and an
// enqueue of a task that already exists is refused by the queue and reads as "exists".

export interface HealthCheckOptions {
  // How long after enqueue a request may still be in flight. Past this the queue has stopped
  // retrying and the request is failed.
  deadlineMs: number;
  // How long a received message may go without a task before the health check enqueues one; long
  // enough to never overtake the webhook or sink that just recorded it.
  graceMs: number;
}

// The queue retries for 10 minutes from the first attempt and gives each attempt 40 seconds
// (DEPLOYMENT.md, tasks.ts); the rest is margin for the queue's own scheduling.
export const HEALTH_CHECK_DEADLINE_MS = 15 * 60_000;
export const HEALTH_CHECK_GRACE_MS = 60_000;

export interface HealthCheckCounts {
  overdue: number;
  enqueued: number;
  pending: number;
}

export async function runHealthCheck(opts: HealthCheckOptions): Promise<HealthCheckCounts> {
  const overdue = await failOverdue(opts.deadlineMs / 1000);
  for (const r of overdue) {
    withRequestId(r.requestId, () => log.error("health_check.overdue", {
      sid: r.messageSid, state: r.state, attempts: r.attempts,
      age_s: Math.round((Date.now() - r.queuedAt.getTime()) / 1000),
    }));
  }

  let enqueued = 0;
  for (const r of await listUnqueued(opts.graceMs / 1000)) {
    const age_s = Math.round((Date.now() - r.createdAt.getTime()) / 1000);
    await withRequestId(r.requestId, async () => {
      // Without a queue (local dev) the task runs here, as the webhook would have run it.
      if (!tasksConfigured()) {
        const result = await runEncodeTask(r.messageSid, { retryWindowMs: 0, traceId: null });
        log.info("health_check.ran", { sid: r.messageSid, result, age_s });
        return;
      }
      try {
        const result = await enqueueEncode(r.messageSid);
        await markQueued(r.id);
        enqueued++;
        log.warn("health_check.enqueued", { sid: r.messageSid, enqueued: result, age_s });
      } catch (e) {
        log.error("health_check.enqueue_failed", { sid: r.messageSid, age_s, err: e });
      }
    });
  }

  const counts = { overdue: overdue.length, enqueued, pending: await countPending() };
  log.info("health_check.heartbeat", counts);
  return counts;
}

// POST /health-check: one run, called by Cloud Scheduler. Public like /encode: the run does
// only what the next run would do anyway. A failure is a 500 with no heartbeat, which is what
// the heartbeat alert is for.
export async function healthCheckRoute(c: Context) {
  try {
    const counts = await runHealthCheck({ deadlineMs: HEALTH_CHECK_DEADLINE_MS, graceMs: HEALTH_CHECK_GRACE_MS });
    return c.json(counts, 200);
  } catch (e) {
    log.error("health_check.failed", { err: e });
    return c.text("Check failed", 500);
  }
}
