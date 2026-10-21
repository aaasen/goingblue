import { timingSafeEqual } from "node:crypto";
import { isValidToken, normalizeToken } from "@weather/protocol";
import { transaction } from "./db.js";
import { log } from "./log.js";

// Subscriptions as RevenueCat reports them (POST /revenuecat, routes.ts). RevenueCat is the one
// source: it holds the receipts from both stores and sends an event for every change. The
// gateway keeps only what the quota needs, each subscription's expiration and the accounts it
// serves, and never calls RevenueCat itself.
//
// A subscription row is keyed on the store's original transaction id, which names one
// subscription for its whole life across renewals, plan changes and restores. An account is
// linked to it when an event names the account's token as the RevenueCat app user id, or as one
// of its aliases, which is the same subscription restored onto another account. An account is
// subscribed while any linked subscription has not expired (quota.ts).

export interface SubscriptionEvent {
  type: string;
  // Every app user id the event names: app_user_id, original_app_user_id and the aliases. Those
  // that are account tokens get linked; RevenueCat's own anonymous ids are not.
  appUserIds: string[];
  transactionId: string | null;
  store: string | null;
  product: string | null;
  // When access ends: the period's end for a live or cancelled subscription, the moment it ended
  // for an expired or refunded one. Null on events that are not about a subscription.
  expiresAt: Date | null;
  // When RevenueCat produced the event, so a delayed older event cannot overwrite a newer one.
  eventAt: Date;
  // A TRANSFER moves every subscription from one set of app user ids to another.
  transferredFrom: string[];
  transferredTo: string[];
}

const str = (v: unknown): string | null => (typeof v === "string" && v !== "" ? v : null);
const strs = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []);
const at = (v: unknown): Date | null => (typeof v === "number" && Number.isFinite(v) ? new Date(v) : null);

// The webhook body is `{ api_version, event: { ... } }`. Null when it is not one.
export function parseSubscriptionEvent(body: unknown): SubscriptionEvent | null {
  if (typeof body !== "object" || body === null) return null;
  const e = (body as Record<string, unknown>)["event"];
  if (typeof e !== "object" || e === null) return null;
  const o = e as Record<string, unknown>;
  const type = str(o["type"]);
  if (type === null) return null;
  const ids = [str(o["app_user_id"]), str(o["original_app_user_id"]), ...strs(o["aliases"])];
  return {
    type,
    appUserIds: [...new Set(ids.filter((x): x is string => x !== null))],
    transactionId: str(o["original_transaction_id"]),
    store: str(o["store"]),
    product: str(o["product_id"]),
    expiresAt: at(o["expiration_at_ms"]),
    eventAt: at(o["event_timestamp_ms"]) ?? new Date(),
    transferredFrom: strs(o["transferred_from"]),
    transferredTo: strs(o["transferred_to"]),
  };
}

// The account tokens among a list of app user ids, normalized.
function tokensOf(ids: string[]): string[] {
  return ids.filter(isValidToken).map(normalizeToken);
}

// Apply one event. A subscription event upserts the subscription and links every account the
// event names; a transfer moves the links; anything else (TEST, events with no subscription in
// them) is acknowledged and ignored. Idempotent: the same event twice leaves the same rows, and
// an event older than the row it would update leaves the row alone.
export async function recordSubscriptionEvent(e: SubscriptionEvent): Promise<"recorded" | "ignored"> {
  if (e.type === "TRANSFER") {
    const from = tokensOf(e.transferredFrom);
    const to = tokensOf(e.transferredTo);
    if (from.length === 0 || to.length === 0) return "ignored";
    await transaction(async (client) => {
      await client.query(
        `with moved as (
           delete from account_subscriptions l using accounts a
            where a.id = l.account_id and a.token = any($1)
           returning l.subscription_id)
         insert into account_subscriptions (account_id, subscription_id)
         select a.id, m.subscription_id
           from accounts a, (select distinct subscription_id from moved) m
          where a.token = any($2)
         on conflict do nothing`,
        [from, to],
      );
    });
    log.info("subscription.transfer", { from: from.length, to: to.length });
    return "recorded";
  }
  if (e.transactionId === null || e.expiresAt === null) return "ignored";
  const tokens = tokensOf(e.appUserIds);
  await transaction(async (client) => {
    await client.query(
      `insert into subscriptions (id, store, product, expires_at, event_at)
       values ($1, $2, $3, $4, $5)
       on conflict (id) do update
         set store = excluded.store, product = excluded.product, expires_at = excluded.expires_at,
             event_at = excluded.event_at, updated_at = now()
       where excluded.event_at >= subscriptions.event_at`,
      [e.transactionId, e.store, e.product, e.expiresAt, e.eventAt],
    );
    if (tokens.length > 0) {
      await client.query(
        `insert into account_subscriptions (account_id, subscription_id)
         select id, $2 from accounts where token = any($1)
         on conflict do nothing`,
        [tokens, e.transactionId],
      );
    }
  });
  log.info("subscription.event", {
    type: e.type, store: e.store, product: e.product, expires_at: e.expiresAt.toISOString(), accounts: tokens.length,
  });
  return "recorded";
}

