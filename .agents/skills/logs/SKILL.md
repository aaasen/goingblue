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

Every log line of a single request, in order, using the trace from any one of its entries:

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

## When reading

 - Check which revision served the lines you are reading (`resource.labels.revision_name`) before
   concluding anything about current behavior. A deployed revision can be many commits behind
   `main`; compare against `gcloud run revisions list --service "$SERVICE" --project "$PROJECT"
   --region "$REGION"`.
 - Log payloads can contain user data from older revisions. Do not copy phone numbers or request
   text into files, commits, or the conversation. Report what happened, not who.
 - An event that is absent may simply not exist. `grep -rn 'log\.\(info\|error\|debug\)('
   packages/server/src` lists every event the current code can emit.
