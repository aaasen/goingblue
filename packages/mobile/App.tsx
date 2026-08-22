import { useCallback, useEffect, useState } from 'react';
import { View, Text, TouchableOpacity, StyleSheet, SafeAreaView } from 'react-native';
import { StatusBar } from 'expo-status-bar';
import * as SplashScreen from 'expo-splash-screen';
import BuilderTab from './BuilderTab';
import DecoderTab from './DecoderTab';
import SettingsTab from './SettingsTab';
import SetupScreen from './SetupScreen';
import { loadToken, clearToken, deleteAccount } from './account';
import { clearStore } from './cache';
import {
  loadAqiScale, loadDevice, loadTimeFormat, loadTwoMessages, loadUnits,
  saveAqiScale, saveDevice, saveTimeFormat, saveTwoMessages, saveUnits,
  type AqiScale, type TimeFormat, type Units,
} from './settings';
import { DEFAULT_DEVICE, type Device } from './devices';

type Tab = 'builder' | 'decoder' | 'settings';

// Hold the launch image until the first screen can be drawn as it will finally look. It otherwise
// hides the moment React mounts — which is before the stored token and preferences have come back
// from AsyncStorage, so the app would show a spinner and then redraw once they arrived. Called at
// module scope to beat that first mount; a rejection here only means the splash is already gone,
// which the rest of the launch handles either way.
SplashScreen.preventAutoHideAsync().catch(() => {});

