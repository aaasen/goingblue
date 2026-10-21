import { Linking, Platform } from 'react-native';
import Purchases, {
  LOG_LEVEL, PACKAGE_TYPE, type CustomerInfo, type PurchasesPackage,
} from 'react-native-purchases';

// The subscription, through RevenueCat. The account token is the RevenueCat app user id, so
// the webhook can tie a purchase back to the account (server: subscriptions.ts). The SDK's
// entitlement is the app's own view of the subscription, which it shows even before the
// server has heard about the purchase and even offline (App.tsx, effectiveQuota).
//
// Keys: a dev build uses the RevenueCat Test Store key from EXPO_PUBLIC_REVENUECAT_TEST_KEY,
// which simulates purchases with no store setup and renews a monthly every five minutes. The
// SDK refuses a Test Store key in a release build, so release builds use the store keys below.
// Both are public SDK keys, not secrets.
const IOS_KEY = 'appl_OCUSDfNYrCbDeNfzuEhvRzVdINn';
const ANDROID_KEY = 'goog_CKjVtvoSkJuTdKTALJrWDNiKMBz';

// The entitlement's identifier in the RevenueCat dashboard, which cannot be renamed there.
export const ENTITLEMENT = 'going_blue_expedition';

function apiKey(): string | null {
  if (__DEV__) return process.env.EXPO_PUBLIC_REVENUECAT_TEST_KEY || null;
  return (Platform.OS === 'ios' ? IOS_KEY : ANDROID_KEY) || null;
}

// Whether purchases are set up for this build. Without a key the Subscribe buttons explain
// themselves rather than failing.
export function purchasesAvailable(): boolean {
  return apiKey() !== null;
}

let configuredFor: string | null = null;

// Point the SDK at the account. Called once per token: the first call configures, a later one
// (a new account after deletion) logs the new id in.
export async function configurePurchases(token: string): Promise<void> {
  const key = apiKey();
  if (key === null || configuredFor === token) return;
  if (configuredFor === null) {
    if (__DEV__) await Purchases.setLogLevel(LOG_LEVEL.DEBUG);
    Purchases.configure({ apiKey: key, appUserID: token });
  } else {
    await Purchases.logIn(token);
  }
  configuredFor = token;
}

// Forget the account at RevenueCat on this device. The purchase itself stays with the store
// and comes back through Restore Purchases.
export async function logOutPurchases(): Promise<void> {
  if (configuredFor === null) return;
  configuredFor = null;
  await Purchases.logOut().catch(() => {});
}

// The active Expedition entitlement, or null.
export function activeEntitlement(info: CustomerInfo) {
  return info.entitlements.active[ENTITLEMENT] ?? null;
}

export function isEntitled(info: CustomerInfo | null): boolean {
  return info !== null && activeEntitlement(info) !== null;
}

// Watch the entitlement: the current state now, then every change (a purchase, a renewal, an
// expiration the SDK learns of). Returns the unsubscribe.
export function watchCustomerInfo(onInfo: (info: CustomerInfo) => void): () => void {
  if (configuredFor === null) return () => {};
  Purchases.getCustomerInfo().then(onInfo, () => {});
  Purchases.addCustomerInfoUpdateListener(onInfo);
  return () => { Purchases.removeCustomerInfoUpdateListener(onInfo); };
}

export interface Plans {
  monthly: PurchasesPackage | null;
  annual: PurchasesPackage | null;
}

// The two plans from the current offering.
export async function loadPlans(): Promise<Plans> {
  const { current } = await Purchases.getOfferings();
  return {
    monthly: current?.monthly ?? current?.availablePackages.find((p) => p.packageType === PACKAGE_TYPE.MONTHLY) ?? null,
    annual: current?.annual ?? current?.availablePackages.find((p) => p.packageType === PACKAGE_TYPE.ANNUAL) ?? null,
  };
}

// The store product id of a package as an entitlement names it. Play folds the base plan into
// the package's id ("subscription:base-plan") but reports the two apart on the entitlement.
function entitlementProductId(info: CustomerInfo): string | null {
  const e = activeEntitlement(info);
  if (!e) return null;
  return e.productPlanIdentifier ? `${e.productIdentifier}:${e.productPlanIdentifier}` : e.productIdentifier;
}

// Which of the two plans the account's subscription is, or null when it matches neither (no
// subscription, the plans not loaded yet, or a product since replaced in the offering).
export function currentPlan(info: CustomerInfo | null, plans: Plans | null): 'monthly' | 'annual' | null {
  const id = info ? entitlementProductId(info) : null;
  if (id === null || !plans) return null;
  if (plans.monthly && id === plans.monthly.product.identifier) return 'monthly';
  if (plans.annual && id === plans.annual.product.identifier) return 'annual';
  return null;
}

// Whether the account's subscription is the monthly plan, the one that can switch to annual.
export function onMonthlyPlan(info: CustomerInfo | null, plans: Plans | null): boolean {
  return currentPlan(info, plans) === 'monthly';
}

// The subscription's current period as the store reports it: when it ends, and whether it renews
// then. Null without an active entitlement or a date.
export function subscriptionPeriod(info: CustomerInfo | null): { ends: Date; renews: boolean } | null {
  const e = info ? activeEntitlement(info) : null;
  if (!e?.expirationDate) return null;
  const ends = new Date(e.expirationDate);
  return Number.isNaN(ends.getTime()) ? null : { ends, renews: e.willRenew };
}

// Buy a plan. `replacing` is the product the subscriber has now, for a switch between the two
// plans: Apple handles that itself, since both are in one subscription group, while Google has
// to be told which subscription the new one replaces or it bills both. Resolves to the customer
// info on success and null when the reader cancelled; any other failure throws with the store's
// message.
export async function purchasePlan(pkg: PurchasesPackage, replacing: string | null = null): Promise<CustomerInfo | null> {
  try {
    const change = replacing !== null && Platform.OS === 'android' ? { oldProductIdentifier: replacing } : null;
    const { customerInfo } = change
      ? await Purchases.purchasePackage(pkg, null, change)
      : await Purchases.purchasePackage(pkg);
    return customerInfo;
  } catch (e) {
    if (typeof e === 'object' && e !== null && (e as { userCancelled?: boolean | null }).userCancelled) return null;
    throw e;
  }
}

export function restorePurchases(): Promise<CustomerInfo> {
  return Purchases.restorePurchases();
}

// Play's subscriptions page for this app, when RevenueCat has no management URL to give.
const PLAY_SUBSCRIPTIONS_URL = 'https://play.google.com/store/account/subscriptions?package=com.laneaasen.weather';

// The store's own subscription management page, where a subscriber changes plan or cancels. The
// SDK's sheet is iOS only; on Android the page is a Play Store link, which RevenueCat reports as
// the customer's management URL.
export async function manageSubscription(info: CustomerInfo | null): Promise<void> {
  if (Platform.OS === 'ios') return Purchases.showManageSubscriptions();
  await Linking.openURL(info?.managementURL ?? PLAY_SUBSCRIPTIONS_URL);
}
