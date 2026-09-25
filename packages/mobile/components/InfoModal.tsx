import { Modal, ScrollView, StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import { SafeAreaProvider, SafeAreaView } from 'react-native-safe-area-context';
import { palette } from '../palette';

// The ⓘ screens. A centered card was the wrong container once the variable list grew past a
// screen: bounding it left the card filling the display anyway, minus a margin, with its body
// cut mid-sentence at a scroll edge that didn't look like one. Full screen rather than a page
// sheet because UIKit rounds a sheet's corners to the display's own curve, which reads as a lot
// of radius for a page of text — and RN gives no way to ask for less. The trade is the swipe-down
// dismissal a sheet comes with, so Done is the way out and sits where a sheet's would.
export default function InfoModal({ visible, title, onClose, grouped = false, headerRight, toolbar, children }: {
  visible: boolean; title: string; onClose: () => void; children: React.ReactNode;
  // Takes the place of Done for a sheet with more to do than close.
  headerRight?: React.ReactNode;
  // Held between the header and the scrolling content, so it stays in reach however long the
  // content runs.
  toolbar?: React.ReactNode;
  // The page's gray with the page's header colors, the frame Settings uses, for a sheet whose
  // content is a card of rows rather than running text.
  grouped?: boolean;
}) {
  return (
    <Modal visible={visible} animationType="slide" presentationStyle="fullScreen" onRequestClose={onClose}>
      {/* A Modal is its own window, so the provider at the app root is not above it in the native
          tree, and the safe-area view reads zero insets without a provider of its own here. */}
      <SafeAreaProvider>
        {/* No bottom edge: the frame runs to the screen edge so the scroll view fills it,
            and the content padding below clears the home indicator. */}
        <SafeAreaView edges={['top', 'left', 'right']} style={[styles.sheet, grouped && styles.sheetGrouped]}>
          <View style={[styles.sheetHeader, grouped && styles.sheetHeaderGrouped]}>
            <Text style={[styles.sheetTitle, grouped && styles.sheetTitleGrouped]}>{title}</Text>
            {headerRight ?? (
              <TouchableOpacity
                onPress={onClose}
                accessibilityRole="button"
                hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}
              >
                <Text style={[styles.sheetDone, grouped && styles.sheetDoneGrouped]}>Done</Text>
              </TouchableOpacity>
            )}
          </View>
          {toolbar}
          {/* Taps persist through the keyboard: the favorite sheets are this scroll view's
              descendants in the React tree even though they present in a modal of their own,
              and without this the scroll view spends the first tap on their buttons dismissing
              the keyboard. */}
          <ScrollView style={styles.sheetScroll} contentContainerStyle={styles.sheetContent} keyboardShouldPersistTaps="handled">
            {children}
          </ScrollView>
        </SafeAreaView>
      </SafeAreaProvider>
    </Modal>
  );
}

const styles = StyleSheet.create({
  // Sheet frame, matching HelpScreen's. The safe area carries the status bar inset, so the header
  // only needs the same 12pt the app header uses.
  sheet: { flex: 1, backgroundColor: palette.sheet },
  sheetGrouped: { backgroundColor: palette.page },
  sheetHeaderGrouped: { borderBottomColor: palette.pageRule },
  sheetTitleGrouped: { color: palette.pageTitle },
  sheetDoneGrouped: { color: palette.pageLink },
  sheetHeader: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    paddingHorizontal: 16, paddingTop: 12, paddingBottom: 12,
    borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: palette.cardRule,
  },
  sheetTitle: { flex: 1, fontSize: 20, fontWeight: '700', color: palette.text },
  sheetDone: { fontSize: 16, fontWeight: '600', color: palette.link, paddingLeft: 12 },
  sheetScroll: { flex: 1 },
  sheetContent: { paddingHorizontal: 16, paddingTop: 16, paddingBottom: 72 },
});
