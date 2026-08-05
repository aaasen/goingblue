import { useState } from 'react';
import {
  LayoutAnimation, Modal, Platform, SafeAreaView, ScrollView, StyleSheet, Text, TouchableOpacity,
  UIManager, View, Linking,
} from 'react-native';
import * as Clipboard from 'expo-clipboard';
import MaterialCommunityIcons from '@expo/vector-icons/MaterialCommunityIcons';

const FORECAST_NUMBER = '(425) 434-5858';
// Opening the hosted vCard hands the user off to the system's own "add contact" flow, so the app
// needs no Contacts permission. Earthmate reads the phone's contacts, which is what makes the
// number addressable from an inReach without typing it out.
const CONTACT_VCF_URL = 'https://going.blue/contact.vcf';

// Android needs this opted into before LayoutAnimation does anything; on iOS it's already on.
if (Platform.OS === 'android') UIManager.setLayoutAnimationEnabledExperimental?.(true);

interface Props {
  visible: boolean;
  onClose: () => void;
}

// Reached from the Builder tab's "How do I get a forecast?" link. Setup's getting-started steps
// only show on first run, so this is where that explanation lives afterwards.
export default function HelpScreen({ visible, onClose }: Props) {
  // The routes are separate sequences rather than one list with asides — a satellite user and a
  // phone user share only the last step, and interleaving them makes both harder to follow. One
  // section open at a time: the device you carry is the only one you need instructions for.
  const [open, setOpen] = useState<string | null>(null);

  function toggle(name: string) {
    LayoutAnimation.configureNext(LayoutAnimation.Presets.easeInEaseOut);
    setOpen((cur) => (cur === name ? null : name));
  }

  return (
    <Modal visible={visible} animationType="slide" presentationStyle="pageSheet" onRequestClose={onClose}>
      <SafeAreaView style={styles.root}>
        <View style={styles.header}>
          <Text style={styles.title}>How do I get a forecast?</Text>
          <TouchableOpacity onPress={onClose} accessibilityRole="button" hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}>
            <Text style={styles.done}>Done</Text>
          </TouchableOpacity>
        </View>

        <ScrollView style={styles.scroll} contentContainerStyle={styles.content}>
          <Text style={styles.intro}>
            Going Blue answers a short text message with a forecast packed into a single 160-character
            reply — enough for about a hundred hourly data points. Build the request on the{' '}
            <Bold>Builder</Bold> tab, then send it from whichever device you carry.
          </Text>

          <Device name="Garmin Earthmate" open={open === 'Garmin Earthmate'} onToggle={toggle}>
            <EarthmateSteps />
          </Device>
          <Device name="Garmin Messenger" open={open === 'Garmin Messenger'} onToggle={toggle}>
            <MessengerSteps />
          </Device>
          <Device name="SMS" open={open === 'SMS'} onToggle={toggle}>
            <SmsSteps />
          </Device>
        </ScrollView>
      </SafeAreaView>
    </Modal>
  );
}

// One collapsible section per way out. Collapsed, the three headers fit on one screen, so the page
// opens as a choice of device rather than as a wall of steps for a device you don't carry.
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
          Tap <Bold>Copy Message</Bold> on the Builder tab, then send the message to Going Blue
          through the Earthmate app.
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

function MessengerSteps() {
  return (
    <>
      <Step n={1} title="Add Going Blue as a contact">
        <Text style={styles.para}>
          Garmin Messenger reads your phone&apos;s contacts, so saving the card here is what makes the
          number addressable from the messenger without typing it out.
        </Text>
        <ContactCard />
      </Step>

      <Step n={2} title="Send the request">
        <Text style={styles.para}>
          Tap <Bold>Copy Message</Bold> on the Builder tab, then paste it into the Garmin Messenger
          app and send it to Going Blue.
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
      <Step n={1} title="Add Going Blue as a contact">
        <Text style={styles.para}>
          Save the card so the reply arrives under a name you recognize.
        </Text>
        <ContactCard />
      </Step>

      <Step n={2} title="Send the request">
        <Text style={styles.para}>
          Tap <Bold>Send SMS</Bold> on the Builder tab. Messages opens with the request filled in and
          addressed; you tap send. This needs cell service, so it&apos;s the one to use before you
          lose signal.
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

// Card plus a copyable number, matching Setup's getting-started step. Used where the messenger
// reads the phone's own contacts and the vCard does the work for you.
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
  root: { flex: 1, backgroundColor: '#f2f2f7' },
  header: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    paddingHorizontal: 16, paddingTop: 8, paddingBottom: 12,
  },
  title: { flex: 1, fontSize: 20, fontWeight: '700', color: '#1c1c1e' },
  done: { fontSize: 16, fontWeight: '600', color: '#2a6bb5', paddingLeft: 12 },

  scroll: { flex: 1 },
  content: { paddingHorizontal: 16, paddingBottom: 40 },
  intro: { fontSize: 15, color: '#3a3a3c', lineHeight: 22, marginBottom: 16 },
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
