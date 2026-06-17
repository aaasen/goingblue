import { useState } from 'react';
import {
  StyleSheet, Text, View, ScrollView, TouchableOpacity, ActivityIndicator, TextInput, Alert,
} from 'react-native';
import { isValidToken, normalizeToken } from '@weather/protocol';
import { createAccount, saveToken, verifyAccount } from './account';
import UnitsToggle from './UnitsToggle';
import type { Units } from './settings';

const FORECAST_SMS = '+1 (425) 434-5858';

interface Props {
  // Called with the provisioned token once setup completes; the token is already persisted.
  onReady: (token: string) => void;
  units: Units;
  onUnitsChange: (u: Units) => void;
}

// First-run gate. The account token identifies the user for usage limits and is created once,
// here, over normal internet — not over satellite. Users either mint a new account or import
// an existing token when moving to a new device.
export default function SetupScreen({ onReady, units, onUnitsChange }: Props) {
  const [busy, setBusy] = useState(false);
  const [importing, setImporting] = useState(false);
  const [entry, setEntry] = useState('');
  const [smsConsent, setSmsConsent] = useState(false);

  // A local shape check (length + alphabet) gates the Import button so an obviously malformed
  // token never reaches the server.
  const entryValid = isValidToken(entry);

  async function handleCreate() {
    if (!smsConsent) return;
    setBusy(true);
    try {
      const token = await createAccount(smsConsent);
      onReady(token);
    } catch (e) {
      Alert.alert('Could not create account', String(e));
    } finally {
      setBusy(false);
    }
  }

  async function handleImport() {
    if (!entryValid) return;
    setBusy(true);
    try {
      const exists = await verifyAccount(entry);
      if (!exists) {
        Alert.alert('Token not found', 'That token is well-formed but not registered. Check it and try again.');
        return;
      }
      await saveToken(entry);
      onReady(normalizeToken(entry));
    } catch (e) {
      Alert.alert('Could not verify token', String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <ScrollView style={styles.scroll} contentContainerStyle={styles.content}>
      <Text style={styles.brand}>Going Blue</Text>

      {/* Getting started */}
      <Text style={styles.gsHeading}>Getting started</Text>
      <Text style={styles.gsPara}>
        This app uses a custom weather forecast encoding to pack as much weather data as possible
        into each satellite message.
      </Text>

      <Step n={1} title="Build a forecast request">
        On the <Bold>Builder</Bold> tab, choose your location, weather model, and variables. Each
        message is limited to 160 characters, so you may need to reduce the number of variables or
        the resolution to fit within the limit.
      </Step>
      <Step n={2} title="Send it">
        Copy the request and text it to{' '}
        <Text style={styles.bold} selectable>{FORECAST_SMS}</Text>{' '}
        from the Garmin Messenger app on your inReach device.
      </Step>
      <Step n={3} title="View forecast">
        When you receive a response, copy it and paste it into the <Bold>Decoder</Bold> tab to
        visualize the forecast. Decoded forecasts are cached on your device so you can revisit them
        offline under “Past forecasts.”
      </Step>

      <Text style={styles.title}>Set up your account</Text>
      <Text style={styles.para}>
        Going Blue uses an account token to identify you for usage limits. It’s created once and
        stored on this device — there’s no password or sign-in. Keep it somewhere safe so you can
        move your account to a new device later.
      </Text>

      {!importing ? (
        <>
          <Text style={styles.label}>Units</Text>
          <View style={styles.unitsRow}>
            <UnitsToggle units={units} onChange={onUnitsChange} />
          </View>
          <Checkbox checked={smsConsent} onToggle={() => setSmsConsent((v) => !v)} disabled={busy}>
            I agree to receive text messages from Going Blue, including forecast replies and
            account notifications. Message and data rates may apply; reply STOP to opt out.
          </Checkbox>
          <TouchableOpacity
            style={[styles.btn, styles.btnPrimary, (busy || !smsConsent) && styles.btnDisabled]}
            onPress={handleCreate}
            disabled={busy || !smsConsent}
          >
            {busy ? <ActivityIndicator color="#fff" /> : <Text style={styles.btnPrimaryText}>Create account</Text>}
          </TouchableOpacity>
          <TouchableOpacity style={styles.linkBtn} onPress={() => setImporting(true)} disabled={busy}>
            <Text style={styles.linkText}>I already have a token</Text>
          </TouchableOpacity>
        </>
      ) : (
        <>
          <Text style={styles.label}>Enter your token</Text>
          <TextInput
            style={styles.input}
            value={entry}
            onChangeText={setEntry}
            placeholder="XXXX-XXXX-XXXX-XXXX"
            autoCapitalize="characters"
            autoCorrect={false}
            editable={!busy}
          />
          <TouchableOpacity
            style={[styles.btn, styles.btnPrimary, (!entryValid || busy) && styles.btnDisabled]}
            onPress={handleImport}
            disabled={!entryValid || busy}
          >
            {busy ? <ActivityIndicator color="#fff" /> : <Text style={styles.btnPrimaryText}>Import account</Text>}
          </TouchableOpacity>
          <TouchableOpacity style={styles.linkBtn} onPress={() => setImporting(false)} disabled={busy}>
            <Text style={styles.linkText}>Create a new account instead</Text>
          </TouchableOpacity>
        </>
      )}
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

function Checkbox({ checked, onToggle, disabled, children }: {
  checked: boolean;
  onToggle: () => void;
  disabled?: boolean;
  children: React.ReactNode;
}) {
  return (
    <TouchableOpacity style={styles.consentRow} onPress={onToggle} disabled={disabled} activeOpacity={0.7}>
      <View style={[styles.box, checked && styles.boxChecked]}>
        {checked && <Text style={styles.boxCheck}>✓</Text>}
      </View>
      <Text style={styles.consentText}>{children}</Text>
    </TouchableOpacity>
  );
}

const styles = StyleSheet.create({
  scroll: { flex: 1, backgroundColor: '#f2f2f7' },
  content: { padding: 24, paddingTop: 48 },
  brand: { fontSize: 30, fontWeight: '700', color: '#2a6bb5', marginBottom: 20 },
  title: { fontSize: 22, fontWeight: '700', color: '#1c1c1e', marginTop: 32, marginBottom: 12 },
  para: { fontSize: 15, color: '#3a3a3c', lineHeight: 22, marginBottom: 28 },
  label: { fontSize: 12, fontWeight: '600', color: '#6e6e73', textTransform: 'uppercase', letterSpacing: 0.5, marginBottom: 8 },
  input: {
    backgroundColor: '#fff', borderRadius: 12, padding: 14, fontSize: 16,
    fontFamily: 'Courier', color: '#1c1c1e', marginBottom: 16,
    borderWidth: StyleSheet.hairlineWidth, borderColor: '#d1d1d6',
  },
  consentRow: { flexDirection: 'row', alignItems: 'flex-start', gap: 12, marginBottom: 20 },
  box: {
    width: 24, height: 24, borderRadius: 6, marginTop: 1,
    borderWidth: 1.5, borderColor: '#aeaeb2', backgroundColor: '#fff',
    alignItems: 'center', justifyContent: 'center',
  },
  boxChecked: { backgroundColor: '#2a6bb5', borderColor: '#2a6bb5' },
  boxCheck: { color: '#fff', fontSize: 15, fontWeight: '700' },
  consentText: { flex: 1, fontSize: 13, color: '#3a3a3c', lineHeight: 19 },

  btn: { height: 50, borderRadius: 14, alignItems: 'center', justifyContent: 'center' },
  btnPrimary: { backgroundColor: '#2a6bb5' },
  btnDisabled: { backgroundColor: '#aeaeb2' },
  btnPrimaryText: { color: '#fff', fontSize: 16, fontWeight: '600' },
  linkBtn: { alignItems: 'center', paddingVertical: 16 },
  linkText: { color: '#2a6bb5', fontSize: 15, fontWeight: '500' },

  unitsRow: { marginBottom: 20 },

  gsHeading: { fontSize: 13, fontWeight: '700', color: '#8e8e93', textTransform: 'uppercase', letterSpacing: 0.5, marginBottom: 12 },
  gsPara: { fontSize: 14, color: '#3a3a3c', lineHeight: 21, marginBottom: 12 },
  bold: { fontWeight: '700', color: '#1c1c1e' },
  step: { flexDirection: 'row', gap: 12, marginBottom: 4 },
  stepNum: { width: 24, height: 24, borderRadius: 12, backgroundColor: '#2a6bb5', alignItems: 'center', justifyContent: 'center', marginTop: 1 },
  stepNumText: { color: '#fff', fontSize: 13, fontWeight: '700' },
  stepTitle: { fontSize: 15, fontWeight: '600', color: '#1c1c1e', marginBottom: 4 },
});
