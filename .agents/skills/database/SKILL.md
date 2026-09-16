---
name: database
description: Read the going.blue Postgres database through a read-only role
---

The gateway keeps one Postgres database on Cloud SQL. The schema is defined in `migrate()` in `packages/server/src/db.ts` and has four tables:
1. `accounts`: one row per app account. `token` is the primary key, `id` is a surrogate number, `created_at` is when the app minted it. A token maps to no name, number, or address anywhere.
2. `requests`: one row per inbound message on every route, written when the message arrives and updated as it is answered. This is the table almost every question is about.
3. `replies`: one row per outbound message of a reply on the messaging routes, with the SID Twilio assigned on send, its segment count, and how the send ended.
4. `stats_hidden_accounts`: the operator's own accounts, which the `/stats` dashboard leaves out of every count.

No phone number is stored in any form. The sender's number and the message text live only at Twilio. The join to the service logs is `requests.request_id`, the same value the gateway and codec log lines carry as `request_id`. `requests.message_sid` is the inbound Twilio SID and `replies.sid` the reply's, so a Twilio message and its row match by SID. Rows written before September 15, 2026 have neither and match by time.

## The requests table

Identity and timing:
 - `request_id`: the gateway's id for the message. Null on rows written before the id existed.
 - `account_id`: the account as a number. `token` is the same account as its token, and is null when the request carried no valid token. Refer to accounts by `account_id`. Never print a token: it is the credential that lets anyone request forecasts as that account.
 - `created_at`: when the message arrived. On rows written before September 15, 2026 it is the end of handling, a few seconds later. `timestamptz`, so render it in UTC to match the logs and Twilio, and in `America/Los_Angeles` to match the dashboard's days (`DAY_TZ` in db.ts).
 - `version`: the protocol version the request named. Per-version counts are the sunset metric for frozen codec containers.

How it ended:
 - `outcome`: `ok`, or one of `unknown_token`, `missing_version`, `unsupported_version`, `malformed`, `stale`, `future`, `unavailable` (the dispatch result kinds in `packages/server/src/dispatch.ts`), or `rejected` for a message SID that Twilio did not know or that was not an inbound message to the service number. Rows written before the column existed are all successes: read a null as `ok`.
 - `codec_ms`: the gateway's wall clock around the whole codec call. Null when no codec was called.

What was asked for, as the codec reported it. All null on failures, and missing on rows from older versions (see Version changes below):
 - `lat`, `lon`: rounded to 0.01 degrees, about 1 km. `loc` is the named location, or `current`.
 - `mode`: `detail`, `auto`, or `range`. `model`: the first served model's name.
 - `vars`: the variable names served, as in `VAR` in `packages/protocol/src/constants.ts`.
 - `device`: the route, `i` iPhone satellite, `s` SMS, `z` ZOLEO, `g` inReach, `d` internet. `platform`: `i` iOS or `a` Android.
 - `messages`: how many messages the request asked for. `max_chars`: the reply budget that implied, null on the internet route.

What the reply carried and cost:
 - `chars`: the encoded reply's length.
 - `periods`: JSON mapping hours per period to how many periods of that resolution the reply held. The sum is the total period count, the quality the reader saw.
 - `fetch_ms` (Open-Meteo) and `encode_ms` (the fill search) are the codec's own components. `codec_ms` minus their sum is container overhead.

How far delivery got, on the messaging routes:
 - `message_sid`: the inbound Twilio message's SID. Null on the internet route and on rows written before September 15, 2026.
 - `state`: `received`, `queued` (the encode task is on Cloud Tasks), `encoded` (the codec answered and the reply rows exist), `sent` (every reply row has a Twilio SID), `failed` (Twilio refused a reply at send time, or the health check found the request still unanswered 15 minutes after its task was queued), or `no_reply` (stale, future, or rejected: nothing was owed). Internet requests and backfilled rows are `sent`. Derived from `queued_at`, `encoded_at`, `sent_at`, `failed_at`, and `no_reply_at`, so the gap between two of those is the time that step took.
 - `twilio_received_at`: Twilio's own timestamp for the inbound message.
 - `attempts`: how many times the encode task ran. More than one means a retry happened; the logs under the row's `request_id` say why.

## The replies table

One row per outbound message, joined to its request by `request_id` (the row id, not the UUID):
 - `part`: the message's position in the reply, from 1.
 - `status`: `pending`, `sending` (claimed by a task run whose send outcome was never recorded), `sent` (Twilio accepted it), `delivered` (the carrier confirmed delivery; for a satellite messenger that is the carrier gateway's receipt, not the device's), `undelivered` (the carrier reported failure), or `failed` (Twilio refused the send, or reported failure after accepting it).
 - `sid`: the Twilio SID of the sent message. `segments` is the billable segment count Twilio reported.
 - `sent_at`, `delivered_at`, `undelivered_at`, `failed_at`: when each happened. The last three come from Twilio's delivery events and are written once, on the first event to arrive. `delivered_at` minus `sent_at` is the carrier's time.
 - `error_code`: Twilio's error code when the send was refused or the carrier reported failure. The Error Dictionary entry is at `https://www.twilio.com/docs/api/errors/<error_code>`.
 - `body`: the message text. Do not select it; the request shape is in the request row.

Delivery outcomes by route over the last 30 days:

```sql
select q.device, r.status, count(*)
  from replies r join requests q on q.id = r.request_id
 where r.created_at > now() - interval '30 days'
 group by 1, 2 order by 1, 2 limit 30;
```

## Connecting

Reads use a Postgres role that can only `SELECT`. The connection details live in `deploy.env` at the root of the repository. Never hardcode them and never fetch them from anywhere else. Source the file before each command. The expansions stop the command with a message if a value is missing:

