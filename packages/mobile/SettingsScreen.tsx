import { useState, type ReactNode } from 'react';
import {
  ActivityIndicator, Alert, Linking, Modal, ScrollView, StyleSheet, Text,
  TouchableOpacity, View,
} from 'react-native';
import { SafeAreaProvider, SafeAreaView } from 'react-native-safe-area-context';
import MaterialCommunityIcons from '@expo/vector-icons/MaterialCommunityIcons';
import PreferenceRows from './PreferenceRows';
import OfflineMapsScreen, { downloadedPacks } from './OfflineMapsScreen';
import { usePackState } from './packStore';
import type { AqiScale, CoordFormat, TimeFormat, UnitPrefs } from './settings';
import { SUBSCRIBE_CTA, quotaStatus, type StoredQuota } from './quota';
import { palette } from './palette';

const TERMS_URL = 'https://going.blue/terms';
const PRIVACY_URL = 'https://going.blue/privacy';

// Settings, as a full-screen sheet off the header's gear — the same frame as HelpScreen.
export default function SettingsScreen({
  visible, onClose, onDeleteAccount, quota, onSubscribe, onManageSubscription, annualSwitch, children, units, onUnitsChange,
  timeFormat, onTimeFormatChange, coordFormat, onCoordFormatChange, aqiScale, onAqiScaleChange,
}: {
  visible: boolean;
  onClose: () => void;
  onDeleteAccount: () => Promise<void>;
  // The free-forecast quota as the server last stated it (quota.ts). Subscribe opens the
  // subscription sheet; Manage Subscription, shown to a subscriber instead, opens the store's
  // own management page.
  quota: StoredQuota | null;
  onSubscribe: () => void;
  onManageSubscription: () => void;
  // For a monthly subscriber: the annual plan's price and the press that buys it in place of the
  // monthly. Null for anyone else.
  annualSwitch: { price: string; busy: boolean; onPress: () => void } | null;
  // The paywall sheet, mounted inside this modal while it is open: iOS presents one modal from
  // a view at a time, so a sibling sheet would never appear over this one.
  children?: ReactNode;
  units: UnitPrefs;
  onUnitsChange: (u: UnitPrefs) => void;
  timeFormat: TimeFormat;
  onTimeFormatChange: (format: TimeFormat) => void;
  coordFormat: CoordFormat;
  onCoordFormatChange: (format: CoordFormat) => void;
  aqiScale: AqiScale;
  onAqiScaleChange: (scale: AqiScale) => void;
}) {
  const [deleting, setDeleting] = useState(false);
  const [offlineMaps, setOfflineMaps] = useState(false);
  const held = downloadedPacks(usePackState().installed);
  const subscription = quotaStatus(quota, new Date());

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
        {/* No bottom edge: the frame runs to the screen edge so the scroll view fills it,
            and the content padding below clears the home indicator. */}
        <SafeAreaView edges={['top', 'left', 'right']} style={styles.root}>
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
            {/* Subscription: the plan, what it includes (the last bullet being this month's
                standing on the free plan), and the way to subscribe. */}
            <Text style={styles.heading}>Subscription</Text>
            <View style={styles.card}>
              <Text style={styles.planName}>{subscription.name}</Text>
              {subscription.text !== null && <Text style={styles.bulletText}>{subscription.text}</Text>}
              {subscription.bullets.map((bullet) => (
                <View key={bullet} style={styles.bullet}>
                  <Text style={styles.bulletDot}>{'•'}</Text>
                  <Text style={styles.bulletText}>{bullet}</Text>
                </View>
              ))}
              {!subscription.subscribed && (
                <Text style={styles.subscribeNote}>{subscription.standing} {SUBSCRIBE_CTA}</Text>
              )}
            </View>
            {subscription.subscribed ? (
              <>
                {annualSwitch && (
                  <TouchableOpacity
                    style={[styles.subscribeBtn, styles.switchBtn, annualSwitch.busy && styles.resetBtnDisabled]}
                    onPress={annualSwitch.onPress}
                    disabled={annualSwitch.busy}
                    activeOpacity={0.7}
                    accessibilityRole="button"
                  >
                    {annualSwitch.busy
                      ? <ActivityIndicator color={palette.onPrimary} />
                      : <Text style={styles.subscribeBtnText}>Switch to Annual  {annualSwitch.price}/year</Text>}
                  </TouchableOpacity>
                )}
                <TouchableOpacity style={styles.manageBtn} onPress={onManageSubscription} activeOpacity={0.7} accessibilityRole="button">
                  <Text style={styles.manageBtnText}>Manage Subscription</Text>
                </TouchableOpacity>
              </>
            ) : (
              <TouchableOpacity style={styles.subscribeBtn} onPress={onSubscribe} activeOpacity={0.7} accessibilityRole="button">
                <Text style={styles.subscribeBtnText}>Subscribe</Text>
              </TouchableOpacity>
            )}

            {/* Preferences */}
            <Text style={[styles.heading, { marginTop: 28 }]}>Preferences</Text>
            <View style={styles.card}>
              <PreferenceRows
                units={units}
                onUnitsChange={onUnitsChange}
                detailed
                timeFormat={timeFormat}
                onTimeFormatChange={onTimeFormatChange}
                coordFormat={coordFormat}
                onCoordFormatChange={onCoordFormatChange}
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
            <OfflineMapsScreen visible={offlineMaps} onClose={() => setOfflineMaps(false)} />

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
          {children}
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
    borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: palette.pageRule,
  },
  title: { flex: 1, fontSize: 20, fontWeight: '700', color: palette.pageTitle },
  done: { fontSize: 16, fontWeight: '600', color: palette.pageLink, paddingLeft: 12 },

  scroll: { flex: 1 },
  content: { padding: 16, paddingBottom: 72 },

  heading: { fontSize: 13, fontWeight: '700', color: palette.pageLabelLight, textTransform: 'uppercase', letterSpacing: 0.5, marginBottom: 12 },
  link: { color: palette.pageLink, textDecorationLine: 'underline' },

  card: { backgroundColor: palette.card, borderRadius: 12, padding: 14, marginBottom: 12 },
  // Tappable rows, so the card pads only its sides and each row carries its own height.
  listCard: { paddingVertical: 0 },
  listRow: { flexDirection: 'row', alignItems: 'center', paddingVertical: 11, gap: 10 },
  listText: { flex: 1 },
  listTitle: { fontSize: 15, color: palette.text },
  listSubtitle: { fontSize: 13, color: palette.textTertiary, marginTop: 2 },
  // The plan card: its name, then what it includes as a bulleted list.
  // The same type as the subscription sheet's plan card.
  planName: { fontSize: 17, fontWeight: '600', color: palette.text, marginBottom: 8 },
  bullet: { flexDirection: 'row', gap: 8, marginTop: 4 },
  bulletDot: { fontSize: 15, lineHeight: 21, color: palette.text },
  bulletText: { flex: 1, fontSize: 15, lineHeight: 21, color: palette.text },
  subscribeNote: { fontSize: 15, lineHeight: 21, color: palette.text, marginTop: 12 },
  // Full-width button under the plan card, the same height and radius as the delete button at
  // the bottom of the page.
  subscribeBtn: { backgroundColor: palette.primary, borderRadius: 12, height: 48, alignItems: 'center', justifyContent: 'center' },
  subscribeBtnText: { color: palette.onPrimary, fontSize: 15, fontWeight: '600' },
  // The subscriber's counterpart: the same shape on a card, since there is nothing to sell.
  manageBtn: { backgroundColor: palette.card, borderRadius: 12, height: 48, alignItems: 'center', justifyContent: 'center' },
  manageBtnText: { color: palette.pageLink, fontSize: 15, fontWeight: '600' },
  switchBtn: { marginBottom: 12 },
  // Full-width destructive action, sitting on its own under the account note. Height is fixed so
  // swapping the label for a spinner mid-delete doesn't make the row jump.
  resetBtn: { backgroundColor: palette.card, borderRadius: 12, height: 48, alignItems: 'center', justifyContent: 'center', marginTop: 4 },
  resetBtnDisabled: { opacity: 0.6 },
  resetBtnText: { color: palette.destructive, fontSize: 15 },
  sectionNote: { fontSize: 13, color: palette.pageNote, lineHeight: 19, marginTop: -4, marginBottom: 10 },
  legalLinks: { fontSize: 13, color: palette.pageTextTertiary, marginTop: 20, lineHeight: 19 },
});
