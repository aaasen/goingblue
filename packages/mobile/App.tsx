import { useState } from 'react';
import { View, Text, TouchableOpacity, StyleSheet, SafeAreaView } from 'react-native';
import { StatusBar } from 'expo-status-bar';
import BuilderTab from './BuilderTab';
import DecoderTab from './DecoderTab';

type Tab = 'builder' | 'decoder';

export default function App() {
  const [tab, setTab] = useState<Tab>('builder');
  const [forecastData, setForecastData] = useState('');

  function onForecastReceived(encoded: string) {
    setForecastData(encoded);
    setTab('decoder');
  }

  return (
    <SafeAreaView style={styles.safe}>
      <StatusBar style="dark" />
      <View style={styles.tabBar}>
        <TabBtn label="Builder" active={tab === 'builder'} onPress={() => setTab('builder')} />
        <TabBtn label="Decoder" active={tab === 'decoder'} onPress={() => setTab('decoder')} />
      </View>
      {tab === 'builder' ? (
        <BuilderTab onForecastReceived={onForecastReceived} />
      ) : (
        <DecoderTab forecastData={forecastData} onForecastDataChange={setForecastData} />
      )}
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
