import { useState } from 'react';
import {
  LayoutAnimation, Linking, Platform, StyleSheet, Text, TouchableOpacity, View,
} from 'react-native';
import * as Clipboard from 'expo-clipboard';
import MaterialCommunityIcons from '@expo/vector-icons/MaterialCommunityIcons';
import { palette } from './palette';

const FORECAST_NUMBER = '(425) 434-5858';
// Opening the hosted vCard hands the user off to the system's own "add contact" flow, so the app
// needs no Contacts permission. Earthmate keeps its own contact list, so only its steps go
// without — every other route (SMS, iPhone, ZOLEO, Garmin Messenger) reads the phone's contacts.
const CONTACT_VCF_URL = 'https://going.blue/contact.vcf';

// Per-device setup, shared by the first-run Setup screen and the help sheet — one
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
      <Device name="SMS/Text Message" open={open === 'SMS/Text Message'} onToggle={toggle}>
        <SmsSteps />
      </Device>
      <Device name="Garmin Messenger" open={open === 'Garmin Messenger'} onToggle={toggle}>
        <MessengerSteps />
      </Device>
      <Device name="Garmin Earthmate" open={open === 'Garmin Earthmate'} onToggle={toggle}>
        <EarthmateSteps />
      </Device>
      {/* The iPhone route is hidden from the device selector on Android (see devices.ts), so its
          setup steps go with it. */}
      {Platform.OS !== 'android' && (
        <Device name="iPhone satellite messaging" open={open === 'iPhone satellite messaging'} onToggle={toggle}>
          <IPhoneSteps />
        </Device>
      )}
      <Device name="ZOLEO" open={open === 'ZOLEO'} onToggle={toggle}>
        <ZoleoSteps />
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
        <MaterialCommunityIcons name={open ? 'chevron-up' : 'chevron-down'} size={22} color={palette.textTertiary} />
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
          In Going Blue, choose <Bold>inReach</Bold> as your device and tap{' '}
          <Bold>Copy inReach Message</Bold>, then send the message to Going Blue through the Earthmate app.
        </Text>
      </Step>

      <Step n={3} title="Copy the reply">
        <Text style={styles.para}>
          When the response arrives, tap the message, tap the share button, and choose{' '}
          <Bold>Copy</Bold>.
        </Text>
      </Step>

      <ViewForecastStep n={4} />
    </>
  );
}

// The other Garmin app, for the devices Earthmate no longer supports. It sends over the same
// inReach route — same builder button, same d: token — so only the app's own steps differ, and
// unlike Earthmate it imports from the phone's contacts, which is what the vCard is for.
function MessengerSteps() {
  return (
    <>
      <Text style={styles.deviceDesc}>
        Messenger is Garmin&apos;s companion app for newer inReach devices.
      </Text>

      <Step n={1} title="Add Going Blue as a contact">
        <ContactCard />
      </Step>

      <Step n={2} title="Import the contact into Messenger">
        <Text style={styles.para}>
          Open Garmin Messenger and go to{' '}
          <Bold>Device › Contacts › Add Contact › Import Contact</Bold>, then import the Going Blue
          contact.
        </Text>
      </Step>

      <Step n={3} title="Send the request">
        <Text style={styles.para}>
          In Going Blue, choose <Bold>inReach</Bold> as your device and tap{' '}
          <Bold>Copy inReach Message</Bold>, then send the message to Going Blue through the
          Messenger app.
        </Text>
      </Step>

      <Step n={4} title="Copy the reply">
        <Text style={styles.para}>
          When the response arrives, press and hold the message and choose <Bold>Copy</Bold>.
        </Text>
      </Step>

      <ViewForecastStep n={5} />
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
          In Going Blue, choose <Bold>SMS</Bold> as your device, tap <Bold>Send SMS</Bold>, and
          send the message.
        </Text>
      </Step>

      <ViewForecastStep n={3} />
    </>
  );
}

