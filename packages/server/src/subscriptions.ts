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
