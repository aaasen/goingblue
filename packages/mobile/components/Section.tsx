import { StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import { palette } from '../palette';

// A labeled section, with an optional ⓘ that opens its explainer.
export default function Section({ label, info, children }: { label: string; info?: () => void; children: React.ReactNode }) {
  return (
    <View style={styles.section}>
      <View style={styles.sectionHeader}>
        <Text style={styles.sectionLabel}>{label}</Text>
        {info && (
          <TouchableOpacity
            onPress={info}
            hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}
            accessibilityRole="button"
            accessibilityLabel={`About ${label}`}
          >
            <Text style={styles.sectionInfo}>ⓘ</Text>
          </TouchableOpacity>
        )}
      </View>
      {children}
    </View>
  );
}

const styles = StyleSheet.create({
  section: { marginBottom: 20 },
  sectionHeader: { flexDirection: 'row', alignItems: 'center', marginBottom: 8 },
  sectionLabel: { fontSize: 12, fontWeight: '600', color: palette.pageLabel, textTransform: 'uppercase', letterSpacing: 0.5 },
  sectionInfo: { fontSize: 14, color: palette.pageLink, marginLeft: 6 },
});
