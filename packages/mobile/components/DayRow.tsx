import { useState } from 'react';
import { Modal, Platform, Pressable, StyleSheet, Text, TouchableOpacity } from 'react-native';
import MaterialCommunityIcons from '@expo/vector-icons/MaterialCommunityIcons';
import DateTimePicker, { DateTimePickerAndroid } from '@react-native-community/datetimepicker';
import { palette } from '../palette';

// The day an avalanche bulletin is requested for, as the last of the rows under the Avalanche
// tab's map (AvalancheZonePicker), drawn as they are: the label, the date as text, a chevron. A
// tap opens the platform's calendar: Android's own dialog, and on iOS the inline calendar on a
// card over the screen, since the system's compact date button can't be restyled to match the
// rows. The date runs from the first season of
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
  const [open, setOpen] = useState(false);
  const today = new Date();
  const value = day ? dateOf(day) : today;
  const choose = (_: unknown, date: Date) => {
    const picked = isoDay(date);
    onDay(picked === isoDay(today) ? '' : picked);
  };
  const onPress = Platform.OS === 'ios'
    ? () => setOpen(true)
    : () => DateTimePickerAndroid.open({ value, mode: 'date', minimumDate: FIRST_DAY, maximumDate: today, onValueChange: choose });
  return (
    <>
      <TouchableOpacity style={styles.row} onPress={onPress} accessibilityRole="button">
        <Text style={styles.label}>Date</Text>
        <Text style={styles.value} numberOfLines={1}>
          {value.toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' })}
        </Text>
        <MaterialCommunityIcons name="chevron-down" size={20} color={palette.textTertiary} style={styles.chevron} />
      </TouchableOpacity>
      {Platform.OS === 'ios' && (
        <Modal visible={open} transparent animationType="fade" onRequestClose={() => setOpen(false)}>
          {/* A tap outside the card closes it, as the system's popover does. */}
          <Pressable style={styles.backdrop} onPress={() => setOpen(false)} accessibilityLabel="Close">
            <Pressable style={styles.calendar} onPress={() => {}}>
              <DateTimePicker
                value={value} mode="date" display="inline"
                minimumDate={FIRST_DAY} maximumDate={today} onValueChange={choose}
              />
              <TouchableOpacity style={styles.done} onPress={() => setOpen(false)} accessibilityRole="button">
                <Text style={styles.doneText}>Done</Text>
              </TouchableOpacity>
            </Pressable>
          </Pressable>
        </Modal>
      )}
    </>
  );
}

const styles = StyleSheet.create({
  // A row of AvalancheZonePicker's.
  row: {
    flexDirection: 'row', alignItems: 'baseline', paddingHorizontal: 16, paddingVertical: 12,
    borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: palette.cardRule,
  },
  label: { width: 104, fontSize: 15, fontWeight: '600', color: palette.textSecondary },
  value: { flex: 1, fontSize: 15, color: palette.text },
  chevron: { alignSelf: 'center', marginLeft: 8 },
  backdrop: { flex: 1, justifyContent: 'center', padding: 16, backgroundColor: 'rgba(0, 0, 0, 0.35)' },
  calendar: { backgroundColor: palette.card, borderRadius: 14, padding: 12 },
  done: { alignSelf: 'flex-end', paddingHorizontal: 8, paddingVertical: 8 },
  doneText: { fontSize: 16, fontWeight: '600', color: palette.link },
});
