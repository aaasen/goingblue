import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { cors } from "hono/cors";
import { forecast, health, inbound, sms, testPage, createAccountRoute, verifyAccountRoute } from "./routes.js";
import { landing, privacy, terms, contactCard } from "./legal.js";
import { migrate } from "./db.js";
import { log } from "./log.js";

const app = new Hono();

app.get("/", landing);
app.get("/health", health);
app.get("/privacy", privacy);
app.get("/terms", terms);
app.get("/contact.vcf", contactCard);
app.use("/forecast", cors({ origin: "*", allowMethods: ["POST", "OPTIONS"] }));
app.post("/forecast", forecast);
app.post("/inbound", inbound);
app.post("/sms", sms);
app.use("/account", cors({ origin: "*", allowMethods: ["POST", "OPTIONS"] }));
app.post("/account", createAccountRoute);
app.use("/account/verify", cors({ origin: "*", allowMethods: ["POST", "OPTIONS"] }));
app.post("/account/verify", verifyAccountRoute);
app.get("/test", testPage);
app.post("/test", testPage);

const port = parseInt(process.env["PORT"] ?? "8080");

// Apply schema on startup. The database is a required dependency (it gates the forecast
// path for quotas/rate limiting and records every request), so a migration failure is
// logged loudly; requests that need the DB will surface the error on their own path.
migrate()
  .then(() => log.info("db.schema_ready"))
  .catch((e) => log.error("db.migrate_failed", { err: e }));

serve({ fetch: app.fetch, port }, () => {
  log.info("server.listening", { port });
});