// Same copy-across handoff as Earthmate: the ZOLEO app sends the message, the builder's button
// only copies it. Choosing ZOLEO as the device is what earns the longer reply — the request's
// d: token tells the server this route carries 240 characters to SMS's 160 (see devices.ts).
function ZoleoSteps() {
  return (
    <>
      <Text style={styles.deviceDesc}>
        Use the ZOLEO app paired with a ZOLEO satellite communicator.
      </Text>

      <Step n={1} title="Add Going Blue as a contact">
        <ContactCard />
      </Step>

      <Step n={2} title="Send the request">
        <Text style={styles.para}>
          In Going Blue, choose <Bold>ZOLEO</Bold> as your device and tap{' '}
          <Bold>Copy ZOLEO Message</Bold>, then paste the message into a new message to Going Blue
          in the ZOLEO app and send it.
        </Text>
      </Step>

      <ViewForecastStep n={3} />
    </>
  );
}

// Same handoff as SMS — Messages, same number — so the steps differ only where satellite does.
// The reply is the reason this is its own device: over satellite it comes back in a wider
// alphabet, split into whole messages the reader pastes one at a time, because the satellite link
// never reassembles what it splits (see devices.ts).
function IPhoneSteps() {
  return (
    <>
      <Text style={styles.deviceDesc}>
        Choose iPhone satellite messaging when you are out of service and have a compatible iPhone.
      </Text>

      <Step n={1} title="Add Going Blue as a contact">
        <ContactCard />
      </Step>

      <Step n={2} title="Connect to the satellite">
        <Text style={styles.para}>
          iPhone satellite messaging is only available when there is no cell reception. Follow
          prompts in Messages to connect to the satellite and remain connected while sending the
          forecast.
        </Text>
      </Step>

      <Step n={3} title="Send the request">
        <Text style={styles.para}>
          Choose <Bold>iPhone</Bold> as your device and tap <Bold>Send Satellite Message</Bold>.
        </Text>
      </Step>

      <ViewForecastStep n={4} />
    </>
  );
}

// The last step of every route: whatever carried the reply, Paste Forecast is the only
// thing that reads it. One component rather than five copies — the five had already drifted into three
// different wordings.
function ViewForecastStep({ n }: { n: number }) {
  return (
    <Step n={n} title="View the forecast">
      <Text style={styles.para}>
        Copy the reply, then return to Going Blue and tap <Bold>Paste Forecast</Bold> to
        visualize the forecast.
      </Text>
    </Step>
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
  para: { fontSize: 14, color: palette.textBody, lineHeight: 21 },
  bold: { fontWeight: '700', color: palette.text },

  device: { backgroundColor: palette.card, borderRadius: 12, marginBottom: 10, overflow: 'hidden' },
  deviceHeader: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    paddingHorizontal: 14, paddingVertical: 14,
  },
  deviceName: { fontSize: 16, fontWeight: '600', color: palette.text },
  deviceBody: { paddingHorizontal: 14, paddingTop: 2 },
  deviceDesc: { fontSize: 14, color: palette.textSecondary, lineHeight: 20, marginBottom: 16 },

  step: { flexDirection: 'row', gap: 12, marginBottom: 20 },
  stepBody: { flex: 1 },
  stepNum: { width: 24, height: 24, borderRadius: 12, backgroundColor: palette.primary, alignItems: 'center', justifyContent: 'center', marginTop: 1 },
  stepNumText: { color: palette.onPrimary, fontSize: 13, fontWeight: '700' },
  stepTitle: { fontSize: 15, fontWeight: '600', color: palette.text, marginBottom: 6 },

  linkBtn: { backgroundColor: palette.primary, borderRadius: 10, paddingVertical: 11, alignItems: 'center', marginTop: 12 },
  linkBtnText: { color: palette.onPrimary, fontSize: 15, fontWeight: '600' },

  // Tinted rather than white — it sits inside the white section card, so white would vanish.
  numberRow: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    backgroundColor: palette.cardWell, borderRadius: 10, paddingLeft: 14, paddingRight: 8,
    paddingVertical: 8, marginTop: 8,
  },
  number: { fontSize: 16, fontWeight: '600', color: palette.text, fontFamily: 'Courier' },
  copyBtn: { backgroundColor: palette.linkTint, borderRadius: 8, paddingHorizontal: 16, paddingVertical: 7 },
  copyBtnText: { color: palette.link, fontSize: 14, fontWeight: '600' },
  copyBtnSuccess: { backgroundColor: palette.successTint },
  copyBtnSuccessText: { color: palette.success },
});
