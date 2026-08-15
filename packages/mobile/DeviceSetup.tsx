import { useState } from 'react';
import {
  LayoutAnimation, Linking, Platform, StyleSheet, Text, TouchableOpacity, UIManager, View,
} from 'react-native';
import * as Clipboard from 'expo-clipboard';
import MaterialCommunityIcons from '@expo/vector-icons/MaterialCommunityIcons';

const FORECAST_NUMBER = '(425) 434-5858';
// Opening the hosted vCard hands the user off to the system's own "add contact" flow, so the app
// needs no Contacts permission. Only the SMS route uses it — Earthmate keeps its own contact list.
const CONTACT_VCF_URL = 'https://going.blue/contact.vcf';

// Android needs this opted into before LayoutAnimation does anything; on iOS it's already on.
if (Platform.OS === 'android') UIManager.setLayoutAnimationEnabledExperimental?.(true);

// Per-device setup, shared by the first-run Setup screen and the Builder tab's help sheet — one
// list of instructions, so the two can't drift apart.
export default function DeviceSetup() {
  // The routes are separate sequences rather than one list with asides — a satellite user and a
  // phone user share only the last step, and interleaving them makes both harder to follow. One
  // section open at a time: the device you carry is the only one you need instructions for.
  const [open, setOpen] = useState<string | null>(null);

  function toggle(name: string) {
    LayoutAnimation.configureNext(LayoutAnimation.Presets.easeInEaseOut);
    setOpen((cur) => (cur === name ? null : name));
  }

  return (
    <>
      <Device name="Garmin Earthmate" open={open === 'Garmin Earthmate'} onToggle={toggle}>
        <EarthmateSteps />
      </Device>
      <Device name="SMS/Text Message" open={open === 'SMS/Text Message'} onToggle={toggle}>
        <SmsSteps />
      </Device>
    </>
  );
}

// One collapsible section per way out. Collapsed, the headers fit on one screen, so the page opens
// as a choice of device rather than as a wall of steps for a device you don't carry.
function Device({ name, open, onToggle, children }: {
  name: string;
  open: boolean;
  onToggle: (name: string) => void;
  children: React.ReactNode;
}) {
  return (
    <View style={styles.device}>
      <TouchableOpacity
        style={styles.deviceHeader}
        onPress={() => onToggle(name)}
        activeOpacity={0.6}
        accessibilityRole="button"
        accessibilityState={{ expanded: open }}
      >
        <Text style={styles.deviceName}>{name}</Text>
        <MaterialCommunityIcons name={open ? 'chevron-up' : 'chevron-down'} size={22} color="#8e8e93" />
      </TouchableOpacity>
      {open && <View style={styles.deviceBody}>{children}</View>}
    </View>
  );
}

function EarthmateSteps() {
  return (
    <>
      <Text style={styles.deviceDesc}>
        Earthmate is Garmin&apos;s companion app for older inReach devices.
      </Text>

      {/* Earthmate keeps its own contact list rather than reading the phone's, so the vCard is no
          help here — the number has to be typed or pasted into the app itself. */}
      <Step n={1} title="Add Going Blue as a contact">
        <Text style={styles.para}>
          Open the Earthmate app, go to <Bold>More › Contacts</Bold>, tap <Bold>+</Bold>, and add the
          Going Blue number with the <Bold>+1</Bold> calling code.
        </Text>
        <NumberRow />
      </Step>

      <Step n={2} title="Send the request">
        <Text style={styles.para}>
          On the Builder tab, choose <Bold>inReach</Bold> as your device and tap{' '}
          <Bold>Copy Message</Bold>, then send the message to Going Blue through the Earthmate app.
        </Text>
      </Step>

      <Step n={3} title="Copy the reply">
        <Text style={styles.para}>
          When the response arrives, tap the message, tap the share button, and choose{' '}
          <Bold>Copy</Bold>.
        </Text>
      </Step>

      <Step n={4} title="Read the forecast">
        <Text style={styles.para}>
          Paste the reply into the <Bold>Decoder</Bold> tab to visualize the forecast.
        </Text>
      </Step>
    </>
  );
}

