import { useCallback, useEffect, useState } from 'react';
import { View, StyleSheet } from 'react-native';
import { SafeAreaProvider, SafeAreaView } from 'react-native-safe-area-context';
import { StatusBar } from 'expo-status-bar';
import * as SplashScreen from 'expo-splash-screen';
import HomeScreen from './HomeScreen';
import SettingsScreen from './SettingsScreen';
import SetupScreen from './SetupScreen';
import { loadToken, clearToken, deleteAccount } from './account';
import { clearStore } from './cache';
import { removeAllPacks } from './packStore';
import {
  loadAqiScale, loadDevice, loadTimeFormat, loadTwoMessages, loadUnits,
  saveAqiScale, saveDevice, saveTimeFormat, saveTwoMessages, saveUnits, clearSettings,
  defaultUnitPrefs, type AqiScale, type TimeFormat, type UnitPrefs,
} from './settings';
import { DEFAULT_DEVICE, type Device } from './devices';
import { clearTileCache, configureTileCache } from './tileCache';
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
  const [aqiScale, setAqiScaleState] = useState<AqiScale>('us');
  // Belongs to the builder, but loaded here with the rest: the builder is the first thing on
  // screen, so reading it there would draw the action button as Get Forecast and rename it a
  // frame later. Behind the splash, the stored device is already in hand.
  const [device, setDeviceState] = useState<Device>(DEFAULT_DEVICE);
  // Loaded alongside the device, and for the same reason: it changes the builder's request, so
  // arriving late would mean the first request of a session could go out under the wrong budget.
  const [twoMessages, setTwoMessagesState] = useState(true);

  // Settled together rather than one at a time: the token decides which screen comes up, and the
  // preferences decide how it reads. Applying them as they land would draw the first screen in
  // metric/24h and correct it a moment later, in full view now that the splash waits for this.
  useEffect(() => {
    // Not awaited: the map's cache cap has no bearing on the first screen.
    configureTileCache();
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
  function setUnits(u: UnitPrefs) {
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
    setForecastData('');
    setUnitsState(defaultUnitPrefs('imperial'));
    setTimeFormatState('12h');
    setAqiScaleState('us');
    setDeviceState(DEFAULT_DEVICE);
    setTwoMessagesState(true);
    // The delete lives inside the Settings sheet; close it so Setup isn't hiding under it.
    setSettingsOpen(false);
    setToken(null);
  }

  // Still reading storage. Render nothing and let the splash stand in — it stays up until one of
  // the branches below lays out.
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
          forecastData={forecastData}
          onForecastDataChange={setForecastData}
          onOpenSettings={() => setSettingsOpen(true)}
        />
        <SettingsScreen
          visible={settingsOpen}
          onClose={() => setSettingsOpen(false)}
          onDeleteAccount={handleDeleteAccount}
          units={units}
          onUnitsChange={setUnits}
          timeFormat={timeFormat}
          onTimeFormatChange={setTimeFormat}
          aqiScale={aqiScale}
          onAqiScaleChange={setAqiScale}
        />
      </View>
    </SafeAreaProvider>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: palette.page },
  // Empty safe area: lays out to exactly the top inset, nothing more.
  topInset: { backgroundColor: palette.page },
});
