---
name: logs
description: Read Cloud Run logs for the going.blue gateway and codec services on Google Cloud
---

The deployment target lives in `deploy.env` at the repo root, the same file `deploy.sh` reads.
Never hardcode the project, region, or service name; source them:

```bash
source deploy.env; SERVICE="${SERVICE:-$PROJECT}"
```

Each Bash call is a fresh shell, so repeat that prefix in every command below.

`$SERVICE` is the gateway. Each frozen protocol version runs as its own service,
`$SERVICE-codec-v<N>` (see `deploy-codec.sh`).

Each service writes two separate streams:

 - **App logs**: one line of JSON per event from `packages/server/src/log.ts`, in
   `logName:"stdout"` (`stderr` when severity is ERROR). Every field is queryable as
   `jsonPayload.<field>`; `jsonPayload.event` is the event name, `subject.verb`.
 - **Request logs**: one entry per HTTP request in `logName:"requests"`, with `httpRequest`
   and no `jsonPayload`. These carry scanner traffic and are usually noise.

## Reading

Prefer `gcloud logging read`, which can filter on app fields. Always pass `--freshness` (it
defaults to one day) and `--limit`.

Recent app events:

```bash
source deploy.env; SERVICE="${SERVICE:-$PROJECT}"
gcloud logging read \
  "resource.labels.service_name=\"$SERVICE\" AND logName:\"stdout\"" \
  --project "$PROJECT" --limit 50 --freshness 1d \
  --format 'value(timestamp,severity,jsonPayload.event)'
```

Errors only, with their fields:

```bash
source deploy.env; SERVICE="${SERVICE:-$PROJECT}"
gcloud logging read \
  "resource.labels.service_name=\"$SERVICE\" AND severity>=ERROR" \
  --project "$PROJECT" --limit 20 --freshness 7d --format json
```

One event type:

```bash
source deploy.env
gcloud logging read 'jsonPayload.event="forecast.dispatch"' \
  --project "$PROJECT" --limit 20 --freshness 7d --format json
```

Every entry of a single request, in order, using the trace from any one of them. Only request
logs carry a `trace`; app logs have no trace field, so this finds the HTTP entries and nothing
from `packages/server/src/log.ts`:

```bash
source deploy.env
gcloud logging read "trace=\"projects/$PROJECT/traces/<TRACE_ID>\"" \
  --project "$PROJECT" --format json --order asc
```

A codec service: use `"$SERVICE-codec-v4"` as the `service_name`. Dropping the `service_name`
clause entirely searches the gateway and all codec services at once.

Live tail (`gcloud beta` is installed):

```bash
source deploy.env; SERVICE="${SERVICE:-$PROJECT}"
gcloud beta run services logs tail "$SERVICE" --project "$PROJECT" --region "$REGION"
```

## Following one request across services

A forecast request touches both services: the gateway takes the SMS or HTTP call, then calls
`$SERVICE-codec-v<N>` over HTTP. Nothing joins the two sides for you. App logs carry no trace at
all, each service gets its own trace for its own inbound request, and `labels.instanceId`
identifies a container rather than a request.

Correlate on **time**. The whole exchange takes a couple of seconds, so read a window around any
one event across every service at once by dropping the `service_name` clause:

```bash
source deploy.env
gcloud logging read \
  '(logName:"stdout" OR logName:"stderr")
   AND timestamp>="2026-09-04T02:15:40Z" AND timestamp<="2026-09-04T02:16:30Z"' \
  --project "$PROJECT" --limit 100 --order asc --format json
```

`--format json` keeps `resource.labels.service_name` in view, which is the only field that says
which side emitted a line. For the shape of the exchange rather than its contents, ask for the
columns instead:

```
--format 'value(timestamp,resource.labels.service_name,jsonPayload.event)'
```

A served forecast request reads:

 1. gateway `sms.inbound` — the raw request text (`v3 <coords> ... k:2 t:496754`).
 2. codec `encode.request` — the parsed request: `userToken`, `startEpochHour`, `mode`,
    `varsMask`, `device`, `maxChars`.
 3. codec `openmeteo.request` — the upstream call, including `past_days` and `forecast_days`.
 4. gateway `forecast.dispatch` — `kind`, `ok` when it was served.

A failed one inserts codec `encode.failed` (with `err` and `stack_trace`) before the gateway's
`codec.error_response` (`status`, `body`) and a `forecast.dispatch` of another `kind`. The
gateway's `codec.unreachable` means the call never landed, so no codec-side lines exist to find.

To pick the window, start from an event you already have. Errors land on both sides, so search
across all services and take the timestamp of the first hit:

```bash
source deploy.env
gcloud logging read 'jsonPayload.event="encode.failed" OR jsonPayload.event="codec.error_response"' \
  --project "$PROJECT" --limit 20 --freshness 30d \
  --format 'value(timestamp,resource.labels.service_name,jsonPayload.err,jsonPayload.status)'
```

Two fields tie entries together once you have the window:

 - `jsonPayload.version` on the gateway's `codec.error_response` and `forecast.dispatch`, and the
   `v<N>` prefix of the request text, name which codec service handled it.
 - `jsonPayload.userToken` on the codec's `encode.request` is the same value as `u:` in the
   gateway's request text. It follows one account across days without touching a phone number.
   The `k:` code increments per message the app builds, so it separates a newly built request
   from a redelivery of an old one.

## When reading

 - Check which revision served the lines you are reading (`resource.labels.revision_name`) before
   concluding anything about current behavior. A deployed revision can be many commits behind
   `main`; compare against `gcloud run revisions list --service "$SERVICE" --project "$PROJECT"
   --region "$REGION"`.
 - Log payloads can contain user data from older revisions. Do not copy phone numbers or request
   text into files, commits, or the conversation. Report what happened, not who.
 - An event that is absent may simply not exist. `grep -rn 'log\.\(info\|error\|debug\)('
   packages/server/src` lists every event the current code can emit.
