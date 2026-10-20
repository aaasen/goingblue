import { Pressable, StyleSheet, Text, View, type StyleProp, type ViewStyle } from 'react-native';
import { palette } from '../palette';

// A blue box: the message on the left and, when there is one, a button on the right. The quiet
// counterpart of WarningBanner for something the reader should know, and may act on.
export default function InfoBox({ children, action, style }: {
  children: string;
  action?: { label: string; onPress: () => void };
  style?: StyleProp<ViewStyle>;
}) {
  return (
    <View style={[styles.box, style]}>
      <Text style={styles.text}>{children}</Text>
      {action && (
        <Pressable
          style={({ pressed }) => [styles.button, pressed && styles.buttonPressed]}
          onPress={action.onPress}
          accessibilityRole="button"
        >
          <Text style={styles.buttonText}>{action.label}</Text>
        </Pressable>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  box: {
    flexDirection: 'row', alignItems: 'center', gap: 12,
    padding: 12, backgroundColor: palette.linkTint, borderRadius: 10, borderWidth: 1, borderColor: palette.link,
  },
  text: { flex: 1, color: palette.link, fontSize: 14, lineHeight: 20 },
  button: { backgroundColor: palette.primary, borderRadius: 8, paddingHorizontal: 16, paddingVertical: 7 },
  buttonPressed: { opacity: 0.7 },
  buttonText: { color: palette.onPrimary, fontSize: 14, fontWeight: '600' },
});
