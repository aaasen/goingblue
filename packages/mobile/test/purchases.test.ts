import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// The SDK is native; what is tested here is the wrapper's handling of its answers.
const sdk = vi.hoisted(() => ({
  configure: vi.fn(),
  setLogLevel: vi.fn(async () => {}),
  logIn: vi.fn(async () => ({ customerInfo: {}, created: false })),
  logOut: vi.fn(async () => ({})),
  getCustomerInfo: vi.fn(async () => ({ entitlements: { active: {} } })),
  addCustomerInfoUpdateListener: vi.fn(),
  removeCustomerInfoUpdateListener: vi.fn(() => true),
  getOfferings: vi.fn(),
  purchasePackage: vi.fn(),
  restorePurchases: vi.fn(),
  showManageSubscriptions: vi.fn(async () => {}),
}));
vi.mock('react-native-purchases', () => ({
  default: sdk,
  LOG_LEVEL: { DEBUG: 'DEBUG' },
  PACKAGE_TYPE: { MONTHLY: 'MONTHLY', ANNUAL: 'ANNUAL' },
}));
const platform = vi.hoisted(() => ({ OS: 'ios' as string }));
const linking = vi.hoisted(() => ({ openURL: vi.fn(async () => true) }));
vi.mock('react-native', () => ({ Platform: platform, Linking: linking }));
vi.hoisted(() => { (globalThis as { __DEV__?: boolean }).__DEV__ = true; });

import type { CustomerInfo, PurchasesPackage } from 'react-native-purchases';
import {
  ENTITLEMENT, activeEntitlement, configurePurchases, currentPlan, isEntitled, loadPlans, logOutPurchases, manageSubscription, onMonthlyPlan, purchasePlan,
  pendingAnnualSwitch, subscriptionPeriod,
  purchasesAvailable, watchCustomerInfo,
} from '../purchases';

const info = (active: Record<string, { productIdentifier: string }>) =>
  ({ entitlements: { active } } as unknown as CustomerInfo);
const pkg = (packageType: string, identifier: string) =>
  ({ identifier: `$rc_${packageType.toLowerCase()}`, packageType, product: { identifier, priceString: '$10.00' } } as unknown as PurchasesPackage);

describe('entitlement', () => {
  it('reads the Expedition entitlement off the customer info', () => {
    expect(isEntitled(null)).toBe(false);
    expect(isEntitled(info({}))).toBe(false);
    expect(isEntitled(info({ [ENTITLEMENT]: { productIdentifier: 'expedition_monthly' } }))).toBe(true);
    expect(activeEntitlement(info({ [ENTITLEMENT]: { productIdentifier: 'expedition_annual' } }))?.productIdentifier).toBe('expedition_annual');
    expect(isEntitled(info({ other: { productIdentifier: 'x' } }))).toBe(false);
  });
});

describe('configuration', () => {
  beforeEach(() => { vi.clearAllMocks(); });
  afterEach(() => { delete process.env.EXPO_PUBLIC_REVENUECAT_TEST_KEY; });

  it('is unavailable without a key, and then configures nothing and watches nothing', async () => {
    delete process.env.EXPO_PUBLIC_REVENUECAT_TEST_KEY;
    expect(purchasesAvailable()).toBe(false);
    await configurePurchases('ABCDEFGHJKMNPQRS');
    expect(sdk.configure).not.toHaveBeenCalled();
    const stop = watchCustomerInfo(() => {});
    expect(sdk.getCustomerInfo).not.toHaveBeenCalled();
    stop();
  });

  it('configures with the test key and the token, logs a later token in, and logs out once', async () => {
    process.env.EXPO_PUBLIC_REVENUECAT_TEST_KEY = 'test_key';
    expect(purchasesAvailable()).toBe(true);
    await configurePurchases('ABCDEFGHJKMNPQRS');
    expect(sdk.configure).toHaveBeenCalledWith({ apiKey: 'test_key', appUserID: 'ABCDEFGHJKMNPQRS' });
    await configurePurchases('ABCDEFGHJKMNPQRS');
    expect(sdk.configure).toHaveBeenCalledTimes(1);
    expect(sdk.logIn).not.toHaveBeenCalled();
    await configurePurchases('BCDEFGHJKMNPQRST');
    expect(sdk.logIn).toHaveBeenCalledWith('BCDEFGHJKMNPQRST');
    expect(sdk.configure).toHaveBeenCalledTimes(1);

    const seen: unknown[] = [];
    const stop = watchCustomerInfo((i) => seen.push(i));
    await Promise.resolve();
    expect(sdk.addCustomerInfoUpdateListener).toHaveBeenCalledTimes(1);
    stop();
    expect(sdk.removeCustomerInfoUpdateListener).toHaveBeenCalledTimes(1);

    await logOutPurchases();
    await logOutPurchases();
    expect(sdk.logOut).toHaveBeenCalledTimes(1);
  });
});

