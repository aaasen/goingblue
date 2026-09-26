import { StyleSheet, Text, TextInput, TouchableOpacity, View } from 'react-native';
import Section from './Section';
import { palette } from '../palette';

// The day an avalanche bulletin is requested for: a date field that is empty for the latest
// bulletin, with a step back and forward a day at a time. Stepping forward past today returns
// to the latest.

const DAY_MS = 24 * 60 * 60 * 1000;

// The local calendar date as YYYY-MM-DD.
function isoDay(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

// Whether the field holds something to send: empty for the latest, or a real calendar date.
export function isValidDay(day: string): boolean {
  if (day === '') return true;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) return false;
  const ms = Date.parse(`${day}T00:00:00Z`);
  return !isNaN(ms) && new Date(ms).toISOString().startsWith(day);
}

function stepped(day: string, days: number): string {
  const [y, m, d] = day.split('-').map(Number);
  return isoDay(new Date(new Date(y, m - 1, d).getTime() + days * DAY_MS + DAY_MS / 2));
}

export default function DayPicker({ day, onDay }: { day: string; onDay: (day: string) => void }) {
  const today = isoDay(new Date());
  const valid = isValidDay(day);
  const back = () => onDay(stepped(valid && day ? day : today, -1));
  const forward = () => {
    const next = stepped(day, 1);
    onDay(next > today ? '' : next);
  };
  const canForward = valid && day !== '';
  return (
    <Section label="Day">
      <View style={styles.row}>
        <TouchableOpacity onPress={back} style={styles.step} accessibilityRole="button" accessibilityLabel="Previous day">
          <Text style={styles.stepText}>‹</Text>
        </TouchableOpacity>
        <TextInput
          style={styles.input}
          value={day}
          onChangeText={(text) => onDay(text.trim())}
          placeholder="Latest"
          placeholderTextColor={palette.pageTextTertiary}
          autoCorrect={false}
          autoCapitalize="none"
          keyboardType="numbers-and-punctuation"
          accessibilityLabel="Day"
        />
        <TouchableOpacity
          onPress={forward}
          disabled={!canForward}
          style={styles.step}
          accessibilityRole="button"
          accessibilityLabel="Next day"
          accessibilityState={{ disabled: !canForward }}
        >
          <Text style={[styles.stepText, !canForward && styles.stepDisabled]}>›</Text>
        </TouchableOpacity>
      </View>
      {!valid && <Text style={styles.note}>Enter a date as YYYY-MM-DD</Text>}
    </Section>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  step: { paddingHorizontal: 12, paddingVertical: 6 },
  stepText: { fontSize: 24, color: palette.pageLink },
  stepDisabled: { color: palette.pageTextTertiary },
  input: {
    flex: 1, fontSize: 16, color: palette.pageTitle, textAlign: 'center',
    borderWidth: StyleSheet.hairlineWidth, borderColor: palette.pageRule, borderRadius: 8,
    paddingVertical: 8, paddingHorizontal: 12,
  },
  note: { fontSize: 12, color: palette.pageTextTertiary, marginTop: 6 },
});
