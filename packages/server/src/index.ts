import { serve } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import { Hono } from "hono";
import { cors } from "hono/cors";
import { fileURLToPath } from "node:url";
import { dirname, join, relative } from "node:path";
import { forecast, health, inbound, sms, testPage, createAccountRoute, verifyAccountRoute } from "./routes.js";
import { landing, privacy, terms } from "./legal.js";
import { migrate } from "./db.js";

const app = new Hono();

// The exported Expo web app (`pnpm --filter @weather/mobile build:web`) is hosted under /app —
// it includes the account-creation/opt-in screen used for SMS (10DLC) compliance review. It is
// exported with baseUrl "/app" so its assets resolve under that prefix. serveStatic resolves
// files relative to process.cwd(), so derive a cwd-relative root from this module's location to
// stay correct whether the server runs from the repo root, the server package, or the container.
const webDist = join(dirname(fileURLToPath(import.meta.url)), "../../mobile/dist");
const WEB_ROOT = relative(process.cwd(), webDist) || ".";
const stripAppPrefix = (p: string) => p.replace(/^\/app/, "") || "/";
app.use("/app", serveStatic({ root: WEB_ROOT, rewriteRequestPath: stripAppPrefix }));
app.use("/app/*", serveStatic({ root: WEB_ROOT, rewriteRequestPath: stripAppPrefix }));
// SPA fallback: any unmatched /app path serves index.html so client-side rendering takes over.
app.get("/app/*", serveStatic({ root: WEB_ROOT, path: "index.html" }));

app.get("/", landing);
app.get("/health", health);
app.get("/privacy", privacy);
app.get("/terms", terms);
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
  .then(() => console.log("db schema ready"))
  .catch((e) => console.error("db migrate failed:", e));

serve({ fetch: app.fetch, port }, () => {
  console.log(`Server listening on :${port}`);
});
