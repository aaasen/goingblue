import type { ReactNode } from 'react';
import { StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import {
  ALTITUDE_UNITS, AQI_SCALES, LEVEL_UNITS, RAIN_UNITS, SNOW_UNITS, TEMP_UNITS, WIND_UNITS,
  applyUnitSystem, type AqiScale, type TimeFormat, type UnitOption, type UnitPrefs, type Units,
} from './settings';
import { palette } from './palette';

// The display preferences, as one block: Units, Time format, and Air quality. Both the setup
// screen and the Settings tab render this component rather than their own rows, so the two
// surfaces always offer the same set — a preference added here shows up in both. The one
// exception is the per-quantity unit rows under the master switch (`detailed`): Settings lists
// them, first run doesn't — a reader on their first screen picks a system, and the sailor who
// wants knots knows to look for it later.

interface Props {
  units: UnitPrefs;
  onUnitsChange: (u: UnitPrefs) => void;
  // Show the per-quantity unit rows under the master switch.
  detailed?: boolean;
  timeFormat: TimeFormat;
  onTimeFormatChange: (format: TimeFormat) => void;
  aqiScale: AqiScale;
  onAqiScaleChange: (scale: AqiScale) => void;
}

const UNITS_OPTIONS: { value: Units; label: string }[] = [
  { value: 'imperial', label: 'US' },
  { value: 'metric', label: 'Metric' },
];

const TIME_FORMAT_OPTIONS: { value: TimeFormat; label: string }[] = [
  { value: '12h', label: '12h' },
  { value: '24h', label: '24h' },
];

export default function PreferenceRows({
  units, onUnitsChange, detailed, timeFormat, onTimeFormatChange, aqiScale, onAqiScaleChange,
}: Props) {
  // One row per quantity. Each writes its own field; the master switch goes through
  // applyUnitSystem, which moves the quantities on a system's standard unit and leaves a
  // knots or hPa choice alone.
  const unitRow = <K extends keyof UnitPrefs>(label: string, key: K, options: readonly UnitOption<UnitPrefs[K]>[]) => (
    <Row label={label} spaced indented>
      <Toggle options={options} selected={units[key]} onChange={(v) => onUnitsChange({ ...units, [key]: v })} />
    </Row>
  );
  return (
    <>
      <Row label="Units">
        <Toggle options={UNITS_OPTIONS} selected={units.system}
          onChange={(system) => onUnitsChange(applyUnitSystem(units, system))} />
      </Row>
      {detailed && (
        <>
          {unitRow('Temperature', 'temp', TEMP_UNITS)}
          {unitRow('Rain', 'rain', RAIN_UNITS)}
          {unitRow('Snow', 'snow', SNOW_UNITS)}
          {unitRow('Wind', 'wind', WIND_UNITS)}
          {/* Elevation and freezing level are both heights above sea level, so one unit. */}
          {unitRow('Elevation', 'altitude', ALTITUDE_UNITS)}
          {/* The cloud band's rungs and the wind-aloft levels. */}
          {unitRow('Pressure-level', 'level', LEVEL_UNITS)}
        </>
      )}
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

function Row({ label, spaced, indented, children }: {
  label: string; spaced?: boolean; indented?: boolean; children: ReactNode;
}) {
  return (
    <View style={[styles.row, spaced && styles.rowSpacing]}>
      <Text style={[styles.label, indented && styles.labelIndented]}>{label}</Text>
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
  label: { fontSize: 13, fontWeight: '600', color: palette.textBody },
  // The per-quantity rows sit under the master switch as its detail: lighter and stepped in.
  labelIndented: { fontWeight: '500', color: palette.textSecondary, paddingLeft: 12 },
  toggle: { flexDirection: 'row', alignSelf: 'flex-start', backgroundColor: palette.toggleTrack, borderRadius: 8, padding: 2 },
  // 14 rather than 16 so the five-way wind toggle clears its label on a 360dp phone.
  toggleBtn: { paddingHorizontal: 14, paddingVertical: 6, borderRadius: 6 },
  toggleBtnActive: { backgroundColor: palette.toggleSelected },
  toggleText: { fontSize: 13, color: palette.toggleText, fontWeight: '500' },
  toggleTextActive: { color: palette.toggleSelectedText },
});
