import { useState } from 'react';
import {
  ActivityIndicator, Alert, Linking, Modal, ScrollView, StyleSheet, Text,
  TouchableOpacity, View,
} from 'react-native';
import { SafeAreaProvider, SafeAreaView } from 'react-native-safe-area-context';
import MaterialCommunityIcons from '@expo/vector-icons/MaterialCommunityIcons';
import PreferenceRows from './PreferenceRows';
import OfflineMapsScreen, { downloadedPacks } from './OfflineMapsScreen';
import { downloadPack as storeDownloadPack, removePack as storeRemovePack, usePackState } from './packStore';
import { findPack } from './catalog';
import type { AqiScale, TimeFormat, UnitPrefs } from './settings';
import { palette } from './palette';

const TERMS_URL = 'https://going.blue/terms';
const PRIVACY_URL = 'https://going.blue/privacy';

// Settings, as a full-screen sheet off the header's gear — the same frame as HelpScreen.
export default function SettingsScreen({
  visible, onClose, onDeleteAccount, units, onUnitsChange, timeFormat, onTimeFormatChange,
  aqiScale, onAqiScaleChange,
}: {
  visible: boolean;
  onClose: () => void;
  onDeleteAccount: () => Promise<void>;
  units: UnitPrefs;
  onUnitsChange: (u: UnitPrefs) => void;
  timeFormat: TimeFormat;
  onTimeFormatChange: (format: TimeFormat) => void;
  aqiScale: AqiScale;
  onAqiScaleChange: (scale: AqiScale) => void;
}) {
  const [deleting, setDeleting] = useState(false);
  const [offlineMaps, setOfflineMaps] = useState(false);
  // The pack store owns the set: ids appear once both archives are on disk, and the map's
  // style rebuilds off the same subscription.
  const { installed: downloaded } = usePackState();
  const held = downloadedPacks(downloaded);

  function downloadPack(id: string) {
    const pack = findPack(id);
    if (!pack) return;
    storeDownloadPack(pack).catch(() => {
      Alert.alert(`Couldn’t download ${pack.name}`, 'Check your connection and try again.');
    });
  }
  function removePack(id: string) {
    storeRemovePack(id);
  }

  const DELETE_MESSAGE = 'This erases your data from the server and removes your saved forecasts, settings, and offline maps from this phone. Deletion is permanent.';

  // Deletion needs the network, so it can fail. Say so and leave the account intact rather than
  // clearing the app locally — the token is the only handle on the account, and a device that
  // has forgotten it can never delete what it left behind.
  async function runDelete() {
    setDeleting(true);
    try {
      await onDeleteAccount();
    } catch {
      Alert.alert(
        'Couldn’t delete your data',
        'Nothing was deleted. Check your connection and try again.',
      );
    } finally {
      setDeleting(false);
    }
  }

  function confirmDelete() {
    Alert.alert('Delete your data?', DELETE_MESSAGE, [
      { text: 'Cancel', style: 'cancel' },
      { text: 'Delete', style: 'destructive', onPress: runDelete },
    ]);
  }

  return (
    <Modal visible={visible} animationType="slide" presentationStyle="fullScreen" onRequestClose={onClose}>
      {/* A Modal is its own window, so the provider at the app root is not above it in the native
          tree, and the safe-area view reads zero insets without a provider of its own here. */}
      <SafeAreaProvider>
        <SafeAreaView style={styles.root}>
          <View style={styles.header}>
            <Text style={styles.title}>Settings</Text>
            <TouchableOpacity
              onPress={onClose}
              accessibilityRole="button"
              hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}
            >
              <Text style={styles.done}>Done</Text>
            </TouchableOpacity>
          </View>

          <ScrollView style={styles.scroll} contentContainerStyle={styles.content}>
            {/* Preferences */}
            <Text style={styles.heading}>Preferences</Text>
            <View style={styles.card}>
              <PreferenceRows
                units={units}
                onUnitsChange={onUnitsChange}
                detailed
                timeFormat={timeFormat}
                onTimeFormatChange={onTimeFormatChange}
                aqiScale={aqiScale}
                onAqiScaleChange={onAqiScaleChange}
              />
            </View>

            {/* Offline maps: the door to the pack list. */}
            <Text style={[styles.heading, { marginTop: 28 }]}>Offline maps</Text>
            <View style={[styles.card, styles.listCard]}>
              <TouchableOpacity
                style={styles.listRow}
                onPress={() => setOfflineMaps(true)}
                activeOpacity={0.6}
                accessibilityRole="button"
              >
                <View style={styles.listText}>
                  <Text style={styles.listTitle}>Manage downloads</Text>
                  <Text style={styles.listSubtitle}>{held.packs.length ? held.summary : 'None downloaded'}</Text>
                </View>
                <MaterialCommunityIcons name="chevron-right" size={24} color={palette.textFaint} />
              </TouchableOpacity>
            </View>
            <OfflineMapsScreen
              visible={offlineMaps}
              onClose={() => setOfflineMaps(false)}
              downloaded={downloaded}
              onDownload={downloadPack}
              onRemove={removePack}
            />

            {/* Data */}
            <Text style={[styles.heading, { marginTop: 28 }]}>Data</Text>
            <Text style={styles.sectionNote}>
              You can delete all of your data from Going Blue at any time.
            </Text>
            <TouchableOpacity
              style={[styles.resetBtn, deleting && styles.resetBtnDisabled]}
              onPress={confirmDelete}
              disabled={deleting}
              activeOpacity={0.7}
            >
              {deleting
                ? <ActivityIndicator color={palette.destructive} />
                : <Text style={styles.resetBtnText}>Delete my data</Text>}
            </TouchableOpacity>

            <Text style={styles.legalLinks}>
              <Text style={styles.link} onPress={() => Linking.openURL(TERMS_URL)}>Terms &amp; Conditions</Text>
              {'   ·   '}
              <Text style={styles.link} onPress={() => Linking.openURL(PRIVACY_URL)}>Privacy Policy</Text>
            </Text>
          </ScrollView>
        </SafeAreaView>
      </SafeAreaProvider>
    </Modal>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: palette.page },
  // Same frame as HelpScreen: the safe area carries the status bar inset, so the header only
  // needs the same 12pt the app header uses.
  header: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    paddingHorizontal: 16, paddingTop: 12, paddingBottom: 12,
  },
  title: { flex: 1, fontSize: 20, fontWeight: '700', color: palette.pageTitle },
  done: { fontSize: 16, fontWeight: '600', color: palette.pageLink, paddingLeft: 12 },

  scroll: { flex: 1 },
  content: { padding: 16, paddingBottom: 40 },

  heading: { fontSize: 13, fontWeight: '700', color: palette.pageLabelLight, textTransform: 'uppercase', letterSpacing: 0.5, marginBottom: 12 },
  link: { color: palette.pageLink, textDecorationLine: 'underline' },

  card: { backgroundColor: palette.card, borderRadius: 12, padding: 14, marginBottom: 12 },
  // Tappable rows, so the card pads only its sides and each row carries its own height.
  listCard: { paddingVertical: 0 },
  listRow: { flexDirection: 'row', alignItems: 'center', paddingVertical: 11, gap: 10 },
  listText: { flex: 1 },
  listTitle: { fontSize: 15, color: palette.text },
  listSubtitle: { fontSize: 13, color: palette.textTertiary, marginTop: 2 },
  // Full-width destructive action, sitting on its own under the account note. Height is fixed so
  // swapping the label for a spinner mid-delete doesn't make the row jump.
  resetBtn: { backgroundColor: palette.card, borderRadius: 12, height: 48, alignItems: 'center', justifyContent: 'center', marginTop: 4 },
  resetBtnDisabled: { opacity: 0.6 },
  resetBtnText: { color: palette.destructive, fontSize: 15, fontWeight: '600' },
  sectionNote: { fontSize: 13, color: palette.pageNote, lineHeight: 19, marginTop: -4, marginBottom: 10 },
  legalLinks: { fontSize: 13, color: palette.pageTextTertiary, marginTop: 20, lineHeight: 19 },
});
