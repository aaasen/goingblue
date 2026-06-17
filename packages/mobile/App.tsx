import { useEffect, useState } from 'react';
import { View, Text, TouchableOpacity, StyleSheet, SafeAreaView, ActivityIndicator } from 'react-native';
import { StatusBar } from 'expo-status-bar';
import BuilderTab from './BuilderTab';
import DecoderTab from './DecoderTab';
import InfoTab from './InfoTab';
import SetupScreen from './SetupScreen';
import { loadToken } from './account';

type Tab = 'builder' | 'decoder' | 'info';

export default function App() {
  const [tab, setTab] = useState<Tab>('builder');
  const [forecastData, setForecastData] = useState('');
  // undefined = still loading from storage; null = no account yet (show setup); string = ready.
  const [token, setToken] = useState<string | null | undefined>(undefined);

  useEffect(() => {
    loadToken().then(setToken);
  }, []);

  function onForecastReceived(encoded: string) {
    setForecastData(encoded);
    setTab('decoder');
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
        <SetupScreen onReady={setToken} />
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView style={styles.safe}>
      <StatusBar style="dark" />
      <View style={styles.tabBar}>
        <TabBtn label="Builder" active={tab === 'builder'} onPress={() => setTab('builder')} />
        <TabBtn label="Decoder" active={tab === 'decoder'} onPress={() => setTab('decoder')} />
        <TabBtn label="Info" active={tab === 'info'} onPress={() => setTab('info')} />
      </View>
      {tab === 'builder' && <BuilderTab token={token} onForecastReceived={onForecastReceived} />}
      {tab === 'decoder' && (
        <DecoderTab forecastData={forecastData} onForecastDataChange={setForecastData} />
      )}
      {tab === 'info' && <InfoTab token={token} />}
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
});
