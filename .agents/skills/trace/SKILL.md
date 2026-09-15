---
name: trace
description: Trace one forecast request through Twilio, the gateway, the queue, the codec, and the database
---

A forecast request crosses up to five systems, and each one records a different part of what happened. This skill walks one request through all of them, assembles one timeline, and says where it stopped. The commands for each source are in the `twilio`, `logs`, and `database` skills. Read all three before starting.

Every source keeps 30 days. A request older than that cannot be traced.

## The path

Every messaging route (SMS, inReach, ZOLEO, iPhone satellite) arrives as a text to the service number, so it passes through Twilio. The internet route posts to `/forecast` directly, never touches Twilio or the queue, and is served inside that one request.

On the messaging routes, receipt only records the message and enqueues it. The work happens later, in an encode task that Cloud Tasks posts back to the gateway, and the task may run more than once. Twilio delivers each inbound message twice: as the `/sms` webhook, and as an Event Streams event to `/twilio-sink`, which Twilio retries for up to four hours until it gets a 2xx. Whichever arrives first records the row and enqueues; the other finds the row already queued. In order, with the source that records each hop:
1. Twilio: the inbound message. `sid`, `date_created`, `status` `received`.
2. Gateway request log: `POST /sms` and, usually a few seconds later, `POST /twilio-sink`, each with status and latency and its own trace.
3. Gateway app logs `sms.inbound` or `sink.inbound`, with the Twilio `sid`, then `message.queued`. The first lines with the `request_id`. The sink reads the message back from Twilio before writing anything, so `sink.rejected` here means the event named a SID that is not an inbound message to the service number, and no row exists.
4. Database: the `requests` row, written at hop 3 with `message_sid` and advanced at every later hop. Its `state` says how far the message got, and `attempts` how many times the task ran.
5. Cloud Tasks: the task, named by the SID on the `encode` queue. Visible only while it is waiting or retrying; a finished task is gone.
6. Gateway request log: `POST /encode?sid=<SID>` from `Google-Cloud-Tasks`, one per attempt, each with its own trace. 200 cleared the task, 503 asked for it back.
7. Gateway app log `encode.start` with `sid` and `attempt`. Before it the gateway read the inbound message back from Twilio; `encode.rejected` here means Twilio did not know the SID or it was not an inbound message to the service number.
8. Codec request log: `POST /encode` on `goingblue-codec-v<N>`, with status and latency. Same trace as hop 6 for that attempt.
9. Codec app log `encode.request` with the parsed request. Its delay after the codec request log started is the container's startup time.
10. Codec app logs `openmeteo.request`, one per upstream call. One for the served model, plus one per other center when model agreement is on.
11. Gateway app log `forecast.dispatch` with `kind` and, when `ok`, `chars`. The codec logs nothing on success, so this line is the codec's completion signal. The row becomes `encoded` and its `replies` rows exist.
12. Gateway app logs `reply.sent`, one per part, with `reply_sid` and `segments`, then `encode.sent`. The row becomes `sent`.
13. Twilio: the reply, `direction` `outbound-api`, one message per reply row, with delivery `status`. Twilio also posts the outcome to `/twilio-sink` as a `message.delivered`, `message.undelivered`, or `message.failed` event, logged as `sink.delivery` with the reply's SID and written onto the reply row, so the row's `status` normally already says how delivery ended.