export default function App() {
  const [tab, setTab] = useState<Tab>('builder');
  const [forecastData, setForecastData] = useState('');
  // undefined = still loading from storage; null = no account yet (show setup); string = ready.
  const [token, setToken] = useState<string | null | undefined>(undefined);
  const [units, setUnitsState] = useState<Units>('imperial');
  const [timeFormat, setTimeFormatState] = useState<TimeFormat>('12h');
  const [aqiScale, setAqiScaleState] = useState<AqiScale>('us');
  // Builder-only, but loaded here with the rest: the builder is the tab that comes up first, so
  // reading it inside that tab would draw the action button as Get Forecast and rename it a frame
  // later. Behind the splash, the stored device is already in hand.
  const [device, setDeviceState] = useState<Device>(DEFAULT_DEVICE);
  // Loaded alongside the device, and for the same reason: it changes the builder's request, so
  // arriving late would mean the first request of a session could go out under the wrong budget.
  const [twoMessages, setTwoMessagesState] = useState(true);

  // Settled together rather than one at a time: the token decides which screen comes up, and the
  // preferences decide how it reads. Applying them as they land would draw the first screen in
  // metric/24h and correct it a moment later, in full view now that the splash waits for this.
  useEffect(() => {
    Promise.all([loadToken(), loadUnits(), loadTimeFormat(), loadAqiScale(), loadDevice(), loadTwoMessages()])
      .then(([t, u, f, a, d, m]) => {
        setUnitsState(u);
        setTimeFormatState(f);
        setAqiScaleState(a);
        setDeviceState(d);
        setTwoMessagesState(m);
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
  function setUnits(u: Units) {
    setUnitsState(u);
    saveUnits(u);
  }

  function setTimeFormat(format: TimeFormat) {
    setTimeFormatState(format);
    saveTimeFormat(format);
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

  function onForecastReceived(encoded: string) {
    setForecastData(encoded);
    setTab('decoder');
  }

  // Erase the account server-side, then drop this device's local state: the saved forecasts for
  // that account, then the token itself. Setup mints a fresh account on the way back in.
  //
  // The server call goes first and its failure propagates to the caller, which reports it.
  // Clearing the token after a failed delete would strand a live account with nothing left that
  // could ever delete it — the token is the only handle on it.
  async function handleDeleteAccount() {
    if (typeof token !== 'string') return;
    await deleteAccount(token);
    await clearStore(token);
    await clearToken();
    setForecastData('');
    setTab('builder');
    setToken(null);
  }

  // Still reading storage. Render nothing and let the splash stand in — it stays up until one of
  // the branches below lays out.
  if (token === undefined) return null;

  if (token === null) {
    return (
      <View style={styles.root} onLayout={onLayoutRoot}>
        <StatusBar style="dark" />
        <SafeAreaView style={styles.topInset} />
        <SetupScreen
          onReady={setToken}
          units={units}
          onUnitsChange={setUnits}
          timeFormat={timeFormat}
          onTimeFormatChange={setTimeFormat}
          aqiScale={aqiScale}
          onAqiScaleChange={setAqiScale}
        />
      </View>
    );
  }

  return (
    <View style={styles.root} onLayout={onLayoutRoot}>
      <StatusBar style="dark" />
      {/* The safe area wraps only the header, so it picks up the top (and, in
          landscape, side) inset while the tab content below runs all the way to
          the physical bottom edge. Each tab pads its own scroll content so the
          last row still clears the home indicator. */}
      <SafeAreaView style={styles.header}>
        <View style={styles.tabBar}>
          <TabBtn label="Builder" active={tab === 'builder'} onPress={() => setTab('builder')} />
          <TabBtn label="Decoder" active={tab === 'decoder'} onPress={() => setTab('decoder')} />
          <TabBtn label="Settings" active={tab === 'settings'} onPress={() => setTab('settings')} />
        </View>
      </SafeAreaView>
      <View
        style={[styles.tabContent, tab !== 'builder' && styles.tabHidden]}
        accessibilityElementsHidden={tab !== 'builder'}
        importantForAccessibility={tab === 'builder' ? 'auto' : 'no-hide-descendants'}
      >
        <BuilderTab
          token={token}
          onForecastReceived={onForecastReceived}
          active={tab === 'builder'}
          device={device}
          onDeviceChange={setDevice}
          twoMessages={twoMessages}
          onTwoMessagesChange={setTwoMessages}
          aqiScale={aqiScale}
          units={units}
        />
      </View>
      <View
        style={[styles.tabContent, tab !== 'decoder' && styles.tabHidden]}
        accessibilityElementsHidden={tab !== 'decoder'}
        importantForAccessibility={tab === 'decoder' ? 'auto' : 'no-hide-descendants'}
      >
        <DecoderTab token={token} forecastData={forecastData} onForecastDataChange={setForecastData} units={units} timeFormat={timeFormat} active={tab === 'decoder'} />
      </View>
      <View
        style={[styles.tabContent, tab !== 'settings' && styles.tabHidden]}
        accessibilityElementsHidden={tab !== 'settings'}
        importantForAccessibility={tab === 'settings' ? 'auto' : 'no-hide-descendants'}
      >
        <SettingsTab
          onDeleteAccount={handleDeleteAccount}
          units={units}
          onUnitsChange={setUnits}
          timeFormat={timeFormat}
          onTimeFormatChange={setTimeFormat}
          aqiScale={aqiScale}
          onAqiScaleChange={setAqiScale}
        />
      </View>
    </View>
  );
}

function TabBtn({ label, active, onPress }: { label: string; active: boolean; onPress: () => void }) {
  return (
    <TouchableOpacity style={[styles.tab, active && styles.tabActive]} onPress={onPress} activeOpacity={0.7}>
      <Text style={[styles.tabText, active && styles.tabTextActive]}>{label}</Text>
    </TouchableOpacity>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: '#f2f2f7' },
  // Empty safe area: lays out to exactly the top inset, nothing more.
  topInset: { backgroundColor: '#f2f2f7' },
  header: { backgroundColor: '#f2f2f7' },
  tabBar: {
    flexDirection: 'row',
    backgroundColor: '#fff',
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: '#d1d1d6',
  },
  tab: {
    flex: 1,
    paddingVertical: 12,
    alignItems: 'center',
    borderBottomWidth: 2,
    borderBottomColor: 'transparent',
  },
  tabActive: { borderBottomColor: '#2a6bb5' },
  tabText: { fontSize: 15, fontWeight: '500', color: '#8e8e93' },
  tabTextActive: { color: '#2a6bb5' },
  tabContent: { flex: 1 },
  tabHidden: { display: 'none' },
});
