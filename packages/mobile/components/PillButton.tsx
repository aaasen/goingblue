import { Pressable, StyleSheet, Text } from 'react-native';
import { palette } from '../palette';

// A compact filled button for a secondary action beside a line of text: the Subscribe button in
// the builder's quota box.
export default function PillButton({ label, onPress }: { label: string; onPress: () => void }) {
  return (
    <Pressable
      style={({ pressed }) => [styles.button, pressed && styles.pressed]}
      onPress={onPress}
      accessibilityRole="button"
    >
      <Text style={styles.label}>{label}</Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  button: { backgroundColor: palette.primary, borderRadius: 8, paddingHorizontal: 16, paddingVertical: 7 },
  pressed: { opacity: 0.7 },
  label: { color: palette.onPrimary, fontSize: 14, fontWeight: '600' },
});
