import { useEffect, useState } from 'react';
import {
  ActivityIndicator, Alert, Linking, Modal, ScrollView, StyleSheet, Text, TouchableOpacity, View,
} from 'react-native';
import { SafeAreaProvider, SafeAreaView } from 'react-native-safe-area-context';
import type { CustomerInfo, PurchasesPackage } from 'react-native-purchases';
import { activeEntitlement, loadPlans, purchasePlan, restorePurchases, type Plans } from './purchases';
import { requestErrorMessage } from './network';
import { palette } from './palette';

const TERMS_URL = 'https://going.blue/terms';
const PRIVACY_URL = 'https://going.blue/privacy';

// The subscription sheet, off the Subscribe buttons in the builder and in Settings: the plan,
// what it includes, the two ways to buy it, and Restore Purchases. Only a reader without a
// subscription gets here; a subscriber's Settings button goes straight to the store's own
// management page, which is where plan changes and cancellation happen. Same frame as
// SettingsScreen.
export default function PaywallScreen({ visible, onClose, onPurchased }: {
  visible: boolean;
  onClose: () => void;
  // A purchase or restore went through; the caller refreshes what it shows.
  onPurchased: (info: CustomerInfo) => void;
}) {
  const [plans, setPlans] = useState<Plans | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [busy, setBusy] = useState<'monthly' | 'annual' | 'restore' | null>(null);

  useEffect(() => {
    if (!visible) return;
    let cancelled = false;
    setLoadError(null);
    loadPlans().then(
      (p) => { if (!cancelled) setPlans(p); },
      (e) => { if (!cancelled) setLoadError(requestErrorMessage(e)); },
    );
    return () => { cancelled = true; };
  }, [visible]);

  async function buy(which: 'monthly' | 'annual', pkg: PurchasesPackage) {
    setBusy(which);
    try {
      const info = await purchasePlan(pkg);
      if (info) onPurchased(info);
    } catch (e) {
      Alert.alert('Purchase failed', requestErrorMessage(e));
    } finally {
      setBusy(null);
    }
  }

  async function restore() {
    setBusy('restore');
    try {
      const info = await restorePurchases();
      onPurchased(info);
      if (!activeEntitlement(info)) Alert.alert('Nothing to restore', 'No subscription was found for this Apple or Google account.');
    } catch (e) {
      Alert.alert('Restore failed', requestErrorMessage(e));
    } finally {
      setBusy(null);
    }
  }

  const planButton = (which: 'monthly' | 'annual', pkg: PurchasesPackage | null, label: string, per: string) => {
    if (!pkg) return null;
    return (
      <TouchableOpacity
        key={which}
        style={[styles.plan, busy !== null && styles.disabled]}
        onPress={() => buy(which, pkg)}
        disabled={busy !== null}
        activeOpacity={0.7}
        accessibilityRole="button"
      >
        {busy === which
          ? <ActivityIndicator color={palette.onPrimary} />
          : <Text style={styles.planText}>{label}{'  '}{pkg.product.priceString}{per}</Text>}
      </TouchableOpacity>
    );
  };

  return (
    <Modal visible={visible} animationType="slide" presentationStyle="fullScreen" onRequestClose={onClose}>
      <SafeAreaProvider>
        <SafeAreaView edges={['top', 'left', 'right']} style={styles.root}>
          <View style={styles.header}>
            <Text style={styles.title}>Subscribe</Text>
            <TouchableOpacity onPress={onClose} accessibilityRole="button" hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}>
              <Text style={styles.done}>Done</Text>
            </TouchableOpacity>
          </View>

          <ScrollView style={styles.scroll} contentContainerStyle={styles.content}>
            <View style={styles.card}>
              <Text style={styles.planName}>Going Blue Expedition</Text>
              <Text style={styles.pitch}>
                Subscribe to Going Blue Expedition for{' '}
                <Text style={styles.pitchBold}>unlimited SMS and satellite weather forecasts</Text>.
                Get the annual plan for the price of just two months to keep using Going Blue throughout the year.
              </Text>
            </View>

            {plans === null && loadError === null && <ActivityIndicator style={styles.loading} color={palette.pageTextTertiary} />}
            {loadError !== null && <Text style={styles.note}>Plans are not available right now. {loadError}</Text>}

            {plans !== null && (
              <>
                {planButton('annual', plans.annual, 'Subscribe annually', '/year')}
                {planButton('monthly', plans.monthly, 'Subscribe monthly', '/month')}
                <TouchableOpacity
                  style={[styles.secondary, busy !== null && styles.disabled]}
                  onPress={restore}
                  disabled={busy !== null}
                  activeOpacity={0.7}
                  accessibilityRole="button"
                >
                  {busy === 'restore'
                    ? <ActivityIndicator color={palette.pageLink} />
                    : <Text style={styles.secondaryText}>Restore Purchases</Text>}
                </TouchableOpacity>
              </>
            )}

            <Text style={styles.legal}>
              Payment is charged to your Apple or Google account. The subscription renews automatically
              until cancelled at least 24 hours before the end of the current period. Manage or cancel it
              in your account settings.
            </Text>
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
  header: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    paddingHorizontal: 16, paddingTop: 12, paddingBottom: 12,
    borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: palette.pageRule,
  },
  title: { flex: 1, fontSize: 20, fontWeight: '700', color: palette.pageTitle },
  done: { fontSize: 16, fontWeight: '600', color: palette.pageLink, paddingLeft: 12 },
  scroll: { flex: 1 },
  content: { padding: 16, paddingBottom: 72 },
  // The plan card, as the Subscription section of Settings draws it.
  card: { backgroundColor: palette.card, borderRadius: 12, padding: 14, marginBottom: 16 },
  planName: { fontSize: 17, fontWeight: '600', color: palette.text, marginBottom: 8 },
  // The size and color of a Settings row title ("Manage downloads").
  pitch: { fontSize: 15, lineHeight: 21, color: palette.text },
  pitchBold: { fontWeight: '600' },
  loading: { marginVertical: 24 },
  note: { fontSize: 13, color: palette.pageNote, lineHeight: 19, marginBottom: 12 },
  // The same shape as the Subscribe button in Settings, one per plan.
  plan: { backgroundColor: palette.primary, borderRadius: 12, height: 48, alignItems: 'center', justifyContent: 'center', marginBottom: 12 },
  planText: { color: palette.onPrimary, fontSize: 15, fontWeight: '600' },
  secondary: { height: 44, alignItems: 'center', justifyContent: 'center' },
  secondaryText: { color: palette.pageLink, fontSize: 15, fontWeight: '600' },
  disabled: { opacity: 0.6 },
  legal: { fontSize: 12, color: palette.pageTextTertiary, lineHeight: 17, marginTop: 20 },
  legalLinks: { fontSize: 13, color: palette.pageTextTertiary, marginTop: 12, lineHeight: 19, textAlign: 'center' },
  link: { color: palette.pageLink, textDecorationLine: 'underline' },
});
