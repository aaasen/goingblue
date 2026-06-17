import { StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import type { Units } from './settings';

// Shared imperial/metric segmented toggle, used at account setup and on the Settings page.
export default function UnitsToggle({ units, onChange }: { units: Units; onChange: (u: Units) => void }) {
  return (
    <View style={styles.toggle}>
      <TouchableOpacity
        style={[styles.btn, units === 'imperial' && styles.btnActive]}
        onPress={() => onChange('imperial')}
        activeOpacity={0.7}
      >
        <Text style={[styles.btnText, units === 'imperial' && styles.btnTextActive]}>Imperial</Text>
      </TouchableOpacity>
      <TouchableOpacity
        style={[styles.btn, units === 'metric' && styles.btnActive]}
        onPress={() => onChange('metric')}
        activeOpacity={0.7}
      >
        <Text style={[styles.btnText, units === 'metric' && styles.btnTextActive]}>Metric</Text>
      </TouchableOpacity>
    </View>
  );
}

const styles = StyleSheet.create({
  toggle: { flexDirection: 'row', alignSelf: 'flex-start', backgroundColor: '#e5e5ea', borderRadius: 8, padding: 2 },
  btn: { paddingHorizontal: 16, paddingVertical: 6, borderRadius: 6 },
  btnActive: { backgroundColor: '#fff' },
  btnText: { fontSize: 13, color: '#6e6e73', fontWeight: '500' },
  btnTextActive: { color: '#1c1c1e' },
});
