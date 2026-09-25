import { ActivityIndicator, Pressable, StyleSheet, Text } from 'react-native';
import MaterialCommunityIcons from '@expo/vector-icons/MaterialCommunityIcons';
import { palette } from '../palette';

// A full-width action button: icon and label, replaced by a spinner and Cancel while the action
// resolves. The variants differ only in fill, so one tint drives the icon and the label together
// — and a disabled button is filled grey, which needs the light tint whatever its variant. Busy
// is the exception: a button that is off resolving its own press is working, not unavailable, so
// it keeps its variant's fill under the spinner — grey there made the GPS re-fix before a copy
// flash as a grey beat in the middle of the press-to-Copied sequence. While busy the button
// stays pressable and the press calls the wait off instead of re-firing the action.
export default function ActionButton({ icon, label, onPress, onCancel, disabled, busy, variant }: {
  icon: React.ComponentProps<typeof MaterialCommunityIcons>['name'];
  label: string;
  onPress: () => void;
  onCancel: () => void;
  disabled: boolean;
  busy: boolean;
  variant: 'primary' | 'success';
}) {
  const fill = { primary: styles.btnPrimary, success: styles.btnSuccess }[variant];
  const greyed = disabled && !busy;
  const tint = greyed || variant === 'primary' ? palette.onPrimary : palette.success;
  return (
    <Pressable
      style={({ pressed }) => [styles.btn, fill, greyed && styles.btnDisabled, pressed && styles.pressed]}
      onPress={busy ? onCancel : onPress}
      disabled={busy ? false : disabled}
      accessibilityRole="button"
      accessibilityLabel={busy ? 'Cancel' : label}
    >
      {busy ? (
        <>
          <ActivityIndicator color={tint} style={styles.btnIcon} />
          <Text style={[styles.btnText, { color: tint }]} numberOfLines={1}>Cancel</Text>
        </>
      ) : (
        <>
          <MaterialCommunityIcons name={icon} size={19} color={tint} style={styles.btnIcon} />
          {/* One line always: the row is a fixed 50pt, so a label that wrapped would be clipped
              rather than grow the button. */}
          <Text style={[styles.btnText, { color: tint }]} numberOfLines={1}>{label}</Text>
        </>
      )}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  // Full-width action, its icon and label on a single centered row.
  btn: { flexDirection: 'row', height: 50, borderRadius: 14, alignItems: 'center', justifyContent: 'center' },
  btnPrimary: { backgroundColor: palette.primary },
  btnSuccess: { backgroundColor: palette.successTint, borderWidth: 1, borderColor: palette.success },
  btnDisabled: { backgroundColor: palette.primaryDisabled, borderColor: palette.primaryDisabled },
  // Press feedback for the action and paste buttons. A declarative dim rather than
  // TouchableOpacity: both buttons re-render themselves from inside their own press handler
  // (busy, copied, a paste outcome), and a re-render landing mid-fade could strand the touchable's
  // animated opacity below 1 — the outcome then sat greyed until the next touch. Pressable's
  // pressed flag has no animation state to strand.
  pressed: { opacity: 0.4 },
  btnIcon: { marginRight: 8 },
  btnText: { fontSize: 16, fontWeight: '600' },
});
