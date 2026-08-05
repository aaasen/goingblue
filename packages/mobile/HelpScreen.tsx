import {
  Modal, SafeAreaView, ScrollView, StyleSheet, Text, TouchableOpacity, View, Linking,
} from 'react-native';
import MaterialCommunityIcons from '@expo/vector-icons/MaterialCommunityIcons';

const FORECAST_NUMBER = '(425) 434-5858';
// Opening the hosted vCard hands the user off to the system's own "add contact" flow, so the app
// needs no Contacts permission. Earthmate reads the phone's contacts, which is what makes the
// number addressable from an inReach without typing it out.
const CONTACT_VCF_URL = 'https://going.blue/contact.vcf';

// The three send routes, mirroring the Builder tab's buttons — same icons and labels, so the page
// reads as an annotation of the buttons rather than a separate description of them.
const ROUTES = [
  {
    icon: 'satellite-variant',
    label: 'Copy Message (inReach/ZOLEO)',
    desc: 'Copies the request. Paste it into your satellite messenger and send it to the Going Blue number. Save the contact card below first so the number is already in your device.',
  },
  {
    icon: 'message-text',
    label: 'Send SMS',
    desc: 'Opens Messages with the request filled in and addressed. You tap send. Needs cell service, so this is the one to use before you lose signal.',
  },
  {
    icon: 'wifi',
    label: 'Get Forecast',
    desc: 'Fetches the forecast over the internet without sending a message. Useful for trying settings out at home.',
  },
] as const;

interface Props {
  visible: boolean;
  onClose: () => void;
}

// Reached from the Builder tab's "How do I get a forecast?" link. Setup's getting-started steps
// only show on first run, so this is where that explanation lives afterwards.
export default function HelpScreen({ visible, onClose }: Props) {
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
            reply — enough for about a hundred hourly data points.
          </Text>

          <Step n={1} title="Build the request">
            <Text style={styles.para}>
              On the <Bold>Builder</Bold> tab, set the location, then pick a priority, a weather model,
              and any extra variables. Those choices become a short text message — the request itself.
            </Text>
          </Step>

          <Step n={2} title="Send it to Going Blue">
            <Text style={styles.para}>Three ways out, one per button:</Text>
            {ROUTES.map((route) => (
              <View key={route.label} style={styles.route}>
                <View style={styles.routeHeader}>
                  <MaterialCommunityIcons name={route.icon} size={17} color="#2a6bb5" style={styles.routeIcon} />
                  <Text style={styles.routeLabel}>{route.label}</Text>
                </View>
                <Text style={styles.routeDesc}>{route.desc}</Text>
              </View>
            ))}
            <TouchableOpacity
              style={styles.contactBtn}
              onPress={() => Linking.openURL(CONTACT_VCF_URL)}
              activeOpacity={0.7}
              accessibilityRole="button"
            >
              <Text style={styles.contactBtnText}>Save contact card</Text>
            </TouchableOpacity>
            <Text style={styles.number} selectable>{FORECAST_NUMBER}</Text>
          </Step>

          <Step n={3} title="Read the reply">
            <Text style={styles.para}>
              Copy the reply and paste it into the <Bold>Decoder</Bold> tab to see the forecast.
              Decode it on the phone that built the request — the reply leaves out everything it can,
              and the missing settings come from the request stored on this device.
            </Text>
          </Step>
        </ScrollView>
      </SafeAreaView>
    </Modal>
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
  intro: { fontSize: 15, color: '#3a3a3c', lineHeight: 22, marginBottom: 20 },
  para: { fontSize: 14, color: '#3a3a3c', lineHeight: 21 },
  bold: { fontWeight: '700', color: '#1c1c1e' },

  step: { flexDirection: 'row', gap: 12, marginBottom: 20 },
  stepBody: { flex: 1 },
  stepNum: { width: 24, height: 24, borderRadius: 12, backgroundColor: '#2a6bb5', alignItems: 'center', justifyContent: 'center', marginTop: 1 },
  stepNumText: { color: '#fff', fontSize: 13, fontWeight: '700' },
  stepTitle: { fontSize: 15, fontWeight: '600', color: '#1c1c1e', marginBottom: 6 },

  route: { backgroundColor: '#fff', borderRadius: 12, padding: 12, marginTop: 10 },
  routeHeader: { flexDirection: 'row', alignItems: 'center', marginBottom: 4 },
  routeIcon: { marginRight: 7 },
  routeLabel: { flex: 1, fontSize: 14, fontWeight: '600', color: '#1c1c1e' },
  routeDesc: { fontSize: 13, color: '#6e6e73', lineHeight: 19 },

  contactBtn: { backgroundColor: '#2a6bb5', borderRadius: 10, paddingVertical: 11, alignItems: 'center', marginTop: 14 },
  contactBtnText: { color: '#fff', fontSize: 15, fontWeight: '600' },
  number: { fontSize: 15, fontWeight: '600', color: '#1c1c1e', fontFamily: 'Courier', textAlign: 'center', marginTop: 8 },
});
