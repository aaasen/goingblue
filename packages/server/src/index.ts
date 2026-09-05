import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { basicAuth } from "hono/basic-auth";
import { cors } from "hono/cors";
import { forecast, health, sms, createAccountRoute, deleteAccountRoute } from "./routes.js";
import { landing } from "./pages/landing.js";
import { support } from "./pages/support.js";
import { privacy } from "./pages/privacy.js";
import { terms } from "./pages/terms.js";
import { contactCard } from "./pages/contact-card.js";
import { image, favicon } from "./assets.js";
import { vendorAsset } from "./vendor.js";
import { benchmark } from "./benchmark.js";
import { stats, hideAccountRoute, unhideAccountRoute } from "./pages/stats.js";
import { migrate } from "./db.js";
import { log } from "./log.js";

const app = new Hono();

app.get("/", landing);
app.get("/health", health);
app.get("/support", support);
app.get("/privacy", privacy);
app.get("/terms", terms);
app.get("/contact.vcf", contactCard);
app.get("/benchmark", benchmark);
app.get("/img/:name", image);
// Library bundles for the stats map. Not behind the stats auth: the bytes are public
// open-source code, and keeping them here lets them cache independently of the login.
app.get("/vendor/:v/:name", vendorAsset);
app.get("/favicon.ico", favicon);
app.use("/forecast", cors({ origin: "*", allowMethods: ["POST", "OPTIONS"] }));
app.post("/forecast", forecast);
app.post("/sms", sms);
app.use("/account", cors({ origin: "*", allowMethods: ["POST", "OPTIONS"] }));
app.post("/account", createAccountRoute);
app.use("/account/delete", cors({ origin: "*", allowMethods: ["POST", "OPTIONS"] }));
app.post("/account/delete", deleteAccountRoute);

// The stats dashboard is the one route here that isn't for users, so it is the one route behind
// a password. Basic auth rather than a secret in the URL: Cloud Run records httpRequest.requestUrl
// for every request, so a `?key=` or `/stats/<secret>` scheme would file the password in Cloud
// Logging for a month; the Authorization header is not logged, and browsers keep it in the
// keychain. hono's basicAuth compares in constant time, so there is no credential check to get
// wrong here.
//
// Registered only when the secret exists, and registered as one unit with its middleware: if
// STATS_PASS is ever missing the path 404s, because the failure mode of the alternative — route
// present, middleware absent — is a public read-only view of the request table.
const statsPass = process.env["STATS_PASS"];
if (statsPass) {
  const auth = basicAuth({
    username: process.env["STATS_USER"] ?? "lane",
    password: statsPass,
    realm: "Going Blue stats",
  });
  // The page and its hide/unhide edits share one credential; the edits are plain form POSTs
  // from the page, so the same header the browser attached for the page covers them.
  app.use("/stats", auth);
  app.use("/stats/*", auth);
  app.get("/stats", stats);
  app.post("/stats/hide", hideAccountRoute);
  app.post("/stats/unhide", unhideAccountRoute);
}

const port = parseInt(process.env["PORT"] ?? "8080");

// Apply schema on startup. The database is a required dependency (it gates the forecast
// path for quotas/rate limiting and records every request), so a migration failure is
// logged loudly; requests that need the DB will surface the error on their own path.
migrate()
  .then(() => log.info("db.schema_ready"))
  .catch((e) => log.error("db.migrate_failed", { err: e }));

serve({ fetch: app.fetch, port }, () => {
  log.info("server.listening", { port, stats: statsPass ? "enabled" : "disabled_no_secret" });
});
