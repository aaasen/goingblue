import { useState } from 'react';
import {
  StyleSheet, Text, View, ScrollView, TouchableOpacity, ActivityIndicator, TextInput, Alert,
} from 'react-native';
import { isValidToken, normalizeToken } from '@weather/protocol';
import { createAccount, saveToken, verifyAccount } from './account';

interface Props {
  // Called with the provisioned token once setup completes; the token is already persisted.
  onReady: (token: string) => void;
}

// First-run gate. The account token identifies the user for usage limits and is created once,
// here, over normal internet — not over satellite. Users either mint a new account or import
// an existing token when moving to a new device.
export default function SetupScreen({ onReady }: Props) {
  const [busy, setBusy] = useState(false);
  const [importing, setImporting] = useState(false);
  const [entry, setEntry] = useState('');

  // A local check-symbol test gates the Import button so an obvious typo never reaches the
  // server (and can't resolve to someone else's account).
  const entryValid = isValidToken(entry);

  async function handleCreate() {
    setBusy(true);
    try {
      const token = await createAccount();
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
      <Text style={styles.title}>Set up your account</Text>
      <Text style={styles.para}>
        Going Blue uses an account token to identify you for usage limits. It’s created once and
        stored on this device — there’s no password or sign-in. Keep it somewhere safe so you can
        move your account to a new device later.
      </Text>

      {!importing ? (
        <>
          <TouchableOpacity
            style={[styles.btn, styles.btnPrimary, busy && styles.btnDisabled]}
            onPress={handleCreate}
            disabled={busy}
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
            placeholder="XXXX-XXXX-XXXX-XX"
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

const styles = StyleSheet.create({
  scroll: { flex: 1, backgroundColor: '#f2f2f7' },
  content: { padding: 24, paddingTop: 48 },
  title: { fontSize: 24, fontWeight: '700', color: '#1c1c1e', marginBottom: 12 },
  para: { fontSize: 15, color: '#3a3a3c', lineHeight: 22, marginBottom: 28 },
  label: { fontSize: 12, fontWeight: '600', color: '#6e6e73', textTransform: 'uppercase', letterSpacing: 0.5, marginBottom: 8 },
  input: {
    backgroundColor: '#fff', borderRadius: 12, padding: 14, fontSize: 16,
    fontFamily: 'Courier', color: '#1c1c1e', marginBottom: 16,
    borderWidth: StyleSheet.hairlineWidth, borderColor: '#d1d1d6',
  },
  btn: { height: 50, borderRadius: 14, alignItems: 'center', justifyContent: 'center' },
  btnPrimary: { backgroundColor: '#2a6bb5' },
  btnDisabled: { backgroundColor: '#aeaeb2' },
  btnPrimaryText: { color: '#fff', fontSize: 16, fontWeight: '600' },
  linkBtn: { alignItems: 'center', paddingVertical: 16 },
  linkText: { color: '#2a6bb5', fontSize: 15, fontWeight: '500' },
});
