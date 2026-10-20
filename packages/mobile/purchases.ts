import { Platform } from 'react-native';
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
const IOS_KEY = '';
const ANDROID_KEY = '';

export const ENTITLEMENT = 'expedition';

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

// Buy a plan. `from` is the product the reader already has when this is a plan change: both
// plans are in one subscription group, so Apple handles the switch itself, while Google needs
// to be told which product is being replaced. Resolves to the customer info on success and
// null when the reader cancelled; any other failure throws with the store's message.
export async function purchasePlan(pkg: PurchasesPackage, from: string | null): Promise<CustomerInfo | null> {
  try {
    const change = from !== null && Platform.OS === 'android' ? { oldProductIdentifier: from } : null;
    const { customerInfo } = await Purchases.purchasePackage(pkg, null, change);
    return customerInfo;
  } catch (e) {
    if (typeof e === 'object' && e !== null && (e as { userCancelled?: boolean | null }).userCancelled) return null;
    throw e;
  }
}

export function restorePurchases(): Promise<CustomerInfo> {
  return Purchases.restorePurchases();
}

// The store's own subscription management page, for a subscriber who wants to cancel.
export function manageSubscription(): Promise<void> {
  return Purchases.showManageSubscriptions();
}
