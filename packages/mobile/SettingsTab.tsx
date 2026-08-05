import { StyleSheet, Text, View, ScrollView, Linking, TouchableOpacity, Alert } from 'react-native';
import * as Clipboard from 'expo-clipboard';
import { formatToken } from '@weather/protocol';
import UnitsToggle from './UnitsToggle';
import type { TimeFormat, Units } from './settings';

// ── Reference data (mirrors the web decoder's "Model details" section) ───────

interface ModelInfo {
  name: string;
  color: string;
  full: string;
  res: string;
  temporal: string;
  length: string;
  updates: string;
  // [label, supported]
  vars: [string, boolean][];
}

const MODELS: ModelInfo[] = [
  {
    name: 'Auto', color: '#2a6bb5', full: 'Highest-res model for your location',
    res: 'up to 2 km', temporal: '1h → 3h → 6h', length: '16 d', updates: 'continuous',
    vars: [
      ['precip', true], ['temp', true], ['snow', true], ['freeze', true],
      ['sfc wind', true], ['500w', true], ['600w', true], ['700w', true], ['cloud', true],
    ],
  },
  {
    name: 'American', color: '#2a8f5a', full: 'GFS + HRRR seamless (NOAA)',
    res: '3 → 13 km', temporal: '1h → 3h', length: '16 d', updates: 'hourly',
    vars: [
      ['precip', true], ['temp', true], ['snow', true], ['freeze', true],
      ['sfc wind', true], ['500w', true], ['600w', true], ['700w', true], ['cloud', true],
    ],
  },
  {
    name: 'Canadian', color: '#c0102a', full: 'GEM + HRDPS seamless (ECCC)',
    res: '2.5 → 15 km', temporal: '1h → 3h', length: '10 d', updates: '4×/day',
    vars: [
      ['precip', true], ['temp', true], ['snow', true], ['freeze', false],
      ['sfc wind', true], ['500w', true], ['600w', true], ['700w', true], ['cloud', true],
    ],
  },
  {
    name: 'European', color: '#7040b0', full: 'ECMWF HRES 9 km + IFS 0.25° upper winds',
    res: '9 km', temporal: '1h → 3h → 6h', length: '15 d', updates: '4×/day',
    vars: [
      ['precip', true], ['temp', true], ['snow', true], ['freeze', false],
      ['sfc wind', true], ['500w', true], ['600w', true], ['700w', true], ['cloud', true],
    ],
  },
];

interface VarInfo {
  name: string;
  desc: string;
  agg: string;
}

const VARIABLES: VarInfo[] = [
  { name: 'WMO code', desc: 'Weather condition code per WMO table 4677 (clear, cloudy, rain, snow, fog, thunderstorm, etc.).', agg: 'First in period' },
  { name: 'Precip %', desc: 'Probability that any given hour in the period receives ≥ 0.1 mm of precipitation, derived from ensemble model spread.', agg: 'Max' },
  { name: 'Max Temp', desc: 'Maximum air temperature at 2 m above ground during the period.', agg: 'Max' },
  { name: 'Min Temp', desc: 'Minimum air temperature at 2 m above ground during the period.', agg: 'Min' },
  { name: 'Snow', desc: 'New snowfall accumulation during the period.', agg: 'Sum' },
  { name: 'Freeze level', desc: 'Altitude above sea level where the 0 °C isotherm occurs.', agg: 'Max' },
  { name: 'Wind', desc: 'Sustained wind speed and direction at 10 m above ground.', agg: 'Peak sustained speed; dominant direction weighted by speed' },
  { name: 'Gust', desc: 'Peak wind gust at 10 m above ground.', agg: 'Peak gust speed' },
  { name: '500 hPa wind', desc: 'Wind at ~18,000 ft (upper troposphere / jet-stream level).', agg: 'Peak sustained speed; dominant direction weighted by speed' },
  { name: '600 hPa wind', desc: 'Wind at ~14,000 ft.', agg: 'Peak sustained speed; dominant direction weighted by speed' },
  { name: '700 hPa wind', desc: 'Wind at ~10,000 ft.', agg: 'Peak sustained speed; dominant direction weighted by speed' },
  { name: 'Cloud (total)', desc: 'Fraction of sky covered by all cloud layers combined.', agg: 'Max' },
  { name: 'Cloud (high)', desc: 'Cloud cover from cirrus and other high-level clouds above 8 km.', agg: 'Max' },
  { name: 'Cloud (mid)', desc: 'Cloud cover from mid-level clouds between 3–8 km.', agg: 'Max' },
  { name: 'Cloud (low)', desc: 'Cloud cover from low-level clouds and fog below 3 km.', agg: 'Max' },
];