describe('plans and purchases', () => {
  beforeEach(() => { vi.clearAllMocks(); platform.OS = 'ios'; });

  it('takes the monthly and annual packages off the current offering', async () => {
    const monthly = pkg('MONTHLY', 'expedition_monthly');
    const annual = pkg('ANNUAL', 'expedition_annual');
    sdk.getOfferings.mockResolvedValue({ current: { monthly: null, annual: null, availablePackages: [annual, monthly] } });
    expect(await loadPlans()).toEqual({ monthly, annual });
    sdk.getOfferings.mockResolvedValue({ current: null });
    expect(await loadPlans()).toEqual({ monthly: null, annual: null });
  });

  it('returns the customer info on success and null when the reader cancelled', async () => {
    const annual = pkg('ANNUAL', 'expedition_annual');
    const bought = info({ [ENTITLEMENT]: { productIdentifier: 'expedition_annual' } });
    sdk.purchasePackage.mockResolvedValue({ customerInfo: bought, productIdentifier: 'expedition_annual' });
    expect(await purchasePlan(annual)).toBe(bought);
    expect(sdk.purchasePackage).toHaveBeenLastCalledWith(annual);
    sdk.purchasePackage.mockRejectedValue({ userCancelled: true, message: 'cancelled' });
    expect(await purchasePlan(annual)).toBeNull();
    sdk.purchasePackage.mockRejectedValue(Object.assign(new Error('store down'), { userCancelled: false }));
    await expect(purchasePlan(annual)).rejects.toThrow('store down');
  });

  it('names the subscription being replaced on Android only', async () => {
    const annual = pkg('ANNUAL', 'expedition_annual');
    sdk.purchasePackage.mockResolvedValue({ customerInfo: info({}), productIdentifier: 'expedition_annual' });
    await purchasePlan(annual, 'expedition_monthly');
    expect(sdk.purchasePackage).toHaveBeenLastCalledWith(annual);
    platform.OS = 'android';
    await purchasePlan(annual, 'expedition_monthly');
    expect(sdk.purchasePackage).toHaveBeenLastCalledWith(annual, null, { oldProductIdentifier: 'expedition_monthly' });
  });

  it('knows a monthly subscriber, base plan included', () => {
    const plans = { monthly: pkg('MONTHLY', 'expedition_monthly'), annual: pkg('ANNUAL', 'expedition_annual') };
    const sub = (productIdentifier: string, productPlanIdentifier: string | null = null) =>
      ({ entitlements: { active: { [ENTITLEMENT]: { productIdentifier, productPlanIdentifier } } } } as unknown as CustomerInfo);
    expect(onMonthlyPlan(sub('expedition_monthly'), plans)).toBe(true);
    expect(onMonthlyPlan(sub('expedition_annual'), plans)).toBe(false);
    expect(onMonthlyPlan(info({}), plans)).toBe(false);
    expect(onMonthlyPlan(null, plans)).toBe(false);
    const play = { monthly: pkg('MONTHLY', 'expedition:monthly'), annual: pkg('ANNUAL', 'expedition:annual') };
    expect(onMonthlyPlan(sub('expedition', 'monthly'), play)).toBe(true);
    expect(onMonthlyPlan(sub('expedition', 'annual'), play)).toBe(false);
  });
});

