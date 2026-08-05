import { useState } from 'react';
import {
  StyleSheet, Text, View, ScrollView, TouchableOpacity, ActivityIndicator, Alert, Linking,
} from 'react-native';
import * as Clipboard from 'expo-clipboard';
import { createAccount } from './account';
import UnitsToggle from './UnitsToggle';
import type { TimeFormat, Units } from './settings';

const FORECAST_NUMBER = '(425) 434-5858';
const TERMS_URL = 'https://going.blue/terms';
const PRIVACY_URL = 'https://going.blue/privacy';
// Opening the hosted vCard hands the user off to the system's own "add contact" flow, so the
// app needs no Contacts permission. Earthmate reads the phone's contacts, which is what makes
// the number reachable from the inReach without typing it out.
const CONTACT_VCF_URL = 'https://going.blue/contact.vcf';

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
  const [numCopied, setNumCopied] = useState(false);

  async function copyNumber() {
    await Clipboard.setStringAsync(FORECAST_NUMBER);
    setNumCopied(true);
    setTimeout(() => setNumCopied(false), 2000);
  }

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
      <Text style={styles.tagline}>
        Going Blue is a weather app built for text message and satellite.
      </Text>

      {/* Getting started */}
      <Text style={styles.gsHeading}>Getting started</Text>

      <Step n={1} title="Add Going Blue as a contact">
        <TouchableOpacity
          style={styles.contactBtn}
          onPress={() => Linking.openURL(CONTACT_VCF_URL)}
          activeOpacity={0.7}
        >
          <Text style={styles.contactBtnText}>Save contact card</Text>
        </TouchableOpacity>
        <View style={styles.numberRow}>
          <Text style={styles.number} selectable>{FORECAST_NUMBER}</Text>
          <TouchableOpacity
            style={[styles.copyBtn, numCopied && styles.copyBtnSuccess]}
            onPress={copyNumber}
            activeOpacity={0.7}
          >
            <Text style={[styles.copyBtnText, numCopied && styles.copyBtnSuccessText]}>
              {numCopied ? '✓ Copied' : 'Copy'}
            </Text>
          </TouchableOpacity>
        </View>
      </Step>
      <Step n={2} title="Build a forecast request">
        <Text style={styles.gsPara}>
          On the <Bold>Builder</Bold> tab, choose your location, weather model, and variables.
        </Text>
      </Step>
      <Step n={3} title="Send the request to Going Blue">
        <Text style={styles.gsPara}>
          Send the request via SMS, Garmin inReach, ZOLEO, or any other satellite messenger.
        </Text>
      </Step>
      <Step n={4} title="View the forecast">
        <Text style={styles.gsPara}>
          Copy the reply into the <Bold>Decoder</Bold> tab to visualize the forecast.
        </Text>
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

// Children render straight into the step body rather than inside a Text, so a step can carry
// controls (step 1's contact card and number) alongside its prose.
function Step({ n, title, children }: { n: number; title: string; children: React.ReactNode }) {
  return (
    <View style={styles.step}>
      <View style={styles.stepNum}>
        <Text style={styles.stepNumText}>{n}</Text>
      </View>
      <View style={styles.stepBody}>
        <Text style={styles.stepTitle}>{title}</Text>
        {children}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  scroll: { flex: 1, backgroundColor: '#f2f2f7' },
  content: { padding: 24, paddingTop: 48, paddingBottom: 72 },
  brand: { fontSize: 30, fontWeight: '700', color: '#2a6bb5', marginBottom: 8 },
  tagline: { fontSize: 15, color: '#3a3a3c', lineHeight: 21, marginBottom: 24 },
  label: { fontSize: 12, fontWeight: '600', color: '#6e6e73', textTransform: 'uppercase', letterSpacing: 0.5, marginTop: 24, marginBottom: 8 },
  consentNote: { fontSize: 13, color: '#6e6e73', lineHeight: 19, marginTop: 24, marginBottom: 16 },
  legalLinks: { fontSize: 13, color: '#6e6e73', marginBottom: 24 },
  link: { color: '#2a6bb5', fontWeight: '500' },

  contactBtn: { backgroundColor: '#2a6bb5', borderRadius: 10, paddingVertical: 11, alignItems: 'center', marginTop: 2 },
  contactBtnText: { color: '#fff', fontSize: 15, fontWeight: '600' },
  numberRow: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    backgroundColor: '#fff', borderRadius: 10, paddingLeft: 14, paddingRight: 8,
    paddingVertical: 8, marginTop: 8, marginBottom: 12,
  },
  number: { fontSize: 16, fontWeight: '600', color: '#1c1c1e', fontFamily: 'Courier' },
  copyBtn: { backgroundColor: '#eef3fa', borderRadius: 8, paddingHorizontal: 16, paddingVertical: 7 },
  copyBtnText: { color: '#2a6bb5', fontSize: 14, fontWeight: '600' },
  copyBtnSuccess: { backgroundColor: '#e8f5ec' },
  copyBtnSuccessText: { color: '#2a8f5a' },

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
  stepBody: { flex: 1 },
  stepNum: { width: 24, height: 24, borderRadius: 12, backgroundColor: '#2a6bb5', alignItems: 'center', justifyContent: 'center', marginTop: 1 },
  stepNumText: { color: '#fff', fontSize: 13, fontWeight: '700' },
  stepTitle: { fontSize: 15, fontWeight: '600', color: '#1c1c1e', marginBottom: 4 },
});
