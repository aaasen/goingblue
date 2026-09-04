import {
  Modal, ScrollView, StyleSheet, Text, TouchableOpacity, View,
} from 'react-native';
import { SafeAreaProvider, SafeAreaView } from 'react-native-safe-area-context';
import GettingStarted from './GettingStarted';
import { palette } from './palette';

interface Props {
  visible: boolean;
  onClose: () => void;
}

// Reached from the home screen's "How do I get a forecast?" link. Setup's steps only show on first
// run, so this is where that explanation lives afterwards — the same GettingStarted sections,
// framed as a sheet.
export default function HelpScreen({ visible, onClose }: Props) {
  return (
    <Modal visible={visible} animationType="slide" presentationStyle="fullScreen" onRequestClose={onClose}>
      {/* A Modal is its own window, so the provider at the app root is not above it in the native
          tree, and the safe-area view reads zero insets without a provider of its own here. */}
      <SafeAreaProvider>
        {/* No bottom edge: the frame runs to the screen edge so the scroll view fills it,
            and the content padding below clears the home indicator. */}
        <SafeAreaView edges={['top', 'left', 'right']} style={styles.root}>
          <View style={styles.header}>
            <Text style={styles.title}>How do I get a forecast?</Text>
            <TouchableOpacity onPress={onClose} accessibilityRole="button" hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}>
              <Text style={styles.done}>Done</Text>
            </TouchableOpacity>
          </View>

          <ScrollView style={styles.scroll} contentContainerStyle={styles.content}>
            <GettingStarted />
          </ScrollView>
        </SafeAreaView>
      </SafeAreaProvider>
    </Modal>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: palette.page },
  // The safe area carries the status bar inset now that this runs the full height, so the header
  // only needs the same 12pt the app header uses. It kept 24 as a page sheet, to clear the
  // rounded corners UIKit drew over the title.
  header: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    paddingHorizontal: 16, paddingTop: 12, paddingBottom: 12,
    borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: palette.pageRule,
  },
  title: { flex: 1, fontSize: 20, fontWeight: '700', color: palette.pageTitle },
  done: { fontSize: 16, fontWeight: '600', color: palette.pageLink, paddingLeft: 12 },

  scroll: { flex: 1 },
  content: { paddingHorizontal: 16, paddingTop: 16, paddingBottom: 72 },
});