Keys:
 - `request_id` joins hops 3 through 12, across every attempt: every app log line on both services and the database row. The task runs under the row's id, so a retry continues the same sequence.
 - A trace joins one HTTP request into the gateway and what it caused: the webhook and the sink delivery have one each (hops 2 and 3), and each task attempt has its own (hops 6 through 12 for that attempt, including the codec's request log). The request logs carry the trace and not the `request_id`. The two receipts mint separate `request_id`s, but only the first one's is stored on the row and used by the task; the second's appears only on its own `sink.inbound` or `sms.inbound` line.
 - The Twilio `sid` joins hop 1 to the row (`message_sid`), to the task's name, to the `/encode` request URL, to the `sid` field on every `sms.*`, `sink.*`, `message.*`, `encode.*`, and `reply.*` line, and to any alert (`resource_sid`).
 - `replies.sid` joins each reply row to its Twilio message at hop 13, and to the `sink.delivery` line for its outcome. A `sink.unknown_reply` line is a delivery event for a message that is not one of the gateway's replies, or one whose row had not yet recorded its SID; Twilio retries it.

## Starting points

Find the `request_id` first. Where it comes from depends on what the question gives:
 - A `request_id`, from the stats page or a log line: start at the procedure below.
 - A Twilio message SID, from the console, an alert, or a task: the `database` skill's one-message query gives the row's `request_id` and `state` at once. The `sms.inbound` line with that `sid` has it too.
 - A user report with a time ("I texted at 3pm and got nothing"): list inbound messages to the service number on that day with the `twilio` skill and match by time. Then as above. The sender's number stays inside the shell and is never printed.
 - A time alone: the `database` skill's time-window query lists the rows, each with its `request_id`.
 - No specific message, just "is anything stuck": the `database` skill's non-terminal query lists messaging rows that have not reached `sent`, `failed`, or `no_reply`.
 - An internet-route request: no Twilio hop and no queue. Start from the database row or the gateway's `/forecast` request log.

## Procedure

1. Pull every app log line for the `request_id` on both services, sorted by time. This is hops 3, 7, 9, 10, 11, and 12, for every attempt:

```bash
source deploy.env
gcloud logging read 'jsonPayload.request_id="<UUID>"' \
  --project "$PROJECT" --limit 100 --freshness 30d \
  --format 'value(timestamp,resource.labels.service_name,jsonPayload.event,jsonPayload.attempt,jsonPayload.kind,jsonPayload.part,jsonPayload.reply_sid,jsonPayload.chars,jsonPayload.status,jsonPayload.err,trace)'
```

2. The last column holds one trace per receipt (webhook, sink) and one per task attempt. Pull the request logs for each. This is hops 2, 6, and 8, with status and latency:

```bash
gcloud logging read "log_id(\"run.googleapis.com/requests\") AND trace=\"projects/$PROJECT/traces/<TRACE_ID>\"" \
  --project "$PROJECT" --limit 10 --freshness 30d \
  --format 'value(timestamp,resource.labels.service_name,httpRequest.status,httpRequest.requestUrl,httpRequest.latency)'
```

   The gateway's `/encode` attempts can also be listed together by SID, without the traces:

```bash
gcloud logging read "log_id(\"run.googleapis.com/requests\") AND httpRequest.requestUrl:\"<SID>\"" \
  --project "$PROJECT" --limit 20 --freshness 30d \
  --format 'value(timestamp,httpRequest.status,httpRequest.latency)'
```

3. Read the row and its reply rows with the `database` skill's one-message-by-SID query. This is hops 4, 11, and 12 as the database saw them: `state`, `attempts`, the outcome and shape, and each part's `status`, `sid`, and `error_code`.
4. If the row is not in a terminal state, look for the task. This is hop 5:

```bash
gcloud tasks describe "<SID>" --queue encode --project "$PROJECT" --location "$REGION" \
  --format 'value(scheduleTime,dispatchCount,responseCount,lastAttempt.responseStatus.code,lastAttempt.dispatchTime)'
```

   A task that exists is waiting for its `scheduleTime`; `dispatchCount` and the last attempt's status say how the earlier attempts went. A not-found error that says a task with this name existed recently means the task finished, either by a 200 or by the queue giving up after its retry limit, ten minutes; a plain not-found means it was never created.
5. Fetch the Twilio inbound by the `sid`, then any alerts with the inbound `sid` as `resource_sid`. This is hop 1. The reply rows from step 3 already carry hop 13; fetch a reply at Twilio by its `sid` only when its row is still `sent`, or when the `error_message` behind an `error_code` is needed.
6. Lay the hops out in time order and read the timeline against the table below.

## Reading the timeline

Each row is where the trail ends and what that means:

| Last thing seen | Meaning | Where to look next |
|---|---|---|
| Twilio inbound only, no gateway request log for `/sms` or `/twilio-sink` | Twilio could not reach the gateway by either path | Twilio alerts: `11200` timeout or 5xx, `11205` connection failed. The sink keeps retrying for four hours, so check again later |
| `/sms` missing or failed, `/twilio-sink` 200 and `sink.inbound` | The webhook was missed and the event sink carried the message | Nothing for this message; the webhook failure itself, if it repeats |
| Gateway request log 403, `sms.invalid_signature` | The signature check failed, usually a webhook URL mismatch | `TWILIO_WEBHOOK_URL` against the URL in the Twilio console |
| `sms.inbound` or `sink.inbound`, `message.receive_failed`, request log 503 | The row could not be written; nothing downstream can run without it | The `err` field; database health. Twilio retries the webhook once and the event for hours |
| `message.enqueue_failed`, request log 503, row `received` | Cloud Tasks refused the task | The `err` field: an HTTP status from the Tasks API. 403 is the service account's enqueuer role, 404 the queue, 429 or 5xx Cloud Tasks itself. Twilio retries the webhook once and the event for hours |
| `sink.rejected`, request log 404, no row | The event named a SID Twilio does not know, or a message not inbound to the service number | The message at Twilio by SID; a rejection of a real inbound message is a bug |
| `message.queued`, row `queued`, no `encode.start` | The task never ran, or has not yet | `gcloud tasks describe` as in step 4: waiting, or gone |
| `encode.start`, then `twilio.fetch_failed` or `twilio.fetch_unreachable`, attempt 503 | The gateway could not read the inbound message back from Twilio | Twilio API status; the queue retries the attempt |
| `encode.rejected`, row `no_reply` with outcome `rejected` | Twilio did not know the SID, or it was not an inbound message to the service number | The message at Twilio by SID; a `rejected` on a real message is a bug |
| `forecast.dispatch` with `kind` `unknown_token`, no codec lines | The account check rejected the token before dispatch. The malformed reply was sent | The row has outcome `unknown_token`; the account was deleted or never existed |
| `codec.unreachable` or `codec.error_response` 503, then `encode.retry`, attempt 503 | The codec did not answer or failed while serving, and the attempt is inside the five minute retry window | `encode.failed` on the codec and its `openmeteo.request` lines; the next attempt's lines under the same `request_id` |
| `encode.gave_up` | The codec was still failing after five minutes; the unavailable reply was sent instead | What was failing across the attempts; the reply row and its Twilio message |
| `codec.error_response` with status 400 | The codec rejected the request as malformed; `body` says why. The malformed reply was sent | The request text at Twilio, by SID, if the reason needs it |
| `codec.error_response` with status 422, row `no_reply` | Start time off the servable axis: `stale` (delivery delay) or `future` (wrong clock). Nothing was sent | Twilio timestamps against the request's `t:` token |
| `encode.raced` | A second run of the task found the request already encoded; the earlier run's replies are used | Nothing: harmless, expected when a webhook retry and a task attempt overlap |
| `forecast.dispatch` `ok`, `twilio.send_failed` or `twilio.send_unreachable`, attempt 503 | Twilio would not accept the reply (429 or 5xx); the part went back to `pending` and the attempt is retried | Twilio API status; the next attempt's `reply.sent` |
| `reply.failed` with `code`, row `failed` | Twilio refused the reply for this recipient at send time; later parts were not sent | The Error Dictionary for the code. `21610` is a STOP from the recipient |
| Row `encoded` with a reply `sending` and no `sid`, no newer attempt lines | A task run died between claiming the part and recording the send. The part is not retried, so it cannot be sent twice | Messages to the recipient at Twilio around that time: the send may or may not have gone out |
| `encode.sent`, reply row `undelivered` or `failed` with an `error_code` | The carrier refused it after Twilio accepted it | The Error Dictionary for the code; Twilio's `error_message` on the reply SID |
| `encode.sent`, reply row still `sent` well after the fact | No delivery event arrived: the carrier has not reported, or the event was missed | The reply at Twilio by SID; `delivered` there with no `sink.delivery` line means the sink missed it |
| Row not terminal, no task, no recent attempt lines | The queue gave up after its retry limit, or the task was never created | The attempts' lines for what kept failing; the database skill's non-terminal query for others like it |
| Everything `ok` and every reply row `delivered` | The system served it. For a satellite messenger, `delivered` is the carrier gateway's receipt, not the device's | The reply's segment count against the route's expectations |

Timing, from the database row and the request logs:
 - `created_at` to `queued_at` is the webhook's own time, and matches the `/sms` request log's latency.
 - `queued_at` to `encode.start` is the queue's dispatch delay, normally well under a second.
 - `codec_ms` less `fetch_ms` plus `encode_ms` is container overhead. Over a second means the codec container started cold, which the gap between hop 8 and hop 9 shows directly.
 - The `/encode` request log's latency less `codec_ms` is the gateway's own time in the attempt: the Twilio lookup, the row writes, and one Twilio send per part.
 - `fetch_ms` is Open-Meteo's time, the usual majority of a request.

## Report

Lead with the verdict: which hop the request stopped at, or that it was served. Then the timeline, one line per hop in UTC with its source, with each task attempt as its own group when there was more than one. Then the evidence: `request_id`, trace ids, Twilio SIDs, `state` and `attempts`, statuses, error codes, and the timing split.

Never write a phone number, a message body, or an account token. The codec's `encode.request` line carries the token in its `userToken` field, and the database row carries it in `token`. Leave both out.
