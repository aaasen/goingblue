import { useState } from 'react';
import {
  LayoutAnimation, Linking, Platform, StyleSheet, Text, TouchableOpacity, View,
} from 'react-native';
import * as Clipboard from 'expo-clipboard';
import MaterialCommunityIcons from '@expo/vector-icons/MaterialCommunityIcons';
import { palette } from './palette';

const FORECAST_NUMBER = '(425) 434-5858';
// Opening the hosted vCard hands the user off to the system's own "add contact" flow, so the app
// needs no Contacts permission. Every route's steps start with it.
const CONTACT_VCF_URL = 'https://going.blue/contact.vcf';

// The send step of How it works (GettingStarted.tsx), one collapsible section per device that
// needs more than tapping the send button: what comes between building the request and viewing
// the forecast. Adding the contact comes before and viewing the forecast after, the same for
// every device. The internet and SMS routes need nothing here.
export default function DeviceSteps() {
  // One section open at a time: the device you carry is the only one you need steps for.
  const [open, setOpen] = useState<string | null>(null);

  function toggle(name: string) {
    LayoutAnimation.configureNext(LayoutAnimation.Presets.easeInEaseOut);
    setOpen((cur) => (cur === name ? null : name));
  }

  return (
    <>
      <Device name="Garmin Messenger" open={open === 'Garmin Messenger'} onToggle={toggle}>
        <MessengerSteps />
      </Device>
      <Device name="Garmin Earthmate" open={open === 'Garmin Earthmate'} onToggle={toggle}>
        <EarthmateSteps />
      </Device>
      {/* The iPhone route is hidden from the device selector on Android (see devices.ts), so its
          steps go with it. */}
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

// One collapsible section per way out. Collapsed, the headers fit on one screen, so the step reads
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
      <Text style={styles.para}>
        Choose <Bold>inReach</Bold> as your device and tap <Bold>Copy inReach Message</Bold>, then send
        the message to Going Blue through the Garmin Earthmate app. When the response arrives, tap the
        message, tap the share button, and choose <Bold>Copy</Bold>.
      </Text>
    </>
  );
}

// The other Garmin app, for the devices Earthmate no longer supports. It sends over the same
// inReach route (same builder button, same d: token), so only the app's own steps differ.
function MessengerSteps() {
  return (
    <>
      <Text style={styles.deviceDesc}>
        Messenger is Garmin&apos;s companion app for newer inReach devices.
      </Text>
      <Text style={styles.para}>
        Choose <Bold>inReach</Bold> as your device and tap <Bold>Copy inReach Message</Bold>, then send
        the message to Going Blue through the Garmin Messenger app. When the response arrives, press
        and hold the message and choose <Bold>Copy</Bold>.
      </Text>
    </>
  );
}

// Same copy-across handoff as Earthmate: the ZOLEO app sends the message, the builder's button
// only copies it. Choosing ZOLEO as the device is what earns the longer reply: the request's
// d: token tells the server this route carries 240 characters to SMS's 160 (see devices.ts).
function ZoleoSteps() {
  return (
    <>
      <Text style={styles.deviceDesc}>
        Use the ZOLEO app paired with a ZOLEO satellite communicator.
      </Text>
      <Text style={styles.para}>
        Choose <Bold>ZOLEO</Bold> as your device and tap <Bold>Copy ZOLEO Message</Bold>, then paste
        the message into a new message to Going Blue in the ZOLEO app and send it.
      </Text>
    </>
  );
}

// Same handoff as SMS, through Messages to the same number, so the steps differ only where
// satellite does. The reply is the reason this is its own device: over satellite it comes back in
// a wider alphabet, split into whole messages the reader pastes one at a time, because the
// satellite link never reassembles what it splits (see devices.ts).
function IPhoneSteps() {
  return (
    <>
      <Text style={styles.deviceDesc}>
        Choose iPhone satellite messaging when you are out of service and have a compatible iPhone.
      </Text>
      <Text style={styles.para}>
        iPhone satellite messaging is only available when there is no cell reception. Follow prompts
        in Messages to connect to the satellite and remain connected while sending the forecast. Then
        choose <Bold>iPhone</Bold> as your device and tap <Bold>Send Satellite Message</Bold>.
      </Text>
    </>
  );
}

// The contact card plus a copyable number, the first step of How it works for every device.
// `onPage` is for the card sitting on the page background, where the number row's tint would
// match the page and vanish, rather than inside a white card.
export function ContactCard({ onPage = false }: { onPage?: boolean }) {
  return (
    <>
      <LinkButton label="Save contact card" url={CONTACT_VCF_URL} />
      <NumberRow onPage={onPage} />
    </>
  );
}

// The number on its own, to type or paste where the contact card can't be used.
function NumberRow({ onPage }: { onPage: boolean }) {
  const [copied, setCopied] = useState(false);

  async function copyNumber() {
    await Clipboard.setStringAsync(FORECAST_NUMBER);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }

  return (
    <View style={[styles.numberRow, onPage && styles.numberRowOnPage]}>
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

const styles = StyleSheet.create({
  para: { fontSize: 14, color: palette.textBody, lineHeight: 21, marginBottom: 16 },
  bold: { fontWeight: '700', color: palette.text },

  device: { backgroundColor: palette.card, borderRadius: 12, marginBottom: 10, overflow: 'hidden' },
  deviceHeader: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    paddingHorizontal: 14, paddingVertical: 14,
  },
  deviceName: { fontSize: 16, fontWeight: '600', color: palette.text },
  deviceBody: { paddingHorizontal: 14, paddingTop: 2 },
  deviceDesc: { fontSize: 14, color: palette.textBody, lineHeight: 21, marginBottom: 12 },


  linkBtn: { backgroundColor: palette.primary, borderRadius: 10, paddingVertical: 11, alignItems: 'center', marginTop: 12 },
  linkBtnText: { color: palette.onPrimary, fontSize: 15, fontWeight: '600' },

  // Tinted rather than white — it sits inside the white section card, so white would vanish.
  numberRow: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    backgroundColor: palette.cardWell, borderRadius: 10, paddingLeft: 14, paddingRight: 8,
    paddingVertical: 8, marginTop: 8,
  },
  numberRowOnPage: { backgroundColor: palette.card },
  number: { fontSize: 16, fontWeight: '600', color: palette.text, fontFamily: 'Courier' },
  copyBtn: { backgroundColor: palette.linkTint, borderRadius: 8, paddingHorizontal: 16, paddingVertical: 7 },
  copyBtnText: { color: palette.link, fontSize: 14, fontWeight: '600' },
  copyBtnSuccess: { backgroundColor: palette.successTint },
  copyBtnSuccessText: { color: palette.success },
});
