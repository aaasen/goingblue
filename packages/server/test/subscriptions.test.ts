import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { randomBytes } from "node:crypto";
import { generateToken } from "@weather/protocol";
import { authorizedWebhook, fetchEntitlementEnd, parseSubscriptionEvent, syncConfigured } from "../src/subscriptions.js";

// The webhook's parsing and its auth check. Writing the rows is one transaction over two tables
// (recordSubscriptionEvent) and is exercised against the database, not here.

const TOKEN = generateToken((n) => Uint8Array.from(randomBytes(n)));

// An event as RevenueCat documents it, trimmed to the fields the gateway reads plus a few it
// does not.
const EVENT = {
  api_version: "1.0",
  event: {
    id: "evt_1", type: "INITIAL_PURCHASE", app_user_id: TOKEN.toLowerCase(),
    original_app_user_id: "$RCAnonymousID:abc", aliases: [TOKEN.toLowerCase(), "$RCAnonymousID:abc"],
    product_id: "expedition_monthly", entitlement_ids: ["expedition"], store: "APP_STORE",
    original_transaction_id: "1000000123", transaction_id: "1000000456",
    purchased_at_ms: 1_760_000_000_000, expiration_at_ms: 1_762_600_000_000, event_timestamp_ms: 1_760_000_001_000,
    environment: "PRODUCTION", period_type: "NORMAL",
  },
};

describe("parseSubscriptionEvent", () => {
  it("reads a subscription event", () => {
    expect(parseSubscriptionEvent(EVENT)).toEqual({
      type: "INITIAL_PURCHASE",
      appUserIds: [TOKEN.toLowerCase(), "$RCAnonymousID:abc"],
      transactionId: "1000000123",
      store: "APP_STORE",
      product: "expedition_monthly",
      expiresAt: new Date(1_762_600_000_000),
      eventAt: new Date(1_760_000_001_000),
      transferredFrom: [],
      transferredTo: [],
    });
  });

  it("reads a transfer, which names no subscription", () => {
    const e = parseSubscriptionEvent({ event: {
      type: "TRANSFER", store: "APP_STORE", transferred_from: ["old"], transferred_to: ["new"], event_timestamp_ms: 1,
    } });
    expect(e).toMatchObject({ type: "TRANSFER", transactionId: null, expiresAt: null, transferredFrom: ["old"], transferredTo: ["new"] });
  });

  it("reads the test event, with nothing in it", () => {
    const e = parseSubscriptionEvent({ api_version: "1.0", event: { type: "TEST", app_user_id: "x", event_timestamp_ms: 1 } });
    expect(e).toMatchObject({ type: "TEST", appUserIds: ["x"], transactionId: null, expiresAt: null });
  });

  it("dates an event with no timestamp now", () => {
    const before = Date.now();
    const e = parseSubscriptionEvent({ event: { type: "RENEWAL" } })!;
    expect(e.eventAt.getTime()).toBeGreaterThanOrEqual(before);
  });

  it("is null for anything that is not an event", () => {
    expect(parseSubscriptionEvent(null)).toBeNull();
    expect(parseSubscriptionEvent("nope")).toBeNull();
    expect(parseSubscriptionEvent({})).toBeNull();
    expect(parseSubscriptionEvent({ event: {} })).toBeNull();
    expect(parseSubscriptionEvent({ event: { type: "" } })).toBeNull();
  });
});

describe("authorizedWebhook", () => {
  it("accepts exactly the configured value", () => {
    expect(authorizedWebhook("Bearer s3cret", "Bearer s3cret")).toBe(true);
  });

  it("rejects a missing, different, or longer header", () => {
    expect(authorizedWebhook(undefined, "Bearer s3cret")).toBe(false);
    expect(authorizedWebhook("", "Bearer s3cret")).toBe(false);
    expect(authorizedWebhook("Bearer s3cres", "Bearer s3cret")).toBe(false);
    expect(authorizedWebhook("Bearer s3cret ", "Bearer s3cret")).toBe(false);
  });
});

describe("fetchEntitlementEnd", () => {
  const ENT = "entlf322a4aa35";
  beforeEach(() => {
    process.env["REVENUECAT_API_KEY"] = "sk_test";
    process.env["REVENUECAT_PROJECT_ID"] = "proj123";
    process.env["REVENUECAT_ENTITLEMENT_ID"] = ENT;
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    delete process.env["REVENUECAT_API_KEY"];
    delete process.env["REVENUECAT_PROJECT_ID"];
    delete process.env["REVENUECAT_ENTITLEMENT_ID"];
  });
  const answer = (status: number, body: unknown = {}) => {
    const f = vi.fn(async () => new Response(JSON.stringify(body), { status }));
    vi.stubGlobal("fetch", f);
    return f;
  };

  it("needs the key, the project and the entitlement", () => {
    expect(syncConfigured()).toBe(true);
    delete process.env["REVENUECAT_PROJECT_ID"];
    expect(syncConfigured()).toBe(false);
  });

  it("asks for the customer by token with the secret key", async () => {
    const f = answer(200, { active_entitlements: { items: [] } });
    await fetchEntitlementEnd(TOKEN);
    const [url, init] = f.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(`https://api.revenuecat.com/v2/projects/proj123/customers/${TOKEN}`);
    expect((init.headers as Record<string, string>)["Authorization"]).toBe("Bearer sk_test");
  });

  it("reads the Expedition entitlement's end", async () => {
    answer(200, { active_entitlements: { items: [
      { entitlement_id: "entlother", expires_at: 1 },
      { entitlement_id: ENT, expires_at: 1_800_000_000_000 },
    ] } });
    expect(await fetchEntitlementEnd(TOKEN)).toEqual(new Date(1_800_000_000_000));
  });

  it("treats an entitlement with no end as lasting", async () => {
    answer(200, { active_entitlements: { items: [{ entitlement_id: ENT, expires_at: null }] } });
    expect((await fetchEntitlementEnd(TOKEN))!.getUTCFullYear()).toBe(9999);
  });

  it("is null for no entitlement or a customer RevenueCat has never seen", async () => {
    answer(200, { active_entitlements: { items: [{ entitlement_id: "entlother", expires_at: 1 }] } });
    expect(await fetchEntitlementEnd(TOKEN)).toBeNull();
    answer(404);
    expect(await fetchEntitlementEnd(TOKEN)).toBeNull();
  });

  it("throws when RevenueCat can't answer", async () => {
    answer(500);
    await expect(fetchEntitlementEnd(TOKEN)).rejects.toThrow("HTTP 500");
  });
});
