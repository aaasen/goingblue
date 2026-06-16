import { serve } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import { Hono } from "hono";
import { cors } from "hono/cors";
import { forecast, health, inbound, testPage } from "./routes.js";

const app = new Hono();

app.get("/health", health);
app.use("/forecast", cors({ origin: "*", allowMethods: ["POST", "OPTIONS"] }));
app.post("/forecast", forecast);
app.post("/inbound", inbound);
app.get("/test", testPage);
app.post("/test", testPage);
app.use("/*", serveStatic({ root: process.env["CLIENT_DIR"] ?? "./packages/client/dist" }));

const port = parseInt(process.env["PORT"] ?? "8080");
serve({ fetch: app.fetch, port }, () => {
  console.log(`Server listening on :${port}`);
});