describe('managing a subscription', () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it('presents the App Store sheet on iOS', async () => {
    platform.OS = 'ios';
    await manageSubscription(null);
    expect(sdk.showManageSubscriptions).toHaveBeenCalledTimes(1);
    expect(linking.openURL).not.toHaveBeenCalled();
  });

  it('opens the Play management link on Android, or the app page when RevenueCat has none', async () => {
    platform.OS = 'android';
    const url = 'https://play.google.com/store/account/subscriptions?sku=expedition&package=com.laneaasen.weather';
    await manageSubscription({ managementURL: url } as unknown as CustomerInfo);
    expect(linking.openURL).toHaveBeenLastCalledWith(url);
    await manageSubscription(null);
    expect(linking.openURL).toHaveBeenLastCalledWith('https://play.google.com/store/account/subscriptions?package=com.laneaasen.weather');
    expect(sdk.showManageSubscriptions).not.toHaveBeenCalled();
  });
});

describe('the current subscription', () => {
  const plans = { monthly: pkg('MONTHLY', 'expedition:monthly'), annual: pkg('ANNUAL', 'expedition:annual') };
  const sub = (over: Record<string, unknown>) =>
    ({ entitlements: { active: { [ENTITLEMENT]: { productIdentifier: 'expedition', productPlanIdentifier: 'annual',
      expirationDate: '2026-11-21T15:00:00Z', willRenew: true, ...over } } } } as unknown as CustomerInfo);

  it('names the plan, or nothing when it matches neither', () => {
    expect(currentPlan(sub({}), plans)).toBe('annual');
    expect(currentPlan(sub({ productPlanIdentifier: 'monthly' }), plans)).toBe('monthly');
    expect(currentPlan(sub({ productIdentifier: 'old_product', productPlanIdentifier: null }), plans)).toBeNull();
    expect(currentPlan(sub({}), null)).toBeNull();
    expect(currentPlan(info({}), plans)).toBeNull();
  });

  it('reads the period end and whether it renews', () => {
    expect(subscriptionPeriod(sub({}))).toEqual({ ends: new Date('2026-11-21T15:00:00Z'), renews: true });
    expect(subscriptionPeriod(sub({ willRenew: false }))?.renews).toBe(false);
    expect(subscriptionPeriod(sub({ expirationDate: null }))).toBeNull();
    expect(subscriptionPeriod(info({}))).toBeNull();
    expect(subscriptionPeriod(null)).toBeNull();
  });
});

describe('a switch to annual waiting for the renewal', () => {
  const plans = { monthly: pkg('MONTHLY', 'expedition_monthly'), annual: pkg('ANNUAL', 'expedition_annual') };
  const on = (productIdentifier: string) =>
    ({ entitlements: { active: { [ENTITLEMENT]: { productIdentifier, productPlanIdentifier: null } } } } as unknown as CustomerInfo);
  const at = new Date('2026-10-22T15:00:00Z');

  it('is pending while the monthly plan runs out', () => {
    expect(pendingAnnualSwitch(on('expedition_monthly'), plans, at, new Date('2026-10-21T12:00:00Z'))).toBe(at);
    // A renewal that lands a little late still counts as waiting.
    expect(pendingAnnualSwitch(on('expedition_monthly'), plans, at, new Date('2026-10-23T12:00:00Z'))).toBe(at);
  });

  it('is over once the annual plan is in effect, the date is long past, or nothing was recorded', () => {
    expect(pendingAnnualSwitch(on('expedition_annual'), plans, at, new Date('2026-10-21T12:00:00Z'))).toBeNull();
    expect(pendingAnnualSwitch(on('expedition_monthly'), plans, at, new Date('2026-10-24T12:00:00Z'))).toBeNull();
    expect(pendingAnnualSwitch(on('expedition_monthly'), plans, null, new Date('2026-10-21T12:00:00Z'))).toBeNull();
  });
});
