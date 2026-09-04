// Structured logging. Every call emits exactly one line of JSON, which is what makes the logs
// parseable: `severity` and `message` are Cloud Logging's own keys, so Cloud Run turns each line
// into a jsonPayload with a rendered summary, a filterable level, and every field queryable
// (`jsonPayload.event="sms.inbound"`). The format is identical in local dev — one thing to parse.
//
// The rule this replaced a banner-and-a-line-per-field style with: one event per thing that
// happened, named `subject.verb`, carrying its fields. A request that fans out into several
// steps logs one line per step, never one line per value.
//
// Deliberately duplicated in packages/server/src/log.ts rather than shared: a codec
// container is frozen at its version's git tag and must never pick up changes from an evolving
// shared module (VERSIONING.md). This file is small enough that the copy is the cheap side.

import { AsyncLocalStorage } from "node:async_hooks";

type Fields = Record<string, unknown>;
type Severity = "DEBUG" | "INFO" | "ERROR";

// The request the current call belongs to. Held ambiently rather than passed to every log call:
// the events of one request are emitted from every depth of the code that serves it, and the
// alternative is a logging parameter threaded through functions that do no logging.
const requestId = new AsyncLocalStorage<string>();

// Run `fn` with every line it logs, at any depth and across awaits, tagged `request_id` so one
// request's path through the services reads as one thing. A null id runs `fn` untagged: the
// absence of the field says the request arrived without one, which is not the same as inventing
// a value that matches nothing anywhere else.
export function withRequestId<T>(id: string | null, fn: () => T): T {
  return id === null ? fn() : requestId.run(id, fn);
}

// Errors are unwrapped in place: the value becomes the message so it reads in the log summary,
// and the stack is hoisted to top-level `stack_trace` — the key Cloud Error Reporting looks for.
// JSON.stringify escapes the stack's newlines, so the entry stays a single line either way.
function emit(severity: Severity, event: string, fields?: Fields): void {
  const entry: Fields = { severity, message: event, event };
  const id = requestId.getStore();
  if (id !== undefined) entry["request_id"] = id;
  let stack: string | undefined;
  for (const [key, value] of Object.entries(fields ?? {})) {
    if (value === undefined) continue;
    if (value instanceof Error) {
      entry[key] = value.message || String(value);
      stack ??= value.stack;
    } else {
      entry[key] = value;
    }
  }
  if (stack !== undefined) entry["stack_trace"] = stack;

  let line: string;
  try {
    line = JSON.stringify(entry);
  } catch {
    // A logger must never throw: a circular or otherwise unserializable field costs its
    // values, not the event.
    line = JSON.stringify({ severity, message: event, event, request_id: id, log_error: "unserializable fields" });
  }
  if (severity === "ERROR") console.error(line);
  else console.log(line);
}

export const log = {
  debug: (event: string, fields?: Fields) => emit("DEBUG", event, fields),
  info: (event: string, fields?: Fields) => emit("INFO", event, fields),
  error: (event: string, fields?: Fields) => emit("ERROR", event, fields),
};
