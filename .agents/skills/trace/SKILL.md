---
name: trace
description: Trace one forecast request through Twilio, the gateway, the codec, and the database
---

A forecast request crosses up to four systems, and each one records a different part of what happened. This skill walks one request through all of them, assembles one timeline, and says where it stopped. The commands for each source are in the `twilio`, `logs`, and `database` skills. Read all three before starting.

Every source keeps 30 days. A request older than that cannot be traced.

## The path

Every messaging route (SMS, inReach, ZOLEO, iPhone satellite) arrives as a text to the service number, so it passes through Twilio. The internet route posts to `/forecast` directly and never touches Twilio.

In order, with the source that records each hop:
1. Twilio: the inbound message. `sid`, `date_created`, `status` `received`.
2. Gateway request log: `POST /sms` (or `/forecast`), with status and latency. Carries the trace.
3. Gateway app log `sms.inbound` with the Twilio `sid` and the text length. The first line with the `request_id`.
4. Codec request log: `POST /encode` on `goingblue-codec-v<N>`, with status and latency. Same trace.
5. Codec app log `encode.request` with the parsed request. Its delay after the codec request log started is the container's startup time.
6. Codec app logs `openmeteo.request`, one per upstream call. One for the served model, plus one per other center when model agreement is on.
7. Gateway app log `forecast.dispatch` with `kind` and, when `ok`, `chars`. The codec logs nothing on success, so this line is the completion signal.
8. Database: the `requests` row, written after the dispatch line. Carries the request's shape, the outcome, and the timing split.
9. Twilio: the reply, `direction` `outbound-reply`, one message per part, with delivery `status`.

Keys:
 - `request_id` joins hops 3 through 8: every app log line on both services and the database row.
 - The trace joins hops 2 through 7. It is on the request logs too, which the `request_id` is not.
 - The Twilio `sid` joins hop 1 to hop 3 (`sms.inbound`'s `sid` field) and to any alert (`resource_sid`).
 - Nothing joins hop 9 to the rest. The reply is found by recipient and time, as the `twilio` skill describes.

## Starting points

Find the `request_id` first. Where it comes from depends on what the question gives:
 - A `request_id`, from the stats page or a log line: start at the procedure below.
 - A Twilio message SID, from the console or an alert: the `sms.inbound` line with that `sid` gives the `request_id`.
 - A user report with a time ("I texted at 3pm and got nothing"): list inbound messages to the service number on that day with the `twilio` skill and match by time. Then as above. The sender's number stays inside the shell and is never printed.
 - A time alone: the `database` skill's time-window query lists the rows, each with its `request_id`.
 - An internet-route request: no Twilio hop. Start from the database row or the gateway's `/forecast` request log.

## Procedure

1. Pull every app log line for the `request_id` on both services, sorted by time. This is hops 3, 5, 6, and 7:

```bash
source deploy.env
gcloud logging read 'jsonPayload.request_id="<UUID>"' \
  --project "$PROJECT" --limit 100 --freshness 30d \
  --format 'value(timestamp,resource.labels.service_name,jsonPayload.event,jsonPayload.kind,jsonPayload.chars,jsonPayload.status,jsonPayload.err,trace)'
```

2. Take the trace id from the last column of any of those lines and pull the request logs for it. This is hops 2 and 4, with status and latency:

```bash
gcloud logging read "log_id(\"run.googleapis.com/requests\") AND trace=\"projects/$PROJECT/traces/<TRACE_ID>\"" \
  --project "$PROJECT" --limit 10 --freshness 30d \
  --format 'value(timestamp,resource.labels.service_name,httpRequest.status,httpRequest.requestUrl,httpRequest.latency)'
```

3. Read the database row for the `request_id` with the `database` skill's one-request query. This is hop 8.
4. Fetch the Twilio inbound by the `sid` from the `sms.inbound` line, then its replies, then any alerts with that `sid` as `resource_sid`. This is hops 1 and 9.
5. Lay the hops out in time order and read the timeline against the table below.

## Reading the timeline

Each row is where the trail ends and what that means:

| Last thing seen | Meaning | Where to look next |
|---|---|---|
| Twilio inbound only, no gateway request log | Twilio could not reach the webhook | Twilio alerts: `11200` timeout or 5xx, `11205` connection failed |
| Gateway request log 403, `sms.invalid_signature` | The signature check failed, usually a webhook URL mismatch | `TWILIO_WEBHOOK_URL` against the URL in the Twilio console |
| `sms.inbound`, then `forecast.dispatch` with `kind` `unknown_token`, no codec lines | The account check rejected the token before dispatch | The database row has outcome `unknown_token`; the account was deleted or never existed |
| `codec.unreachable` on the gateway | The codec service did not answer | Codec service health, revision, and request logs around that time |
| `codec.error_response` with status 400 | The codec rejected the request as malformed; `body` says why | The request text at Twilio, by SID, if the reason needs it |
| `codec.error_response` with status 422 | Start time off the servable axis: `stale` (delivery delay) or `future` (wrong clock) | Twilio timestamps against the request's `t:` token |
| `codec.error_response` with status 503, `encode.failed` on the codec | The codec failed while serving; `err` names the cause, usually Open-Meteo | `openmeteo.request` lines and Open-Meteo status |
| `encode.request` present, no `forecast.dispatch` | The gateway did not finish; rare | Gateway request log status and Cloud Run instance events |
| `forecast.dispatch` `ok`, no database row | `request.record_failed`: the reply was sent, the row was not written | The `err` field on that line; the database is the only source missing this request |
| Database row `ok`, no Twilio reply | Twilio did not send the reply the gateway returned | Twilio alerts around the inbound SID: `12100` or `12300` mean bad TwiML |
| Twilio reply `undelivered` or `failed` | The carrier refused it | `error_code` and the Error Dictionary |
| Everything `ok` and `delivered` | The system served it. For a satellite messenger, `delivered` is the carrier gateway's receipt, not the device's | The reply's segment count against the route's expectations |

Timing, from the database row and the request logs:
 - `codec_ms` less `fetch_ms` plus `encode_ms` is container overhead. Over a second means the codec container started cold, which the gap between hop 4 and hop 5 shows directly.
 - The gateway request log's latency less `codec_ms` is the gateway's own time: the account lookup and the row write.
 - `fetch_ms` is Open-Meteo's time, the usual majority of a request.

## Report

Lead with the verdict: which hop the request stopped at, or that it was served. Then the timeline, one line per hop in UTC with its source. Then the evidence: `request_id`, trace id, Twilio SIDs, statuses, error codes, and the timing split.

Never write a phone number, a message body, or an account token. The codec's `encode.request` line carries the token in its `userToken` field, and the database row carries it in `token`. Leave both out.
