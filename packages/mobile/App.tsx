import { useEffect, useState } from 'react';
import { View, Text, TouchableOpacity, StyleSheet, SafeAreaView, ActivityIndicator } from 'react-native';
import { StatusBar } from 'expo-status-bar';
import BuilderTab from './BuilderTab';
import DecoderTab from './DecoderTab';
import SettingsTab from './SettingsTab';
import SetupScreen from './SetupScreen';
import { loadToken, clearToken } from './account';
import { loadTimeFormat, loadUnits, saveTimeFormat, saveUnits, type TimeFormat, type Units } from './settings';

type Tab = 'builder' | 'decoder' | 'settings';

export default function App() {
  const [tab, setTab] = useState<Tab>('builder');
  const [forecastData, setForecastData] = useState('');
  // undefined = still loading from storage; null = no account yet (show setup); string = ready.
  const [token, setToken] = useState<string | null | undefined>(undefined);
  const [units, setUnitsState] = useState<Units>('metric');
  const [timeFormat, setTimeFormatState] = useState<TimeFormat>('24h');

  useEffect(() => {
    loadToken().then(setToken);
    loadUnits().then(setUnitsState);
    loadTimeFormat().then(setTimeFormatState);
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

  function onForecastReceived(encoded: string) {
    setForecastData(encoded);
    setTab('decoder');
  }

  async function handleReset() {
    await clearToken();
    setForecastData('');
    setTab('builder');
    setToken(null);
  }

  if (token === undefined) {
    return (
      <SafeAreaView style={styles.safe}>
        <StatusBar style="dark" />
        <View style={styles.loading}><ActivityIndicator color="#2a6bb5" /></View>
      </SafeAreaView>
    );
  }

  if (token === null) {
    return (
      <SafeAreaView style={styles.safe}>
        <StatusBar style="dark" />
        <SetupScreen
          onReady={setToken}
          units={units}
          onUnitsChange={setUnits}
          timeFormat={timeFormat}
          onTimeFormatChange={setTimeFormat}
        />
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView style={styles.safe}>
      <StatusBar style="dark" />
      <View style={styles.tabBar}>
        <TabBtn label="Builder" active={tab === 'builder'} onPress={() => setTab('builder')} />
        <TabBtn label="Decoder" active={tab === 'decoder'} onPress={() => setTab('decoder')} />
        <TabBtn label="Settings" active={tab === 'settings'} onPress={() => setTab('settings')} />
      </View>
      <View
        style={[styles.tabContent, tab !== 'builder' && styles.tabHidden]}
        accessibilityElementsHidden={tab !== 'builder'}
        importantForAccessibility={tab === 'builder' ? 'auto' : 'no-hide-descendants'}
      >
        <BuilderTab token={token} onForecastReceived={onForecastReceived} active={tab === 'builder'} />
      </View>
      <View
        style={[styles.tabContent, tab !== 'decoder' && styles.tabHidden]}
        accessibilityElementsHidden={tab !== 'decoder'}
        importantForAccessibility={tab === 'decoder' ? 'auto' : 'no-hide-descendants'}
      >
        <DecoderTab token={token} forecastData={forecastData} onForecastDataChange={setForecastData} units={units} timeFormat={timeFormat} />
      </View>
      <View
        style={[styles.tabContent, tab !== 'settings' && styles.tabHidden]}
        accessibilityElementsHidden={tab !== 'settings'}
        importantForAccessibility={tab === 'settings' ? 'auto' : 'no-hide-descendants'}
      >
        <SettingsTab token={token} onReset={handleReset} units={units} onUnitsChange={setUnits} timeFormat={timeFormat} onTimeFormatChange={setTimeFormat} />
      </View>
    </SafeAreaView>
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
  safe: { flex: 1, backgroundColor: '#f2f2f7' },
  loading: { flex: 1, alignItems: 'center', justifyContent: 'center' },
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
