import { Platform, StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import MaterialCommunityIcons from '@expo/vector-icons/MaterialCommunityIcons';
import DateTimePicker, { DateTimePickerAndroid } from '@react-native-community/datetimepicker';
import { palette } from '../palette';

// The day an avalanche bulletin is requested for, as a settings row on its own white card, like
// the ones in Settings: the label left, the platform's own date picker right. On iOS that is the
// system's compact date button, which opens Apple's calendar popover. Android has no such control,
// so the date shows as text with a chevron, and a tap opens its calendar dialog. The date runs from the first season of
// Avalanche Canada's archive through today. It starts on today, which asks for the bulletin
// current when the request arrives; `day` is '' then, and YYYY-MM-DD for any earlier date.

const FIRST_DAY = new Date(2022, 10, 1);

// The local calendar date as YYYY-MM-DD.
function isoDay(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function dateOf(day: string): Date {
  const [y, m, d] = day.split('-').map(Number);
  return new Date(y, m - 1, d);
}

export default function DayRow({ day, onDay }: { day: string; onDay: (day: string) => void }) {
  const today = new Date();
  const value = day ? dateOf(day) : today;
  const choose = (_: unknown, date: Date) => {
    const picked = isoDay(date);
    onDay(picked === isoDay(today) ? '' : picked);
  };
  if (Platform.OS === 'ios') {
    return (
      <View style={styles.card}>
        <Text style={styles.label}>Date</Text>
        <DateTimePicker
          value={value} mode="date" display="compact"
          minimumDate={FIRST_DAY} maximumDate={today} onValueChange={choose}
        />
      </View>
    );
  }
  return (
    <TouchableOpacity
      style={styles.card}
      onPress={() => DateTimePickerAndroid.open({ value, mode: 'date', minimumDate: FIRST_DAY, maximumDate: today, onValueChange: choose })}
      accessibilityRole="button"
    >
      <Text style={styles.label}>Date</Text>
      <View style={styles.androidValue}>
        <Text style={styles.androidDate} numberOfLines={1}>
          {value.toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' })}
        </Text>
        <MaterialCommunityIcons name="chevron-down" size={20} color={palette.textTertiary} />
      </View>
    </TouchableOpacity>
  );
}

const styles = StyleSheet.create({
  // Settings' card and list-row type (SettingsScreen), holding the one row. The fixed height keeps
  // the row the same whether the compact button or the text sits in it.
  card: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    backgroundColor: palette.card, borderRadius: 12, paddingHorizontal: 14, minHeight: 48, marginBottom: 20,
  },
  label: { fontSize: 15, color: palette.text },
  androidValue: { flexDirection: 'row', alignItems: 'center', gap: 4 },
  androidDate: { fontSize: 15, color: palette.textSecondary },
});
