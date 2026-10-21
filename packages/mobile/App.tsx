import { useCallback, useEffect, useRef, useState } from 'react';
import { Alert, Platform, View, StyleSheet } from 'react-native';
import type { CustomerInfo } from 'react-native-purchases';
import { SafeAreaProvider, SafeAreaView } from 'react-native-safe-area-context';
import { StatusBar } from 'expo-status-bar';
import * as SplashScreen from 'expo-splash-screen';
import HomeScreen from './HomeScreen';
import PaywallScreen from './PaywallScreen';
import SettingsScreen from './SettingsScreen';
import SetupScreen from './SetupScreen';
import { loadToken, clearToken, deleteAccount, fetchQuota, syncSubscription } from './account';
import {
  configurePurchases, currentPlan, isEntitled, loadPlans, logOutPurchases, manageSubscription, onMonthlyPlan,
  pendingAnnualSwitch, purchasePlan, purchasesAvailable, subscriptionPeriod, watchCustomerInfo, type Plans,
} from './purchases';
import { requestErrorMessage } from './network';
import { clearStore } from './cache';
import { removeAllPacks } from './packStore';
import {
  loadAqiScale, loadCoordFormat, loadDevice, loadPendingAnnualSwitch, loadQuota, loadTimeFormat, loadTwoMessages, loadUnits,
  saveAqiScale, saveCoordFormat, saveDevice, savePendingAnnualSwitch, saveQuota, saveTimeFormat, saveTwoMessages, saveUnits, clearSettings,
  defaultUnitPrefs, type AqiScale, type CoordFormat, type TimeFormat, type UnitPrefs,
} from './settings';
import { effectiveQuota, storedQuota, subscriptionLine, type StoredQuota } from './quota';
import type { QuotaState } from '@weather/protocol';
import { DEFAULT_DEVICE, type Device } from './devices';
import { clearTileCache, configureTileCache } from './tileCache';
import { useUpdateCheck } from './updates';
import { palette } from './palette';

// Hold the launch image until the first screen can be drawn as it will finally look. It otherwise
// hides the moment React mounts — which is before the stored token and preferences have come back
// from AsyncStorage, so the app would show a spinner and then redraw once they arrived. Called at
// module scope to beat that first mount; a rejection here only means the splash is already gone,
// which the rest of the launch handles either way.
SplashScreen.preventAutoHideAsync().catch(() => {});

