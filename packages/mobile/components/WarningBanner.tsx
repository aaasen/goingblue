import { StyleSheet, Text, View, type StyleProp, type ViewStyle } from 'react-native';
import MaterialCommunityIcons from '@expo/vector-icons/MaterialCommunityIcons';
import { palette } from '../palette';

// An amber banner: an alert icon, then the message.
export default function WarningBanner({ children, style }: { children: string; style?: StyleProp<ViewStyle> }) {
  return (
    <View style={[styles.banner, style]}>
      <MaterialCommunityIcons name="alert" size={20} color={palette.warning} />
      <Text style={styles.text}>{children}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  banner: {
    flexDirection: 'row', alignItems: 'center', gap: 8, marginBottom: 12,
    padding: 12, backgroundColor: palette.warningTint, borderRadius: 10, borderWidth: 1, borderColor: palette.warning,
  },
  text: { flex: 1, color: palette.warning, fontSize: 14, fontWeight: '600', lineHeight: 20 },
});