// Whether the webhook's Authorization header is the value configured at RevenueCat, compared in
// constant time.
export function authorizedWebhook(header: string | undefined, expected: string): boolean {
  const a = Buffer.from(header ?? "");
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

// Asking RevenueCat directly, for the times no webhook will say what happened: above all a
// Restore Purchases onto a new account after the old one was deleted, where the transfer event
// names no subscription and the old account's links are gone. The app calls it after every
// purchase and restore (POST /account/subscription/sync, routes.ts).
//
// RevenueCat's v2 API reports the customer's active entitlements but not the store's original
// transaction id the webhook rows are keyed on, so what it says is kept as a row of its own: one
// per account, keyed `entitlement:<account id>`, ending when the entitlement does. The account is
// subscribed while that row or any webhook row is live (quota.ts). The key is a secret v2 key
// with only `customer_information:customers:read`.
const REVENUECAT_API = "https://api.revenuecat.com/v2";
const SYNC_TIMEOUT_MS = 10_000;

export function syncConfigured(): boolean {
  return Boolean(process.env["REVENUECAT_API_KEY"] && process.env["REVENUECAT_PROJECT_ID"]
    && process.env["REVENUECAT_ENTITLEMENT_ID"]);
}

// When the account's Expedition entitlement ends according to RevenueCat: a date, the far future
// for one with no end, or null for none (including a customer RevenueCat has never seen). Throws
// when RevenueCat can't be asked.
export async function fetchEntitlementEnd(token: string): Promise<Date | null> {
  const key = process.env["REVENUECAT_API_KEY"]!;
  const project = process.env["REVENUECAT_PROJECT_ID"]!;
  const entitlement = process.env["REVENUECAT_ENTITLEMENT_ID"]!;
  const resp = await fetch(`${REVENUECAT_API}/projects/${encodeURIComponent(project)}/customers/${encodeURIComponent(token)}`, {
    headers: { Authorization: `Bearer ${key}` },
    signal: AbortSignal.timeout(SYNC_TIMEOUT_MS),
  });
  if (resp.status === 404) return null;
  if (!resp.ok) throw new Error(`RevenueCat customer lookup: HTTP ${resp.status}`);
  const body = (await resp.json()) as { active_entitlements?: { items?: { entitlement_id?: unknown; expires_at?: unknown }[] } };
  const item = body.active_entitlements?.items?.find((i) => i.entitlement_id === entitlement);
  if (!item) return null;
  if (item.expires_at === null || item.expires_at === undefined) return new Date(Date.UTC(9999, 0, 1));
  return typeof item.expires_at === "number" ? new Date(item.expires_at) : null;
}

// Record what RevenueCat said for the account: its entitlement row ends when the entitlement
// does, or now when there is none, which leaves the webhook rows to speak for themselves.
export async function recordEntitlementSync(token: string, endsAt: Date | null): Promise<void> {
  await transaction(async (client) => {
    const account = (await client.query<{ id: string }>("select id from accounts where token = $1", [token])).rows[0];
    if (!account) return;
    const id = `entitlement:${account.id}`;
    await client.query(
      `insert into subscriptions (id, store, product, expires_at, event_at)
       values ($1, 'revenuecat', $2, coalesce($3, now()), now())
       on conflict (id) do update
         set product = excluded.product, expires_at = excluded.expires_at, event_at = now(), updated_at = now()`,
      [id, process.env["REVENUECAT_ENTITLEMENT_ID"] ?? null, endsAt],
    );
    await client.query(
      `insert into account_subscriptions (account_id, subscription_id) values ($1, $2) on conflict do nothing`,
      [account.id, id],
    );
  });
  log.info("subscription.sync", { active: endsAt !== null && endsAt > new Date() });
}
