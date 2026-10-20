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
vi.mock('react-native', () => ({ Platform: platform }));
vi.hoisted(() => { (globalThis as { __DEV__?: boolean }).__DEV__ = true; });

import type { CustomerInfo, PurchasesPackage } from 'react-native-purchases';
import {
  ENTITLEMENT, activeEntitlement, configurePurchases, isEntitled, loadPlans, logOutPurchases, onMonthlyPlan, purchasePlan,
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