```bash
source deploy.env
: "${PROJECT:?set in deploy.env}" "${REGION:?set in deploy.env}" "${SQL_INSTANCE:?set in deploy.env}" "${DB_NAME:?set in deploy.env}"
: "${DB_READ_USER:?set in deploy.env}" "${DB_READ_PASS:?set in deploy.env}"
```

If that fails, tell the user which variable is missing and stop. Do not look for the value elsewhere.

The instance is reached through the Cloud SQL Auth Proxy, which uses the workstation's gcloud application default credentials. Port 5432 belongs to the local Docker Postgres, so the proxy listens on 5433. Start it once in the background and leave it running:

```bash
cloud-sql-proxy "$PROJECT:$REGION:$SQL_INSTANCE" --port 5433 &
```

Check that it is up with `lsof -nP -i :5433` before the first query. Queries run through `psql`, which is at `/opt/homebrew/opt/libpq/bin/psql`:

```bash
PGPASSWORD="$DB_READ_PASS" /opt/homebrew/opt/libpq/bin/psql \
  "host=127.0.0.1 port=5433 user=$DB_READ_USER dbname=$DB_NAME" -X -c "<query>"
```

Rules:
 - Only `SELECT`. The role cannot write, but do not try.
 - Always end a row-returning query with `LIMIT`.
 - Never select `token` from any table.
 - To match the dashboard's numbers, exclude hidden accounts with `account_id not in (select account_id from stats_hidden_accounts)` and bucket days in `America/Los_Angeles`.

## Version changes

Every query filters on the current protocol version, `version = 4`. The current version is the highest `CODEC_URL_V<N>` in `deploy.sh`. When a new version ships, update the filter in every query here and extend the list below.

Each codec version is a frozen container, and older containers report fewer fields to the gateway, so rows from older versions have columns that newer rows fill:
 - Version 1: none of the shape or reply columns. Only `token`, `account_id`, `created_at`, `chars`, `version`, and `outcome`.
 - Versions 2 and 3: the shape columns (`lat`, `lon`, `loc`, `mode`, `model`, `vars`, `max_chars`, `messages`) and `device` on some rows, since the header grew during those versions. No `request_id`.
 - Version 4: everything, including `request_id`, `periods`, `fetch_ms`, and `encode_ms`. `platform` is present only when the client sent it, which the app started doing partway through version 4.
 - A null `version` is a request that named no version.

Grouping older rows by a column they lack yields a null group, which is why the filter is on every query. The per-version count below is the one exception.

## Queries

One request by id, as the logs name it:

```sql
select created_at at time zone 'UTC' as utc, version, outcome, device, platform, mode, model, vars,
       messages, max_chars, chars, periods, codec_ms, fetch_ms, encode_ms, account_id
  from requests where request_id = '<UUID>' and version = 4 limit 1;
```

One message by its Twilio SID, with its replies:

```sql
select q.state, q.outcome, q.attempts, q.created_at at time zone 'UTC' as utc,
       q.sent_at - q.created_at as to_sent, r.part, r.status, r.sid, r.segments, r.error_code
  from requests q left join replies r on r.request_id = q.id
 where q.message_sid = '<SID>' order by r.part limit 10;
```

Messaging requests that have not reached a terminal state, oldest first:

```sql
select message_sid, state, attempts, created_at at time zone 'UTC' as utc
  from requests
 where message_sid is not null and state not in ('sent', 'failed', 'no_reply')
 order by created_at limit 20;
```

Requests in a time window, to match a log line:

```sql
select request_id, created_at at time zone 'UTC' as utc, outcome, device, chars, codec_ms
  from requests
 where created_at between '2026-09-12T13:07:00Z' and '2026-09-12T13:08:00Z' and version = 4
 order by created_at limit 20;
```

Failures in the last 7 days:

```sql
select coalesce(outcome, 'ok') as outcome, count(*)
  from requests
 where created_at > now() - interval '7 days' and version = 4
 group by 1 order by 2 desc limit 20;
```

Requests per day, as the dashboard counts them:

```sql
select (created_at at time zone 'America/Los_Angeles')::date as day, count(*), count(distinct account_id) as accounts
  from requests
 where created_at > now() - interval '14 days' and version = 4
   and account_id not in (select account_id from stats_hidden_accounts)
 group by 1 order by 1 desc limit 14;
```

Codec latency by route over the last 7 days:

```sql
select device, count(*),
       percentile_cont(0.5) within group (order by codec_ms) as p50_ms,
       percentile_cont(0.9) within group (order by codec_ms) as p90_ms,
       percentile_cont(0.5) within group (order by fetch_ms) as fetch_p50_ms
  from requests
 where created_at > now() - interval '7 days' and outcome = 'ok' and version = 4
 group by 1 order by 2 desc limit 10;
```

Requests per protocol version over the last 30 days. This is the one query that spans versions, since that is its question:

```sql
select version, count(*), max(created_at) at time zone 'UTC' as last_seen
  from requests
 where created_at > now() - interval '30 days'
 group by 1 order by 1 limit 10;
```

One account's recent requests:

```sql
select created_at at time zone 'UTC' as utc, outcome, device, loc, mode, model, vars, chars
  from requests where account_id = <id> and version = 4
 order by created_at desc limit 20;
```

## One-time setup

1. Install `psql` with `brew install libpq`. It is keg-only, so the commands above use its full path.
2. Create the read-only role. Connect through the proxy as `postgres` and run:
3. Add `DB_READ_USER` and `DB_READ_PASS` to `deploy.env`. The file is gitignored.