// ── Component ────────────────────────────────────────────────────────────────

export default function SettingsTab({ token, onReset, units, onUnitsChange, timeFormat, onTimeFormatChange }: {
  token: string;
  onReset: () => void;
  units: Units;
  onUnitsChange: (u: Units) => void;
  timeFormat: TimeFormat;
  onTimeFormatChange: (format: TimeFormat) => void;
}) {
  const RESET_MESSAGE =
    'This forgets the token on this device and returns to setup. The account still exists on the server — make sure you’ve saved the token if you want to get back to it.';

  function confirmReset() {
    Alert.alert('Reset account?', RESET_MESSAGE, [
      { text: 'Cancel', style: 'cancel' },
      { text: 'Reset', style: 'destructive', onPress: onReset },
    ]);
  }

  return (
    <ScrollView style={styles.scroll} contentContainerStyle={styles.content}>
      {/* Preferences */}
      <Text style={styles.heading}>Preferences</Text>
      <View style={styles.card}>
        <View style={styles.preferenceRow}>
          <Text style={styles.controlLabel}>Units</Text>
          <UnitsToggle units={units} onChange={onUnitsChange} />
        </View>
        <View style={[styles.preferenceRow, styles.preferenceRowSpacing]}>
          <Text style={styles.controlLabel}>Time format</Text>
          <View style={styles.toggle}>
            {(['12h', '24h'] as const).map((format) => (
              <TouchableOpacity
                key={format}
                style={[styles.toggleBtn, timeFormat === format && styles.toggleBtnActive]}
                onPress={() => onTimeFormatChange(format)}
                activeOpacity={0.7}
              >
                <Text style={[styles.toggleText, timeFormat === format && styles.toggleTextActive]}>{format}</Text>
              </TouchableOpacity>
            ))}
          </View>
        </View>
      </View>

      {/* Account */}
      <Text style={[styles.heading, { marginTop: 28 }]}>Your account</Text>
      <View style={styles.card}>
        <Text style={styles.tokenValue} selectable>{formatToken(token)}</Text>
        <Text style={styles.tokenNote}>
          This token identifies your account. Save it to move your account to another device — enter
          it under “I already have a token” during setup.
        </Text>
        <View style={styles.accountBtns}>
          <TouchableOpacity
            style={styles.copyBtn}
            onPress={() => Clipboard.setStringAsync(token)}
            activeOpacity={0.7}
          >
            <Text style={styles.copyBtnText}>Copy token</Text>
          </TouchableOpacity>
          <TouchableOpacity style={styles.resetBtn} onPress={confirmReset} activeOpacity={0.7}>
            <Text style={styles.resetBtnText}>Reset account</Text>
          </TouchableOpacity>
        </View>
      </View>

      {/* Model details */}
      <Text style={[styles.heading, { marginTop: 28 }]}>Model details</Text>
      {MODELS.map((m) => (
        <View key={m.name} style={styles.card}>
          <View style={styles.cardHeader}>
            <View style={[styles.dot, { backgroundColor: m.color }]} />
            <Text style={styles.cardTitle}>{m.name}</Text>
            <Text style={styles.cardSubtitle}>{m.full}</Text>
          </View>
          <View style={styles.specGrid}>
            <Spec label="Resolution" value={m.res} />
            <Spec label="Temporal" value={m.temporal} />
            <Spec label="Length" value={m.length} />
            <Spec label="Updates" value={m.updates} />
          </View>
          <View style={styles.chips}>
            {m.vars.map(([label, ok]) => (
              <Text key={label} style={[styles.chip, ok ? styles.chipOk : styles.chipNo]}>
                {ok ? label : `${label} ✕`}
              </Text>
            ))}
          </View>
        </View>
      ))}

      {/* Variables */}
      <Text style={[styles.heading, { marginTop: 28 }]}>Variables</Text>
      {VARIABLES.map((v) => (
        <View key={v.name} style={styles.varCard}>
          <Text style={styles.varName}>{v.name}</Text>
          <Text style={styles.varDesc}>{v.desc}</Text>
          <Text style={styles.varAgg}>
            <Text style={styles.varAggLabel}>Aggregation: </Text>{v.agg}
          </Text>
        </View>
      ))}

      <Text style={styles.footer}>
        Weather data provided by{' '}
        <Text style={styles.link} onPress={() => Linking.openURL('https://open-meteo.com/')}>
          Open-Meteo
        </Text>.
      </Text>
    </ScrollView>
  );
}

