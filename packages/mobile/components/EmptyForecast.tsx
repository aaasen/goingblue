import { StyleSheet, Text, View } from 'react-native';
import { palette } from '../palette';

// Where the forecast will be, on both tabs, before one is loaded.
export default function EmptyForecast() {
  return (
    <View style={styles.box}>
      <Text style={styles.title}>No forecast loaded</Text>
      <Text style={styles.hint}>Paste an encoded forecast reply to visualize it</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  // A dashed outline the size of a short meteogram, so the page holds its shape before and after.
  box: {
    marginHorizontal: 16, marginBottom: 8, paddingVertical: 28, paddingHorizontal: 16,
    alignItems: 'center', gap: 4,
    borderWidth: 1, borderStyle: 'dashed', borderColor: palette.pageChipBorder, borderRadius: 12,
  },
  title: { fontSize: 15, fontWeight: '600', color: palette.pageTextSecondary },
  hint: { fontSize: 13, color: palette.pageTextTertiary, textAlign: 'center' },
});
