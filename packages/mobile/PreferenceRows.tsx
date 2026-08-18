import type { ReactNode } from 'react';
import { StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import { AQI_SCALES, type AqiScale, type TimeFormat, type Units } from './settings';

// The display preferences, as one block: Units, Time format, and Air quality. Both the setup
// screen and the Settings tab render this component rather than their own rows, so the two
// surfaces always offer the same set — a preference added here shows up in both.

interface Props {
  units: Units;
  onUnitsChange: (u: Units) => void;
  timeFormat: TimeFormat;
  onTimeFormatChange: (format: TimeFormat) => void;
  aqiScale: AqiScale;
  onAqiScaleChange: (scale: AqiScale) => void;
}

const UNITS_OPTIONS: { value: Units; label: string }[] = [
  { value: 'imperial', label: 'Imperial' },
  { value: 'metric', label: 'Metric' },
];

const TIME_FORMAT_OPTIONS: { value: TimeFormat; label: string }[] = [
  { value: '12h', label: '12h' },
  { value: '24h', label: '24h' },
];

export default function PreferenceRows({
  units, onUnitsChange, timeFormat, onTimeFormatChange, aqiScale, onAqiScaleChange,
}: Props) {
  return (
    <>
      <Row label="Units">
        <Toggle options={UNITS_OPTIONS} selected={units} onChange={onUnitsChange} />
      </Row>
      <Row label="Time format" spaced>
        <Toggle options={TIME_FORMAT_OPTIONS} selected={timeFormat} onChange={onTimeFormatChange} />
      </Row>
      {/* Which scale the air-quality variables are requested and drawn on. A preference rather
          than a builder option: the two indices aren't convertible, so this is the scale the
          reader reads in, and the builder offers only that one's variables. */}
      <Row label="Air quality" spaced>
        <Toggle options={AQI_SCALES} selected={aqiScale} onChange={onAqiScaleChange} />
      </Row>
    </>
  );
}

function Row({ label, spaced, children }: { label: string; spaced?: boolean; children: ReactNode }) {
  return (
    <View style={[styles.row, spaced && styles.rowSpacing]}>
      <Text style={styles.label}>{label}</Text>
      {children}
    </View>
  );
}

function Toggle<T extends string>({
  options, selected, onChange,
}: {
  options: readonly { value: T; label: string }[];
  selected: T;
  onChange: (value: T) => void;
}) {
  return (
    <View style={styles.toggle}>
      {options.map((option) => (
        <TouchableOpacity
          key={option.value}
          style={[styles.toggleBtn, selected === option.value && styles.toggleBtnActive]}
          onPress={() => onChange(option.value)}
          activeOpacity={0.7}
        >
          <Text style={[styles.toggleText, selected === option.value && styles.toggleTextActive]}>
            {option.label}
          </Text>
        </TouchableOpacity>
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  rowSpacing: { marginTop: 14 },
  label: { fontSize: 13, fontWeight: '600', color: '#3a3a3c' },
  toggle: { flexDirection: 'row', alignSelf: 'flex-start', backgroundColor: '#e5e5ea', borderRadius: 8, padding: 2 },
  toggleBtn: { paddingHorizontal: 16, paddingVertical: 6, borderRadius: 6 },
  toggleBtnActive: { backgroundColor: '#fff' },
  toggleText: { fontSize: 13, color: '#6e6e73', fontWeight: '500' },
  toggleTextActive: { color: '#1c1c1e' },
});