export default function App() {
  const [forecastData, setForecastData] = useState('');
  const [settingsOpen, setSettingsOpen] = useState(false);
  // undefined = still loading from storage; null = no account yet (show setup); string = ready.
  const [token, setToken] = useState<string | null | undefined>(undefined);
  const [units, setUnitsState] = useState<UnitPrefs>(defaultUnitPrefs('imperial'));
  const [timeFormat, setTimeFormatState] = useState<TimeFormat>('12h');
  const [coordFormat, setCoordFormatState] = useState<CoordFormat>('latlon');
  const [aqiScale, setAqiScaleState] = useState<AqiScale>('us');
  // Belongs to the builder, but loaded here with the rest: the builder is the first thing on
  // screen, so reading it there would draw the action button as Get Forecast and rename it a
  // frame later. Behind the splash, the stored device is already in hand.
  const [device, setDeviceState] = useState<Device>(DEFAULT_DEVICE);
  // Loaded alongside the device, and for the same reason: it changes the builder's request, so
  // arriving late would mean the first request of a session could go out under the wrong budget.
  const [twoMessages, setTwoMessagesState] = useState(true);
  // The free-forecast quota as the server last stated it (quota.ts). Owned here because both the
  // builder and Settings show it; HomeScreen is where it is heard.
  const [quota, setQuotaState] = useState<StoredQuota | null>(null);
  // The store's view of the subscription (purchases.ts), null until the SDK has answered. It
  // overrides the server's quota for display, so a purchase shows at once and offline.
  const [customerInfo, setCustomerInfo] = useState<CustomerInfo | null>(null);
  const [paywallOpen, setPaywallOpen] = useState(false);
  // The two plans, for Settings' Switch to Annual: which product the monthly is, and the price
  // of the annual. Loaded once the SDK is configured.
  const [plans, setPlans] = useState<Plans | null>(null);
  const [switching, setSwitching] = useState(false);
  // When a switch to annual bought on iOS takes effect (settings.ts, loadPendingAnnualSwitch).
  const [annualSwitchAt, setAnnualSwitchAt] = useState<Date | null>(null);
  useUpdateCheck();

  // Settled together rather than one at a time: the token decides which screen comes up, and the
  // preferences decide how it reads. Applying them as they land would draw the first screen in
  // metric/24h and correct it a moment later, in full view now that the splash waits for this.
  useEffect(() => {
    // Not awaited: the map's cache cap has no bearing on the first screen.
    configureTileCache();
    Promise.all([
      loadToken(), loadUnits(), loadTimeFormat(), loadCoordFormat(), loadAqiScale(), loadDevice(), loadTwoMessages(),
      loadQuota(), loadPendingAnnualSwitch(),
    ])
      .then(([t, u, f, c, a, d, m, q, s]) => {
        setAnnualSwitchAt(s);
        setUnitsState(u);
        setTimeFormatState(f);
        setCoordFormatState(c);
        setAqiScaleState(a);
        setDeviceState(d);
        setTwoMessagesState(m);
        // The stored quota only fills in until the screen hears something fresher.
        setQuotaState((current) => current ?? q);
        setToken(t);
      })
      // All of them swallow their own storage errors, so this should be unreachable — but the
      // splash now waits on this promise, and a rejection would leave it up for good with no way
      // out but reinstalling. Falling through to setup keeps a broken launch recoverable.
      .catch(() => setToken(null));
  }, []);

  // Drop the launch image once the first screen has been laid out, not when the state arrives —
  // hiding it a frame early exposes an empty root view. Only the loaded branches below attach
  // this, so reaching it means there is something to show.
  const onLayoutRoot = useCallback(() => {
    SplashScreen.hideAsync().catch(() => {});
  }, []);

  // Persist unit changes so the choice survives across sessions.
  function setUnits(u: UnitPrefs) {
    setUnitsState(u);
    saveUnits(u);
  }

  function setTimeFormat(format: TimeFormat) {
    setTimeFormatState(format);
    saveTimeFormat(format);
  }

  function setCoordFormat(format: CoordFormat) {
    setCoordFormatState(format);
    saveCoordFormat(format);
  }

  function setAqiScale(scale: AqiScale) {
    setAqiScaleState(scale);
    saveAqiScale(scale);
  }

  function setDevice(d: Device) {
    setDeviceState(d);
    saveDevice(d);
  }

  function setTwoMessages(on: boolean) {
    setTwoMessagesState(on);
    saveTwoMessages(on);
  }

  // A quota state the server stated, at the time it was stated for (quota.ts, storedQuota).
  const heardQuota = useCallback((state: QuotaState, at: Date) => {
    const stored = storedQuota(state, at);
    setQuotaState(stored);
    saveQuota(stored);
  }, []);

  // The SDK follows the account: configured for the first token, logged in to any later one,
  // and watched for entitlement changes while it is.
  useEffect(() => {
    if (typeof token !== 'string') return;
    let stop: (() => void) | null = null;
    let cancelled = false;
    configurePurchases(token).then(() => {
      if (cancelled) return;
      stop = watchCustomerInfo(setCustomerInfo);
      if (purchasesAvailable()) loadPlans().then((p) => { if (!cancelled) setPlans(p); }, () => {});
    }, () => {});
    return () => { cancelled = true; stop?.(); };
  }, [token]);

  // The Subscribe buttons' press: the paywall, or a word on why there is none in this build.
  const onSubscribe = useCallback(() => {
    if (!purchasesAvailable()) {
      Alert.alert('Subscriptions unavailable', 'This build cannot make purchases.');
      return;
    }
    setPaywallOpen(true);
  }, []);

  // Bring the server up to date from RevenueCat and take its answer, falling back to its plain
  // view if the sync can't run. Best effort either way: the store's answer is already on screen.
  const syncWithServer = useCallback(() => {
    if (typeof token !== 'string') return;
    syncSubscription(token)
      .catch(() => fetchQuota(token))
      .then((state) => heardQuota(state, new Date()), () => {});
  }, [token, heardQuota]);

  // A purchase or restore went through: show it now from the store's answer, and make sure the
  // server, which decides what a request over SMS or satellite gets, knows it too.
  const onPurchased = useCallback((info: CustomerInfo) => {
    setCustomerInfo(info);
    setPaywallOpen(false);
    syncWithServer();
  }, [syncWithServer]);

  // The store says subscribed but the server's last word doesn't: a webhook that never came, as
  // after a restore onto a new account. Synced once per launch, so a sync that can't fix it (the
  // server unreachable) doesn't repeat on every render.
  const syncedThisLaunch = useRef(false);
  useEffect(() => {
    if (syncedThisLaunch.current || !isEntitled(customerInfo) || quota?.state.kind === 'none') return;
    syncedThisLaunch.current = true;
    syncWithServer();
  }, [customerInfo, quota, syncWithServer]);

  // A monthly subscriber moving to the annual plan, straight into the store's purchase sheet.
  const onSwitchToAnnual = useCallback(async () => {
    if (!plans?.annual || !plans.monthly) return;
    setSwitching(true);
    try {
      const info = await purchasePlan(plans.annual, plans.monthly.product.identifier);
      if (info) {
        // Apple applies the switch at the next renewal, so the app notes when; on Android it is
        // already in effect.
        const period = subscriptionPeriod(info);
        if (Platform.OS === 'ios' && period) {
          setAnnualSwitchAt(period.ends);
          savePendingAnnualSwitch(period.ends);
        }
        onPurchased(info);
      }
    } catch (e) {
      Alert.alert('Switch failed', requestErrorMessage(e));
    } finally {
      setSwitching(false);
    }
  }, [plans, onPurchased]);

  // Erase the account server-side, then drop this device's local state: the saved forecasts for
  // that account, then the token itself. Setup mints a fresh account on the way back in.
  //
  // The server call goes first and its failure propagates to the caller, which reports it.
  // Clearing the token after a failed delete would strand a live account with nothing left that
  // could ever delete it — the token is the only handle on it.
  // Once the server has forgotten the account, the phone forgets everything with it: saved
  // forecasts, preferences, offline maps and the map tile cache, so what remains is a fresh
  // install. The in-memory preferences reset too, since Setup renders from them next.
  async function handleDeleteAccount() {
    if (typeof token !== 'string') return;
    await deleteAccount(token);
    await clearStore(token);
    await clearSettings();
    await removeAllPacks();
    await clearTileCache().catch(() => {});
    await clearToken();
    await logOutPurchases();
    setCustomerInfo(null);
    setForecastData('');
    setUnitsState(defaultUnitPrefs('imperial'));
    setTimeFormatState('12h');
    setCoordFormatState('latlon');
    setAqiScaleState('us');
    setDeviceState(DEFAULT_DEVICE);
    setTwoMessagesState(true);
    setQuotaState(null);
    setAnnualSwitchAt(null);
    // The delete lives inside the Settings sheet; close it so Setup isn't hiding under it.
    setSettingsOpen(false);
    setToken(null);
  }

  // Still reading storage. Render nothing and let the splash stand in — it stays up until one of
  // the branches below lays out.
  const shownQuota = effectiveQuota(quota, isEntitled(customerInfo), new Date());
  const pendingSwitch = pendingAnnualSwitch(customerInfo, plans, annualSwitchAt, new Date());
  const paywall = (
    <PaywallScreen
      visible={paywallOpen}
      onClose={() => setPaywallOpen(false)}
      onPurchased={onPurchased}
    />
  );

  if (token === undefined) return null;

  if (token === null) {
    return (
      <SafeAreaProvider>
        <View style={styles.root} onLayout={onLayoutRoot}>
          <StatusBar style={palette.statusBar} />
          <SafeAreaView edges={['top']} style={styles.topInset} />
          <SetupScreen
            onReady={setToken}
            units={units}
            onUnitsChange={setUnits}
            timeFormat={timeFormat}
            onTimeFormatChange={setTimeFormat}
            coordFormat={coordFormat}
            onCoordFormatChange={setCoordFormat}
            aqiScale={aqiScale}
            onAqiScaleChange={setAqiScale}
          />
        </View>
      </SafeAreaProvider>
    );
  }

  return (
    <SafeAreaProvider>
      <View style={styles.root} onLayout={onLayoutRoot}>
        <StatusBar style={palette.statusBar} />
        {/* One screen: the title row (and the door to Settings) lives inside the screen's own
            scroll, and the scroll runs under the status bar — HomeScreen pads its resting content
            by the status-bar inset, so the page seats below the clock and slides beneath it. It
            pads the bottom of its content too, so the last row clears the home indicator. */}
        <HomeScreen
          token={token}
          device={device}
          onDeviceChange={setDevice}
          twoMessages={twoMessages}
          onTwoMessagesChange={setTwoMessages}
          aqiScale={aqiScale}
          units={units}
          timeFormat={timeFormat}
          coordFormat={coordFormat}
          forecastData={forecastData}
          onForecastDataChange={setForecastData}
          onOpenSettings={() => setSettingsOpen(true)}
          quota={shownQuota}
          onQuotaHeard={heardQuota}
          onSubscribe={onSubscribe}
        />
        {/* The paywall mounts under whichever sheet is up: beside the page from the builder's
            button, inside Settings from its own, since iOS presents one modal per view. */}
        {!settingsOpen && paywall}
        <SettingsScreen
          visible={settingsOpen}
          onClose={() => setSettingsOpen(false)}
          onDeleteAccount={handleDeleteAccount}
          quota={shownQuota}
          onSubscribe={onSubscribe}
          onManageSubscription={() => {
            manageSubscription(customerInfo).catch((e) => Alert.alert('Could not open subscriptions', requestErrorMessage(e)));
          }}
          annualSwitch={onMonthlyPlan(customerInfo, plans) && !pendingSwitch && plans?.annual
            ? { price: plans.annual.product.priceString, busy: switching, onPress: onSwitchToAnnual }
            : null}
          subscriptionDetail={subscriptionLine(currentPlan(customerInfo, plans), subscriptionPeriod(customerInfo), pendingSwitch)}
          units={units}
          onUnitsChange={setUnits}
          timeFormat={timeFormat}
          onTimeFormatChange={setTimeFormat}
          coordFormat={coordFormat}
          onCoordFormatChange={setCoordFormat}
          aqiScale={aqiScale}
          onAqiScaleChange={setAqiScale}
        >
          {paywall}
        </SettingsScreen>
      </View>
    </SafeAreaProvider>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: palette.page },
  // Empty safe area: lays out to exactly the top inset, nothing more.
  topInset: { backgroundColor: palette.page },
});