function Spec({ label, value }: { label: string; value: string }) {
  return (
    <View style={styles.spec}>
      <Text style={styles.specLabel}>{label}</Text>
      <Text style={styles.specValue}>{value}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  scroll: { flex: 1, backgroundColor: '#f2f2f7' },
  // Bottom pad covers the home-indicator inset the scroll view now extends under.
  content: { padding: 16, paddingBottom: 72 },

  heading: { fontSize: 13, fontWeight: '700', color: '#8e8e93', textTransform: 'uppercase', letterSpacing: 0.5, marginBottom: 12 },
  link: { color: '#2a6bb5', textDecorationLine: 'underline' },

  card: { backgroundColor: '#fff', borderRadius: 12, padding: 14, marginBottom: 12 },
  preferenceRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  preferenceRowSpacing: { marginTop: 14 },
  controlLabel: { fontSize: 13, fontWeight: '600', color: '#3a3a3c' },
  toggle: { flexDirection: 'row', alignSelf: 'flex-start', backgroundColor: '#e5e5ea', borderRadius: 8, padding: 2 },
  toggleBtn: { paddingHorizontal: 20, paddingVertical: 6, borderRadius: 6 },
  toggleBtnActive: { backgroundColor: '#fff' },
  toggleText: { fontSize: 13, color: '#6e6e73', fontWeight: '500' },
  toggleTextActive: { color: '#1c1c1e' },
  tokenValue: { fontSize: 20, fontWeight: '600', fontFamily: 'Courier', color: '#1c1c1e', letterSpacing: 1, marginBottom: 10 },
  tokenNote: { fontSize: 13, color: '#6e6e73', lineHeight: 19, marginBottom: 12 },
  accountBtns: { flexDirection: 'row', gap: 10 },
  copyBtn: { backgroundColor: '#eef3fa', borderRadius: 8, paddingHorizontal: 14, paddingVertical: 8 },
  copyBtnText: { color: '#2a6bb5', fontSize: 14, fontWeight: '600' },
  resetBtn: { backgroundColor: '#faecec', borderRadius: 8, paddingHorizontal: 14, paddingVertical: 8 },
  resetBtnText: { color: '#cc2222', fontSize: 14, fontWeight: '600' },
  cardHeader: { flexDirection: 'row', alignItems: 'center', flexWrap: 'wrap', marginBottom: 12 },
  dot: { width: 10, height: 10, borderRadius: 5, marginRight: 8 },
  cardTitle: { fontSize: 16, fontWeight: '700', color: '#1c1c1e', marginRight: 8 },
  cardSubtitle: { fontSize: 13, color: '#8e8e93' },

  specGrid: { flexDirection: 'row', flexWrap: 'wrap', marginBottom: 12 },
  spec: { width: '50%', marginBottom: 8 },
  specLabel: { fontSize: 11, color: '#8e8e93', textTransform: 'uppercase', letterSpacing: 0.3, marginBottom: 2 },
  specValue: { fontSize: 14, color: '#1c1c1e', fontWeight: '500' },

  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: 6 },
  chip: { fontSize: 12, paddingHorizontal: 8, paddingVertical: 3, borderRadius: 6, overflow: 'hidden' },
  chipOk: { backgroundColor: '#e3f2ea', color: '#2a8f5a' },
  chipNo: { backgroundColor: '#f7eae3', color: '#b05020', textDecorationLine: 'line-through' },

  varCard: { backgroundColor: '#fff', borderRadius: 12, padding: 14, marginBottom: 10 },
  varName: { fontSize: 15, fontWeight: '600', color: '#1c1c1e', marginBottom: 6 },
  varDesc: { fontSize: 13, color: '#3a3a3c', lineHeight: 19, marginBottom: 6 },
  varAgg: { fontSize: 12, color: '#6e6e73', lineHeight: 17 },
  varAggLabel: { fontWeight: '700', color: '#8e8e93' },

  footer: { fontSize: 13, color: '#8e8e93', marginTop: 20, lineHeight: 19 },
});
