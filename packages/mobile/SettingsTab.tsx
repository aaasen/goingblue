import { useState } from 'react';
import { ActivityIndicator, StyleSheet, Text, View, ScrollView, Linking, TouchableOpacity, Alert } from 'react-native';
import PreferenceRows from './PreferenceRows';
import type { AqiScale, TimeFormat, Units } from './settings';

const TERMS_URL = 'https://going.blue/terms';
const PRIVACY_URL = 'https://going.blue/privacy';

export default function SettingsTab({
  onDeleteAccount, units, onUnitsChange, timeFormat, onTimeFormatChange, aqiScale, onAqiScaleChange,
}: {
  onDeleteAccount: () => Promise<void>;
  units: Units;
  onUnitsChange: (u: Units) => void;
  timeFormat: TimeFormat;
  onTimeFormatChange: (format: TimeFormat) => void;
  aqiScale: AqiScale;
  onAqiScaleChange: (scale: AqiScale) => void;
}) {
  const [deleting, setDeleting] = useState(false);

  const DELETE_MESSAGE =
    'This erases your account and clears your saved forecasts, then returns to setup. ' +
    'Neither can be recovered.';

  // Deletion needs the network, so it can fail. Say so and leave the account intact rather than
  // clearing the app locally — the token is the only handle on the account, and a device that
  // has forgotten it can never delete what it left behind.
  async function runDelete() {
    setDeleting(true);
    try {
      await onDeleteAccount();
    } catch {
      Alert.alert(
        'Couldn’t delete account',
        'Your account is unchanged. Check your connection and try again.',
      );
    } finally {
      setDeleting(false);
    }
  }

  function confirmDelete() {
    Alert.alert('Delete account?', DELETE_MESSAGE, [
      { text: 'Cancel', style: 'cancel' },
      { text: 'Delete', style: 'destructive', onPress: runDelete },
    ]);
  }

  return (
    <ScrollView style={styles.scroll} contentContainerStyle={styles.content}>
      {/* Preferences */}
      <Text style={styles.heading}>Preferences</Text>
      <View style={styles.card}>
        <PreferenceRows
          units={units}
          onUnitsChange={onUnitsChange}
          timeFormat={timeFormat}
          onTimeFormatChange={onTimeFormatChange}
          aqiScale={aqiScale}
          onAqiScaleChange={onAqiScaleChange}
        />
      </View>

      {/* Account */}
      <Text style={[styles.heading, { marginTop: 28 }]}>Account</Text>
      <Text style={styles.sectionNote}>
        Your account is an anonymous token — no name, email, or phone number. Deleting it removes
        it from our servers.
      </Text>
      <TouchableOpacity
        style={[styles.resetBtn, deleting && styles.resetBtnDisabled]}
        onPress={confirmDelete}
        disabled={deleting}
        activeOpacity={0.7}
      >
        {deleting
          ? <ActivityIndicator color="#cc2222" />
          : <Text style={styles.resetBtnText}>Delete account</Text>}
      </TouchableOpacity>

      <Text style={styles.footer}>
        Weather data provided by{' '}
        <Text style={styles.link} onPress={() => Linking.openURL('https://open-meteo.com/')}>
          Open-Meteo
        </Text>.
      </Text>

      <Text style={styles.legalLinks}>
        <Text style={styles.link} onPress={() => Linking.openURL(TERMS_URL)}>Terms &amp; Conditions</Text>
        {'   ·   '}
        <Text style={styles.link} onPress={() => Linking.openURL(PRIVACY_URL)}>Privacy Policy</Text>
      </Text>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  scroll: { flex: 1, backgroundColor: '#f2f2f7' },
  // Bottom pad covers the home-indicator inset the scroll view now extends under.
  content: { padding: 16, paddingBottom: 72 },

  heading: { fontSize: 13, fontWeight: '700', color: '#8e8e93', textTransform: 'uppercase', letterSpacing: 0.5, marginBottom: 12 },
  link: { color: '#2a6bb5', textDecorationLine: 'underline' },

  card: { backgroundColor: '#fff', borderRadius: 12, padding: 14, marginBottom: 12 },
  // Full-width destructive action, sitting on its own under the account note. Height is fixed so
  // swapping the label for a spinner mid-delete doesn't make the row jump.
  resetBtn: { backgroundColor: '#fff', borderRadius: 12, height: 48, alignItems: 'center', justifyContent: 'center', marginTop: 4 },
  resetBtnDisabled: { opacity: 0.6 },
  resetBtnText: { color: '#cc2222', fontSize: 15, fontWeight: '600' },
  sectionNote: { fontSize: 13, color: '#6e6e73', lineHeight: 19, marginTop: -4, marginBottom: 10 },
  footer: { fontSize: 13, color: '#8e8e93', marginTop: 20, lineHeight: 19 },
  legalLinks: { fontSize: 13, color: '#8e8e93', marginTop: 12, lineHeight: 19 },
});
