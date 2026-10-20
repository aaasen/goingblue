import { StyleSheet, Text, View, type StyleProp, type ViewStyle } from 'react-native';
import PillButton from './PillButton';
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
      {action && <PillButton label={action.label} onPress={action.onPress} />}
    </View>
  );
}

const styles = StyleSheet.create({
  box: {
    flexDirection: 'row', alignItems: 'center', gap: 12,
    padding: 12, backgroundColor: palette.linkTint, borderRadius: 10, borderWidth: 1, borderColor: palette.link,
  },
  text: { flex: 1, color: palette.link, fontSize: 14, lineHeight: 20 },
});
