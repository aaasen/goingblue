import { useState } from 'react';
import {
  StyleSheet, Text, View, ScrollView, TouchableOpacity, ActivityIndicator, Alert, Linking,
} from 'react-native';
import { createAccount } from './account';
import UnitsToggle from './UnitsToggle';
import type { TimeFormat, Units } from './settings';

const FORECAST_EMAIL = 'inreach@going.blue';
const TERMS_URL = 'https://going.blue/terms';
const PRIVACY_URL = 'https://going.blue/privacy';

interface Props {
  // Called with the provisioned token once setup completes; the token is already persisted.
  onReady: (token: string) => void;
  units: Units;
  onUnitsChange: (u: Units) => void;
  timeFormat: TimeFormat;
  onTimeFormatChange: (format: TimeFormat) => void;
}

// First-run gate. The account token identifies the user for usage limits and is created once,
// here, over normal internet — not over satellite.
export default function SetupScreen({ onReady, units, onUnitsChange, timeFormat, onTimeFormatChange }: Props) {
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
      <Text style={styles.brand}>Going Blue</Text>

      {/* Getting started */}
      <Text style={styles.gsHeading}>Getting started</Text>

      <Step n={1} title="Build a forecast request">
        On the <Bold>Builder</Bold> tab, choose your location, weather model, and variables.
      </Step>
      <Step n={2} title="Send the request to Going Blue">
        Copy the request and email it to{' '}
        <Text style={styles.bold} selectable>{FORECAST_EMAIL}</Text>{' '}
        from your Garmin inReach.
      </Step>
      <Step n={3} title="View the forecast">
        Copy the forecast response into the <Bold>Decoder</Bold> tab to visualize the forecast.
      </Step>

      <Text style={styles.label}>Preferences</Text>
      <View style={styles.preferencesCard}>
        <View style={styles.preferenceRow}>
          <Text style={styles.preferenceLabel}>Units</Text>
          <UnitsToggle units={units} onChange={onUnitsChange} />
        </View>
        <View style={[styles.preferenceRow, styles.preferenceRowSpacing]}>
          <Text style={styles.preferenceLabel}>Time format</Text>
          <View style={styles.toggle}>
            {(['12h', '24h'] as const).map((format) => (
              <TouchableOpacity
                key={format}
                style={[styles.toggleBtn, timeFormat === format && styles.toggleBtnActive]}
                onPress={() => onTimeFormatChange(format)}
                activeOpacity={0.7}
              >
                <Text style={[styles.toggleText, timeFormat === format && styles.toggleTextActive]}>{format}</Text>
              </TouchableOpacity>
            ))}
          </View>
        </View>
      </View>

      <Text style={styles.consentNote}>
        When you send a forecast request to Going Blue, you agree to receive a reply with that
        forecast. Going Blue only ever replies to requests you send — it sends no marketing,
        recurring, or other unsolicited messages. Message and data rates may apply; reply STOP
        to opt out, HELP for help.
      </Text>

      <Text style={styles.legalLinks}>
        <Text style={styles.link} onPress={() => Linking.openURL(TERMS_URL)}>Terms &amp; Conditions</Text>
        {'   ·   '}
        <Text style={styles.link} onPress={() => Linking.openURL(PRIVACY_URL)}>Privacy Policy</Text>
      </Text>

      <TouchableOpacity
        style={[styles.btn, styles.btnPrimary, busy && styles.btnDisabled]}
        onPress={handleStart}
        disabled={busy}
      >
        {busy ? <ActivityIndicator color="#fff" /> : <Text style={styles.btnPrimaryText}>Start</Text>}
      </TouchableOpacity>
    </ScrollView>
  );
}

function Bold({ children }: { children: React.ReactNode }) {
  return <Text style={styles.bold}>{children}</Text>;
}

function Step({ n, title, children }: { n: number; title: string; children: React.ReactNode }) {
  return (
    <View style={styles.step}>
      <View style={styles.stepNum}>
        <Text style={styles.stepNumText}>{n}</Text>
      </View>
      <View style={{ flex: 1 }}>
        <Text style={styles.stepTitle}>{title}</Text>
        <Text style={styles.gsPara}>{children}</Text>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  scroll: { flex: 1, backgroundColor: '#f2f2f7' },
  content: { padding: 24, paddingTop: 48 },
  brand: { fontSize: 30, fontWeight: '700', color: '#2a6bb5', marginBottom: 20 },
  label: { fontSize: 12, fontWeight: '600', color: '#6e6e73', textTransform: 'uppercase', letterSpacing: 0.5, marginTop: 24, marginBottom: 8 },
  consentNote: { fontSize: 13, color: '#6e6e73', lineHeight: 19, marginTop: 24, marginBottom: 16 },
  legalLinks: { fontSize: 13, color: '#6e6e73', marginBottom: 24 },
  link: { color: '#2a6bb5', fontWeight: '500' },

  btn: { height: 50, borderRadius: 14, alignItems: 'center', justifyContent: 'center' },
  btnPrimary: { backgroundColor: '#2a6bb5' },
  btnDisabled: { backgroundColor: '#aeaeb2' },
  btnPrimaryText: { color: '#fff', fontSize: 16, fontWeight: '600' },

  preferencesCard: { backgroundColor: '#fff', borderRadius: 12, padding: 14, marginBottom: 20 },
  preferenceRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  preferenceRowSpacing: { marginTop: 14 },
  preferenceLabel: { fontSize: 13, fontWeight: '600', color: '#3a3a3c' },
  toggle: { flexDirection: 'row', alignSelf: 'flex-start', backgroundColor: '#e5e5ea', borderRadius: 8, padding: 2 },
  toggleBtn: { paddingHorizontal: 20, paddingVertical: 6, borderRadius: 6 },
  toggleBtnActive: { backgroundColor: '#fff' },
  toggleText: { fontSize: 13, color: '#6e6e73', fontWeight: '500' },
  toggleTextActive: { color: '#1c1c1e' },

  gsHeading: { fontSize: 13, fontWeight: '700', color: '#8e8e93', textTransform: 'uppercase', letterSpacing: 0.5, marginBottom: 12 },
  gsPara: { fontSize: 14, color: '#3a3a3c', lineHeight: 21, marginBottom: 12 },
  bold: { fontWeight: '700', color: '#1c1c1e' },
  step: { flexDirection: 'row', gap: 12, marginBottom: 4 },
  stepNum: { width: 24, height: 24, borderRadius: 12, backgroundColor: '#2a6bb5', alignItems: 'center', justifyContent: 'center', marginTop: 1 },
  stepNumText: { color: '#fff', fontSize: 13, fontWeight: '700' },
  stepTitle: { fontSize: 15, fontWeight: '600', color: '#1c1c1e', marginBottom: 4 },
});
