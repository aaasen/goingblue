import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { CODECS, supportedVersions } from "@weather/protocol";
import { fetchForecast, parseRequest } from "./forecast.js";

// The codec server: one container per shipped protocol version, frozen at that version's git
// tag and kept running for as long as clients in the field may still speak it. It is
// deliberately minimal — parse the request, fetch Open-Meteo, encode — with no database, no
// transport handling, and no static assets, so a frozen image never needs to change when the
// gateway, accounts, or messaging integrations evolve (see VERSIONING.md).
//
// Wire contract with the gateway (frozen across all versions):
//   POST /encode   body: the raw request text, version token included
//     200  the encoded forecast message
//     400  the request is malformed (missing/unsupported version, bad parameters)
//     503  upstream data unavailable — the gateway replies with its retry text
const app = new Hono();

app.get("/health", (c) => c.text("OK", 200));

app.post("/encode", async (c) => {
  const body = (await c.req.text()).trim();
  const params = parseRequest(body);
  console.log("encode request:", params);

  // The gateway routes by explicit version, so these are a backstop against direct callers.
  if (params.decoderVersion === null) {
    return c.text("missing protocol version token", 400);
  }
  const codec = CODECS[params.decoderVersion];
  if (!codec) {
    const supported = supportedVersions().map((v) => `v${v}`).join(", ");
    return c.text(`unsupported protocol version v${params.decoderVersion} (supported: ${supported})`, 400);
  }

  try {
    const encoded = await fetchForecast(params, codec);
    return c.text(encoded, 200);
  } catch (e) {
    console.error("fetchForecast failed:", e);
    return c.text("forecast unavailable", 503);
  }
});

const port = parseInt(process.env["PORT"] ?? "8081");
serve({ fetch: app.fetch, port }, () => {
  console.log(`Codec server (protocol ${supportedVersions().map((v) => `v${v}`).join(", ")}) listening on :${port}`);
});
