import { useState } from 'react';
import {
  StyleSheet, Text, View, ScrollView, TouchableOpacity, ActivityIndicator, Alert, Linking, Image,
} from 'react-native';
import { createAccount } from './account';
import GettingStarted from './GettingStarted';
import PreferenceRows from './PreferenceRows';
import type { AqiScale, TimeFormat, UnitPrefs } from './settings';
import { palette } from './palette';

const TERMS_URL = 'https://going.blue/terms';
const PRIVACY_URL = 'https://going.blue/privacy';

interface Props {
  // Called with the provisioned token once setup completes; the token is already persisted.
  onReady: (token: string) => void;
  units: UnitPrefs;
  onUnitsChange: (u: UnitPrefs) => void;
  timeFormat: TimeFormat;
  onTimeFormatChange: (format: TimeFormat) => void;
  aqiScale: AqiScale;
  onAqiScaleChange: (scale: AqiScale) => void;
}

// First-run gate. The account token identifies the user for usage limits and is created once,
// here, over normal internet — not over satellite.
export default function SetupScreen({
  onReady, units, onUnitsChange, timeFormat, onTimeFormatChange, aqiScale, onAqiScaleChange,
}: Props) {
  const [busy, setBusy] = useState(false);

  async function handleStart() {
    setBusy(true);
    try {
      const token = await createAccount();
      onReady(token);
    } catch (e) {
      Alert.alert('Could not start', String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <ScrollView style={styles.scroll} contentContainerStyle={styles.content}>
      <Image source={require('./assets/icon.png')} style={styles.icon} />
      <Text style={styles.brand}>Going Blue</Text>
      <Text style={styles.tagline}>Weather forecasts over satellite and SMS</Text>

      {/* The same explanation the help sheet shows, so first run gets it without
          hunting for the help link. */}
      <GettingStarted />

      <Text style={styles.label}>Preferences</Text>
      <View style={styles.preferencesCard}>
        <PreferenceRows
          units={units}
          onUnitsChange={onUnitsChange}
          timeFormat={timeFormat}
          onTimeFormatChange={onTimeFormatChange}
          aqiScale={aqiScale}
          onAqiScaleChange={onAqiScaleChange}
        />
      </View>

      <TouchableOpacity
        style={[styles.btn, styles.btnPrimary, busy && styles.btnDisabled]}
        onPress={handleStart}
        disabled={busy}
      >
        {busy ? <ActivityIndicator color={palette.onPrimary} /> : <Text style={styles.btnPrimaryText}>Start</Text>}
      </TouchableOpacity>

      <Text style={styles.legalLinks}>
        <Text style={styles.link} onPress={() => Linking.openURL(TERMS_URL)}>Terms &amp; Conditions</Text>
        {'   ·   '}
        <Text style={styles.link} onPress={() => Linking.openURL(PRIVACY_URL)}>Privacy Policy</Text>
      </Text>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  scroll: { flex: 1, backgroundColor: palette.page },
  content: { padding: 24, paddingTop: 48, paddingBottom: 72 },
  // Rounded like the home-screen icon it is. 96pt from a 1024px source, so it stays crisp at 3x.
  icon: { width: 96, height: 96, borderRadius: 22, alignSelf: 'center', marginBottom: 14 },
  brand: { fontSize: 30, fontWeight: '700', color: palette.brand, marginBottom: 8, textAlign: 'center' },
  tagline: { fontSize: 15, color: palette.pageText, lineHeight: 21, marginBottom: 24, textAlign: 'center' },
  label: { fontSize: 12, fontWeight: '600', color: palette.pageLabel, textTransform: 'uppercase', letterSpacing: 0.5, marginTop: 24, marginBottom: 8 },
  legalLinks: { fontSize: 13, color: palette.pageNote, marginTop: 20, textAlign: 'center' },
  link: { color: palette.pageLink, fontWeight: '500' },

  btn: { height: 50, borderRadius: 14, alignItems: 'center', justifyContent: 'center' },
  btnPrimary: { backgroundColor: palette.primary },
  btnDisabled: { backgroundColor: palette.primaryDisabled },
  btnPrimaryText: { color: palette.onPrimary, fontSize: 16, fontWeight: '600' },

  preferencesCard: { backgroundColor: palette.card, borderRadius: 12, padding: 14, marginBottom: 20 },
});