function SmsSteps() {
  return (
    <>
      <Text style={styles.deviceDesc}>
        Use Going Blue over SMS when you have weak cell reception without data.
      </Text>

      <Step n={1} title="Add Going Blue as a contact">
        <ContactCard />
      </Step>

      <Step n={2} title="Send the request">
        <Text style={styles.para}>
          On the Builder tab, choose <Bold>SMS</Bold> as your device, tap <Bold>Send SMS</Bold>, and
          send the message.
        </Text>
      </Step>

      <Step n={3} title="Read the forecast">
        <Text style={styles.para}>
          Copy the reply and paste it into the <Bold>Decoder</Bold> tab to visualize the forecast.
        </Text>
      </Step>
    </>
  );
}

// Card plus a copyable number. Used where the messenger reads the phone's own contacts and the
// vCard does the work for you.
function ContactCard() {
  return (
    <>
      <LinkButton label="Save contact card" url={CONTACT_VCF_URL} />
      <NumberRow />
    </>
  );
}

// The number on its own, for apps that keep their own contact list and need it pasted in by hand.
function NumberRow() {
  const [copied, setCopied] = useState(false);

  async function copyNumber() {
    await Clipboard.setStringAsync(FORECAST_NUMBER);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }

  return (
    <View style={styles.numberRow}>
      <Text style={styles.number} selectable>{FORECAST_NUMBER}</Text>
      <TouchableOpacity
        style={[styles.copyBtn, copied && styles.copyBtnSuccess]}
        onPress={copyNumber}
        activeOpacity={0.7}
        accessibilityRole="button"
      >
        <Text style={[styles.copyBtnText, copied && styles.copyBtnSuccessText]}>
          {copied ? '✓ Copied' : 'Copy'}
        </Text>
      </TouchableOpacity>
    </View>
  );
}

function LinkButton({ label, url }: { label: string; url: string }) {
  return (
    <TouchableOpacity
      style={styles.linkBtn}
      onPress={() => Linking.openURL(url)}
      activeOpacity={0.7}
      accessibilityRole="button"
    >
      <Text style={styles.linkBtnText}>{label}</Text>
    </TouchableOpacity>
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
      <View style={styles.stepBody}>
        <Text style={styles.stepTitle}>{title}</Text>
        {children}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  para: { fontSize: 14, color: '#3a3a3c', lineHeight: 21 },
  bold: { fontWeight: '700', color: '#1c1c1e' },

  device: { backgroundColor: '#fff', borderRadius: 12, marginBottom: 10, overflow: 'hidden' },
  deviceHeader: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    paddingHorizontal: 14, paddingVertical: 14,
  },
  deviceName: { fontSize: 16, fontWeight: '600', color: '#1c1c1e' },
  deviceBody: { paddingHorizontal: 14, paddingTop: 2 },
  deviceDesc: { fontSize: 14, color: '#6e6e73', lineHeight: 20, marginBottom: 16 },

  step: { flexDirection: 'row', gap: 12, marginBottom: 20 },
  stepBody: { flex: 1 },
  stepNum: { width: 24, height: 24, borderRadius: 12, backgroundColor: '#2a6bb5', alignItems: 'center', justifyContent: 'center', marginTop: 1 },
  stepNumText: { color: '#fff', fontSize: 13, fontWeight: '700' },
  stepTitle: { fontSize: 15, fontWeight: '600', color: '#1c1c1e', marginBottom: 6 },

  linkBtn: { backgroundColor: '#2a6bb5', borderRadius: 10, paddingVertical: 11, alignItems: 'center', marginTop: 12 },
  linkBtnText: { color: '#fff', fontSize: 15, fontWeight: '600' },

  // Tinted rather than white — it sits inside the white section card, so white would vanish.
  numberRow: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    backgroundColor: '#f2f2f7', borderRadius: 10, paddingLeft: 14, paddingRight: 8,
    paddingVertical: 8, marginTop: 8,
  },
  number: { fontSize: 16, fontWeight: '600', color: '#1c1c1e', fontFamily: 'Courier' },
  copyBtn: { backgroundColor: '#eef3fa', borderRadius: 8, paddingHorizontal: 16, paddingVertical: 7 },
  copyBtnText: { color: '#2a6bb5', fontSize: 14, fontWeight: '600' },
  copyBtnSuccess: { backgroundColor: '#e8f5ec' },
  copyBtnSuccessText: { color: '#2a8f5a' },
});
