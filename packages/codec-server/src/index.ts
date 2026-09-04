import { serve } from "@hono/node-server";
import { Hono, type Context } from "hono";
import { wireCodec, WIRE_VERSION } from "@weather/protocol";
import { describeRequest, fetchForecast, parseRequest, splitReplyFor } from "./forecast.js";
import { log, withRequestId } from "./log.js";

// The codec server: one container per shipped protocol version, frozen at that version's git
// tag and kept running for as long as clients in the field may still speak it. It is
// deliberately minimal — parse the request, fetch Open-Meteo, encode — with no database, no
// transport handling, and no static assets, so a frozen image never needs to change when the
// gateway, accounts, or messaging integrations evolve (see VERSIONING.md).
//
// Wire contract with the gateway (frozen across all versions):
//   POST /encode   body: the raw request text, version token included
//     200  the encoded forecast message, ONE MESSAGE PER LINE — the gateway sends each line as
//          its own message and needs to know nothing else about them. A reply that fits one
//          message is a single line, which is what every version before multi-message replies
//          returned, so a frozen image stays correct without changing. The response also
//          carries an X-Request-Shape header describing what was asked for (see
//          describeRequest). The header is optional by contract — containers frozen before it
//          existed don't send one and the gateway records no shape for them.
//     400  the request is malformed (missing/unsupported version, or a missing/invalid
//          component — the body names the problems). The gateway replies with its
//          download-the-app text; the body is for logs and direct callers.
//     503  upstream data unavailable — the gateway replies with its retry text
//   The request may carry an X-Request-Id header, which is logged and never interpreted.
const app = new Hono();

app.get("/health", (c) => c.text("OK", 200));

// The gateway's id for the message being served, tagging every line this request logs so its
// path through both services reads as one sequence. A caller that sends no header logs no id.
app.post("/encode", (c) => withRequestId(c.req.header("X-Request-Id") ?? null, () => encode(c)));

async function encode(c: Context) {
  const body = (await c.req.text()).trim();
  const params = parseRequest(body);
  log.info("encode.request", { ...params });

  // The gateway routes by explicit version, so these are a backstop against direct callers.
  if (params.decoderVersion === null) {
    return c.text("missing protocol version token", 400);
  }
  if (params.decoderVersion !== WIRE_VERSION) {
    return c.text(`unsupported protocol version v${params.decoderVersion} (supported: v${WIRE_VERSION})`, 400);
  }

  // Requests are only ever written by the app, so validation is strict: a missing or invalid
  // component is a malformed request, rejected before any forecast work (see parseRequest).
  if (params.errors.length > 0) {
    return c.text(`invalid request: ${params.errors.join("; ")}`, 400);
  }

  try {
    const { encoded, periods, fetchMs, encodeMs } = await fetchForecast(params, wireCodec);
    // The shape rides on a header rather than in the body so the body stays exactly the
    // encoded message lines: they are what a phone in the field decodes, and they are
    // bit-frozen. What the request asked for (describeRequest) travels next to what the reply
    // actually carries and cost (periods by resolution, upstream and encode wall time).
    return c.text(splitReplyFor(params, encoded, wireCodec.headerChars).join("\n"), 200, {
      "X-Request-Shape": JSON.stringify({ ...describeRequest(params), periods, fetchMs, encodeMs }),
    });
  } catch (e) {
    log.error("encode.failed", { version: params.decoderVersion, err: e });
    return c.text("forecast unavailable", 503);
  }
}

const port = parseInt(process.env["PORT"] ?? "8081");
serve({ fetch: app.fetch, port }, () => {
  log.info("codec.listening", { port, version: WIRE_VERSION });
});
