import { QUOTA_FREE_FORECASTS } from "@weather/protocol";
import { query } from "./db.js";

// Free weather forecasts over the messaging routes, per account and UTC calendar month. The
// internet route and avalanche forecasts are never limited.
//
// The stated quota is QUOTA_SOFT, the one the app shows and the reply header counts down. Past
// it a forecast is still answered, with the header saying the quota is used up, until the hard
// limit: QUOTA_HARD, or QUOTA_SOFT in the month after one in which the account exceeded
// QUOTA_SOFT. Only the previous month matters. At the hard limit the request gets the cut-off
// reply once, then nothing, since even an error reply costs a message. The hard limit is never
// shown to the reader.
//
// Enforcement starts with protocol version QUOTA_MIN_VERSION, the first whose reply header
// carries the quota. Older containers are frozen and would cut a reader off without warning.
export const QUOTA_SOFT = QUOTA_FREE_FORECASTS;
export const QUOTA_HARD = 10;
export const QUOTA_MIN_VERSION = 7;

export interface QuotaStatus {
  // Weather forecasts served to the account over the messaging routes this month, before this
  // request.
  served: number;
  // Where this month's answers stop.
  hard: number;
  // Whether the cut-off reply has already been sent this month.
  notified: boolean;
}

// The first instant of the UTC month `months` after the one containing `now`.
export function monthStartUtc(now: Date, months = 0): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + months, 1));
}

export function hardLimit(prevMonthServed: number): number {
  return prevMonthServed > QUOTA_SOFT ? QUOTA_SOFT : QUOTA_HARD;
}

// The account's standing this month, from the requests table. Rows are counted by account id,
// which survives the token being cleared on deletion, over the messaging routes only
// (`message_sid` is set on exactly those rows).
export async function quotaStatus(token: string, now = new Date()): Promise<QuotaStatus> {
  const thisMonth = monthStartUtc(now);
  const lastMonth = monthStartUtc(now, -1);
  const { rows } = await query<{ served: string; prev: string; notified: string }>(
    `select count(*) filter (where r.created_at >= $2 and coalesce(r.outcome, 'ok') = 'ok') as served,
            count(*) filter (where r.created_at < $2 and coalesce(r.outcome, 'ok') = 'ok') as prev,
            count(*) filter (where r.created_at >= $2 and r.outcome = 'quota_exceeded') as notified
       from requests r join accounts a on a.id = r.account_id
      where a.token = $1 and r.message_sid is not null and r.kind = 'weather' and r.created_at >= $3`,
    [token, thisMonth, lastMonth],
  );
  const row = rows[0]!;
  return { served: Number(row.served), hard: hardLimit(Number(row.prev)), notified: Number(row.notified) > 0 };
}

// Whether this request is past the hard limit.
export function overHard(status: QuotaStatus): boolean {
  return status.served >= status.hard;
}

// The `X-Quota` header for the codec: the quota as the reply should report it if this request
// is a weather forecast and gets served (codec-server/src/quota.ts). The codec ignores it for
// an avalanche reply.
export function quotaHeader(status: QuotaStatus): string {
  const after = status.served + 1;
  return after <= QUOTA_SOFT ? `free:${QUOTA_SOFT - after}` : "over";
}

// The one reply a request past the hard limit gets. Must fit a single GSM-7 segment.
export function quotaExceededReply(resetsAt: Date): string {
  const month = resetsAt.toLocaleString("en-US", { month: "long", timeZone: "UTC" });
  return `Free weather forecast limit exceeded. Limit resets ${month} 1. ` +
    "Going Blue will stop responding until then. Subscribe for unlimited forecasts.";
}
