---
name: twilio
description: Read message and alert records from Twilio for the going.blue SMS route
---

Twilio is the SMS provider for Going Blue. The flow that a message takes is:
1. User sends a text to the forecast number from a phone or satellite messenger.
2. Twilio receives the message.
3. Twilio sends the message as a webhook to https://going.blue/sms.

Twilio's logs contain the following information:
1. Sender number.
2. Request and reply text.
3. Segment (billable unit) count. 
4. Alerts for webhook failures.

The Going Blue database intentionally does not include phone numbers or request/reply text. Twilio is the only place these are stored. Retention is set to 30 days. 

## Credentials

Twilio must only be accessed using a read-only API key. Secrets may only be sourced from `deploy.env`. If they are not present, prompt the user and stop. Never try to source them from anywhere else.

```bash
source deploy.env
TW_AUTH="${TWILIO_READ_KEY_SID:?set in deploy.env}:${TWILIO_READ_KEY_SECRET:?set in deploy.env}"
TW_MESSAGES="https://api.twilio.com/2010-04-01/Accounts/${TWILIO_ACCOUNT_SID:?set in deploy.env}/Messages"
```

## Reading messages

Always pass `PageSize`. Use `curl -G` with `--data-urlencode` so that `+` in phone numbers and `>` in date filters are encoded. Timestamps are RFC 2822 in GMT, the same instant as the UTC timestamps in Cloud Logging.

Recent messages in both directions:

```bash
curl -s -G -u "$TW_AUTH" "$TW_MESSAGES.json" --data-urlencode "PageSize=20" \
  | jq -r '.messages[] | [.date_created, .direction, .status, .sid, .num_segments, (.error_code // "")] | @tsv'
```

One message by SID:

```bash
curl -s -u "$TW_AUTH" "$TW_MESSAGES/<SID>.json" \
  | jq '{sid, direction, status, error_code, error_message, num_segments, date_created, date_sent, date_updated}'
```

Messages to the service number on a day (inbound requests):

```bash
curl -s -G -u "$TW_AUTH" "$TW_MESSAGES.json" \
  --data-urlencode "To=+14254345858" --data-urlencode "DateSent=2026-09-10" --data-urlencode "PageSize=50" \
  | jq -r '.messages[] | [.date_created, .status, .sid, .num_segments] | @tsv'
```

Messages on or after a date use `DateSent>=`, on or before use `DateSent<=`. Both include the whole day. The forms without `=` are silently ignored and return every message.

## Finding the replies to an inbound message

Twilio does not link a reply to the message it answers. A reply has `direction` `outbound-reply`, `from` the service number, `to` the sender, and is created within a few seconds of the inbound. A reply spread over several messages (the `n:` switch) is several separate resources.

1. Fetch the inbound message by SID and note its `from` and `date_created`.
2. List messages with `To` set to that number and `DateSent>=` set to that day.
3. Take the `outbound-reply` entries created just after the inbound.

```bash
curl -s -G -u "$TW_AUTH" "$TW_MESSAGES.json" \
  --data-urlencode "To=<sender>" --data-urlencode "DateSent>=2026-09-10" --data-urlencode "PageSize=20" \
  | jq -r '.messages[] | select(.direction == "outbound-reply") | [.date_created, .status, .sid, .num_segments, (.error_code // ""), (.error_message // "")] | @tsv'
```

An inbound message has status `received`. Status meanings for a reply:
 - `delivered`: the carrier confirmed delivery. For a phone that is a handset receipt. For a satellite messenger it is the receipt from the carrier gateway in front of the device, not from the device itself.
 - `sent`: the carrier accepted the message and has not reported delivery. Every reply on every route has reached `delivered`, so a reply stuck at `sent` is unusual and worth reporting.
 - `undelivered` or `failed`: read `error_code` and `error_message`. The Error Dictionary entry is at `https://www.twilio.com/docs/api/errors/<error_code>`.

## Alerts

Alerts are Twilio's record of what went wrong on its side of the webhook, and of delivery failures. An alert's `resource_sid` is the SID of the message involved, which is the join back to the gateway's `sms.inbound` line.

```bash
curl -s -G -u "$TW_AUTH" "https://monitor.twilio.com/v1/Alerts" \
  --data-urlencode "LogLevel=error" --data-urlencode "StartDate=2026-09-01" --data-urlencode "PageSize=20" \
  | jq -r '.alerts[] | [.date_generated, .log_level, .error_code, .resource_sid, .request_method, .request_url] | @tsv'
```

`alert_text` holds the details as a URL-encoded form string, including the status and body the gateway returned. Fetch one alert by SID at `https://monitor.twilio.com/v1/Alerts/<SID>` to read it.

Alert codes that mean the gateway, not Twilio, failed:
 - `11200`: Twilio could not fetch the webhook. The gateway did not answer within the timeout or returned a 5xx.
 - `11205`: the connection to the webhook failed.
 - `12100`: the response was not valid XML.
 - `12300`: the response had the wrong content type.

## Privacy

Twilio's records contain phone numbers and message bodies. The service is designed so that neither is stored anywhere else, and an investigation must not undo that:
 - Refer to messages by SID. Never write a phone number into a report, a file, a commit, or memory.
 - Never copy a message body. The request shape (location, mode, variables, device) is in the `requests` table and the request logs; report it from there.
 - Read the fields the question needs. Do not dump whole message resources into the transcript.

## One-time setup

1. In the Twilio Console, create a restricted API key (Account, API keys & tokens, Create API key, Restricted). Grant exactly these four permissions and nothing else:
   - `twilio/messaging/messages/list`
   - `twilio/messaging/messages/read`
   - `twilio/monitor/alerts/list`
   - `twilio/monitor/alerts/read`
2. Add `TWILIO_ACCOUNT_SID`, `TWILIO_READ_KEY_SID`, and `TWILIO_READ_KEY_SECRET` to `deploy.env`. The file is gitignored.
3. Check the key with the recent-messages command above.
