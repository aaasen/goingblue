import type pg from "pg";
import { getPool, query } from "./db.js";
import type { RequestShape } from "./dispatch.js";

// The delivery store: the `requests` row of a messaging request and its `replies`, read and
// advanced by the encode task (encode-task.ts). Every write here is guarded so a second run of
// the same task, concurrent or later, finds the step already taken and moves on; that is what
// makes the task safe to retry and to deliver more than once.

export interface DeliveryRequest {
  id: string;
  requestId: string;
  messageSid: string;
  createdAt: Date;
  queuedAt: Date | null;
  encodedAt: Date | null;
  sentAt: Date | null;
  failedAt: Date | null;
  noReplyAt: Date | null;
  attempts: number;
  replies: Reply[];
}

export interface Reply {
  id: string;
  part: number;
  body: string;
  sid: string | null;
  sendingAt: Date | null;
  sentAt: Date | null;
  failedAt: Date | null;
}

// What the encode step writes to the request row.
export interface EncodedRecord {
  token: string | null;
  chars: number | null;
  version: number | null;
  outcome: string;
  codecMs: number | null;
  shape: RequestShape | null;
  twilioReceivedAt: Date | null;
  // One entry per outbound message, in order. Empty when nothing is owed, which marks the request
  // `no_reply` rather than `encoded`.
  replies: string[];
}

interface RequestRow {
  id: string;
  request_id: string;
  message_sid: string;
  created_at: Date;
  queued_at: Date | null;
  encoded_at: Date | null;
  sent_at: Date | null;
  failed_at: Date | null;
  no_reply_at: Date | null;
  attempts: number;
}

interface ReplyRow {
  id: string;
  part: number;
  body: string;
  sid: string | null;
  sending_at: Date | null;
  sent_at: Date | null;
  failed_at: Date | null;
}

const REQUEST_COLUMNS = `id, request_id, message_sid, created_at, queued_at, encoded_at, sent_at,
                         failed_at, no_reply_at, attempts`;

// Record an inbound message on arrival. A SID already recorded keeps its row (and its request
// id) untouched, so a redelivered webhook or event is the same request. Returns the row's ids.
export async function receiveMessage(r: {
  requestId: string;
  messageSid: string;
  twilioReceivedAt: Date | null;
}): Promise<{ id: string; requestId: string }> {
  await query(
    `insert into requests (request_id, message_sid, twilio_received_at)
     values ($1, $2, $3)
     on conflict (message_sid) do nothing`,
    [r.requestId, r.messageSid, r.twilioReceivedAt],
  );
  const row = (await query<{ id: string; request_id: string }>(
    "select id, request_id from requests where message_sid = $1", [r.messageSid],
  )).rows[0]!;
  return { id: row.id, requestId: row.request_id };
}

export async function loadDelivery(messageSid: string): Promise<DeliveryRequest | null> {
  const row = (await query<RequestRow>(
    `select ${REQUEST_COLUMNS} from requests where message_sid = $1`, [messageSid],
  )).rows[0];
  if (!row) return null;
  const replies = (await query<ReplyRow>(
    `select id, part, body, sid, sending_at, sent_at, failed_at
       from replies where request_id = $1 order by part`, [row.id],
  )).rows;
  return {
    id: row.id,
    requestId: row.request_id,
    messageSid: row.message_sid,
    createdAt: row.created_at,
    queuedAt: row.queued_at,
    encodedAt: row.encoded_at,
    sentAt: row.sent_at,
    failedAt: row.failed_at,
    noReplyAt: row.no_reply_at,
    attempts: row.attempts,
    replies: replies.map((p) => ({
      id: p.id, part: p.part, body: p.body, sid: p.sid,
      sendingAt: p.sending_at, sentAt: p.sent_at, failedAt: p.failed_at,
    })),
  };
}

export async function countAttempt(id: string): Promise<void> {
  await query("update requests set attempts = attempts + 1 where id = $1", [id]);
}

async function transaction<T>(fn: (client: pg.PoolClient) => Promise<T>): Promise<T> {
  const client = await getPool().connect();
  try {
    await client.query("begin");
    const out = await fn(client);
    await client.query("commit");
    return out;
  } catch (e) {
    await client.query("rollback").catch(() => {});
    throw e;
  } finally {
    client.release();
  }
}

// Write the outcome and shape of the encode step and create its reply rows, in one transaction.
// Returns false, writing nothing, when another run encoded the request first.
export async function recordEncoded(id: string, r: EncodedRecord): Promise<boolean> {
  return transaction(async (client) => {
    const account = r.token
      ? (await client.query<{ id: string }>("select id from accounts where token = $1", [r.token])).rows[0]
      : undefined;
    const s = r.shape;
    const updated = await client.query(
      `update requests
          set token = $2, account_id = $3, chars = $4, version = $5, outcome = $6, codec_ms = $7,
              lat = $8, lon = $9, loc = $10, mode = $11, model = $12, vars = $13, max_chars = $14,
              messages = $15, device = $16, platform = $17, periods = $18, fetch_ms = $19,
              encode_ms = $20,
              twilio_received_at = coalesce(twilio_received_at, $21),
              encoded_at = now(),
              no_reply_at = case when $22 then now() else no_reply_at end
        where id = $1 and encoded_at is null`,
      [id, account ? r.token : null, account?.id ?? null, r.chars, r.version, r.outcome, r.codecMs,
       s?.lat ?? null, s?.lon ?? null, s?.loc ?? null, s?.mode ?? null, s?.model ?? null,
       s?.vars ?? null, s?.maxChars ?? null, s?.messages ?? null, s?.device ?? null,
       s?.platform ?? null, s?.periods ?? null, s?.fetchMs ?? null, s?.encodeMs ?? null,
       r.twilioReceivedAt, r.replies.length === 0],
    );
    if ((updated.rowCount ?? 0) === 0) return false;
    for (const [i, body] of r.replies.entries()) {
      await client.query(
        "insert into replies (request_id, part, body) values ($1, $2, $3)", [id, i + 1, body],
      );
    }
    return true;
  });
}

// The message failed validation at Twilio (unknown SID, not inbound, not sent to us): nothing is
// owed and nothing is encoded.
export async function recordRejected(id: string): Promise<void> {
  await query(
    `update requests set outcome = 'rejected', no_reply_at = now()
      where id = $1 and encoded_at is null and no_reply_at is null`, [id],
  );
}

// Take the claim on a reply part before sending it. False when it was already claimed.
export async function claimReply(replyId: string): Promise<boolean> {
  const r = await query(
    "update replies set sending_at = now() where id = $1 and sending_at is null", [replyId],
  );
  return (r.rowCount ?? 0) > 0;
}

// Give the claim back after a send that is known not to have created a message.
export async function releaseReply(replyId: string): Promise<void> {
  await query("update replies set sending_at = null where id = $1 and sid is null", [replyId]);
}

export async function recordReplySent(replyId: string, sid: string, segments: number | null): Promise<void> {
  await query(
    "update replies set sid = $2, segments = $3, sent_at = now() where id = $1", [replyId, sid, segments],
  );
}

// A terminal send error on one part fails the whole request.
export async function recordReplyFailed(id: string, replyId: string, errorCode: number | null): Promise<void> {
  await transaction(async (client) => {
    await client.query(
      "update replies set error_code = $2, failed_at = now() where id = $1", [replyId, errorCode],
    );
    await client.query("update requests set failed_at = now() where id = $1 and failed_at is null", [id]);
  });
}

export async function recordRequestSent(id: string): Promise<void> {
  await query("update requests set sent_at = now() where id = $1 and sent_at is null", [id]);
}
