import { StyleSheet, Text, View } from 'react-native';
import DeviceSetup from './DeviceSetup';
import { palette } from './palette';

// The getting-started explanation: what the three-step loop is, then the per-device instructions
// for carrying it out. Shared by the first-run Setup screen and the help sheet, so
// the answer to "how do I get a forecast?" is the same one either way.
export default function GettingStarted() {
  return (
    <>
      <Text style={styles.heading}>How it works</Text>

      <Step n={1} title="Build a forecast request">
        <Text style={styles.para}>
          Set the location, weather model, and variables for your forecast.
        </Text>
      </Step>
      <Step n={2} title="Send the request to Going Blue">
        <Text style={styles.para}>
          Send the request via internet, text message, or satellite messenger.
        </Text>
      </Step>
      <Step n={3} title="View the forecast">
        <Text style={styles.para}>
          Copy the reply, then return to Going Blue and tap <Bold>Paste Forecast</Bold> to
          visualize the forecast.
        </Text>
      </Step>

      <Text style={[styles.heading, styles.headingTop]}>Setup</Text>
      <DeviceSetup />
    </>
  );
}

function Bold({ children }: { children: React.ReactNode }) {
  return <Text style={styles.bold}>{children}</Text>;
}

// Children render straight into the step body rather than inside a Text, so a step can carry
// controls alongside its prose.
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
  heading: { fontSize: 13, fontWeight: '700', color: palette.pageLabelLight, textTransform: 'uppercase', letterSpacing: 0.5, marginBottom: 12 },
  headingTop: { marginTop: 12 },
  para: { fontSize: 14, color: palette.pageText, lineHeight: 21, marginBottom: 12 },
  bold: { fontWeight: '700', color: palette.pageTitle },
  step: { flexDirection: 'row', gap: 12, marginBottom: 4 },
  stepBody: { flex: 1 },
  stepNum: { width: 24, height: 24, borderRadius: 12, backgroundColor: palette.primary, alignItems: 'center', justifyContent: 'center', marginTop: 1 },
  stepNumText: { color: palette.onPrimary, fontSize: 13, fontWeight: '700' },
  stepTitle: { fontSize: 15, fontWeight: '600', color: palette.pageTitle, marginBottom: 4 },
});
