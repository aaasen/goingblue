import { Pressable, StyleSheet, Text } from 'react-native';
import MaterialCommunityIcons from '@expo/vector-icons/MaterialCommunityIcons';
import { palette } from '../palette';

export interface Outcome {
  label: string;
  failed: boolean;
}

export default function PasteButton({ outcome, onPress }: { outcome: Outcome | null; onPress: () => void }) {
  return (
    <Pressable
      style={({ pressed }) => [
        styles.pasteBtn,
        outcome && (outcome.failed ? styles.pasteBtnFailed : styles.pasteBtnDone),
        pressed && styles.pressed,
      ]}
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={outcome?.label ?? 'Paste Forecast'}
    >
      <MaterialCommunityIcons
        name={outcome ? (outcome.failed ? 'close' : 'check') : 'content-paste'}
        size={19}
        color={outcome ? (outcome.failed ? palette.danger : palette.success) : palette.onPrimary}
        style={styles.pasteBtnIcon}
      />
      <Text
        style={[
          styles.pasteBtnText,
          outcome && (outcome.failed ? styles.pasteBtnTextFailed : styles.pasteBtnTextDone),
        ]}
        numberOfLines={1}
      >
        {outcome?.label ?? 'Paste Forecast'}
      </Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  // Same fills as the Copy inReach Message button (ActionButton), so a confirmed press
  // looks the same in both places.
  pasteBtn: {
    flex: 1,
    flexDirection: 'row',
    height: 50,
    borderRadius: 14,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: palette.primary,
  },
  pasteBtnDone: { backgroundColor: palette.successTint, borderWidth: 1, borderColor: palette.success },
  // The error box's own colours, so the button and the reason under it read as one thing.
  pasteBtnFailed: { backgroundColor: palette.dangerTint, borderWidth: 1, borderColor: palette.danger },
  pasteBtnIcon: { marginRight: 8 },
  pasteBtnText: { color: palette.onPrimary, fontSize: 16, fontWeight: '600' },
  pasteBtnTextDone: { color: palette.success },
  pasteBtnTextFailed: { color: palette.danger },
  // See ActionButton's pressed.
  pressed: { opacity: 0.4 },
});
