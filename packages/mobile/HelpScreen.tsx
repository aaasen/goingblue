import {
  Modal, SafeAreaView, ScrollView, StyleSheet, Text, TouchableOpacity, View,
} from 'react-native';
import GettingStarted from './GettingStarted';

interface Props {
  visible: boolean;
  onClose: () => void;
}

// Reached from the Builder tab's "How do I get a forecast?" link. Setup's steps only show on first
// run, so this is where that explanation lives afterwards — the same GettingStarted sections,
// framed as a sheet.
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
            reply — enough for about a hundred hourly data points. Build the request on the{' '}
            <Text style={styles.bold}>Builder</Text> tab, then send it from whichever device you carry.
          </Text>

          <GettingStarted />
        </ScrollView>
      </SafeAreaView>
    </Modal>
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
  bold: { fontWeight: '700', color: '#1c1c1e' },
});
