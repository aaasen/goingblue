import { StyleSheet, Text, View, ScrollView, Linking, TouchableOpacity } from 'react-native';
import * as Clipboard from 'expo-clipboard';
import { formatToken } from '@weather/protocol';

const FORECAST_EMAIL = 'wx@email.laneaasen.com';

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
    name: 'ECMWF HRES', color: '#2a6bb5', full: 'ECMWF IFS HRES',
    res: '9 km', temporal: '1h → 3h → 6h', length: '15 d', updates: '4×/day',
    vars: [
      ['precip', true], ['temp', true], ['snow', true], ['freeze', false],
      ['sfc wind', true], ['500w', false], ['600w', false], ['700w', false], ['cloud', true],
    ],
  },
  {
    name: 'ECMWF', color: '#7040b0', full: 'ECMWF IFS 0.25°',
    res: '25 km', temporal: '3h → 6h', length: '15 d', updates: '4×/day',
    vars: [
      ['precip', true], ['temp', true], ['snow', true], ['freeze', true],
      ['sfc wind', true], ['500w', true], ['600w', true], ['700w', true], ['cloud', true],
    ],
  },
  {
    name: 'GFS', color: '#2a8f5a', full: 'GFS (NOAA)',
    res: '25 km', temporal: '1h', length: '16 d', updates: '4×/day',
    vars: [
      ['precip', true], ['temp', true], ['snow', true], ['freeze', true],
      ['sfc wind', true], ['500w', true], ['600w', true], ['700w', true], ['cloud', true],
    ],
  },
  {
    name: 'ICON', color: '#c06010', full: 'ICON (DWD)',
    res: '11 km', temporal: '1h', length: '7.5 d', updates: '3×/day',
    vars: [
      ['precip', true], ['temp', true], ['snow', true], ['freeze', true],
      ['sfc wind', true], ['500w', true], ['600w', true], ['700w', true], ['cloud', true],
    ],
  },
];

interface VarInfo {
  name: string;
  desc: string;
  unit: string;
  agg: string;
}

const VARIABLES: VarInfo[] = [
  { name: 'WMO code', desc: 'Weather condition code per WMO table 4677 (clear, cloudy, rain, snow, fog, thunderstorm, etc.).', unit: 'code', agg: 'First in period' },
  { name: 'Precip %', desc: 'Probability that any given hour in the period receives ≥ 0.1 mm of precipitation, derived from ensemble model spread.', unit: '%', agg: 'Max' },
  { name: 'Max Temp', desc: 'Maximum air temperature at 2 m above ground during the period.', unit: '°F', agg: 'Max' },
  { name: 'Min Temp', desc: 'Minimum air temperature at 2 m above ground during the period.', unit: '°F', agg: 'Min' },
  { name: 'Snow', desc: 'New snowfall accumulation during the period.', unit: 'in', agg: 'Sum' },
  { name: 'Freeze level', desc: 'Altitude above sea level where the 0 °C isotherm occurs.', unit: 'ft', agg: 'Max' },
  { name: 'Wind', desc: 'Wind speed and direction at 10 m above ground.', unit: 'mph', agg: 'Peak gust speed; dominant direction weighted by speed' },
  { name: '500 hPa wind', desc: 'Wind at ~18,000 ft (upper troposphere / jet-stream level).', unit: 'mph', agg: 'Peak gust speed; dominant direction weighted by speed' },
  { name: '600 hPa wind', desc: 'Wind at ~14,000 ft.', unit: 'mph', agg: 'Peak gust speed; dominant direction weighted by speed' },
  { name: '700 hPa wind', desc: 'Wind at ~10,000 ft.', unit: 'mph', agg: 'Peak gust speed; dominant direction weighted by speed' },
  { name: 'Cloud (total)', desc: 'Fraction of sky covered by all cloud layers combined.', unit: '%', agg: 'Max' },
  { name: 'Cloud (high)', desc: 'Cloud cover from cirrus and other high-level clouds above 8 km.', unit: '%', agg: 'Max' },
  { name: 'Cloud (mid)', desc: 'Cloud cover from mid-level clouds between 3–8 km.', unit: '%', agg: 'Max' },
  { name: 'Cloud (low)', desc: 'Cloud cover from low-level clouds and fog below 3 km.', unit: '%', agg: 'Max' },
  { name: 'Visibility', desc: 'Horizontal viewing distance at ground level, affected by fog, precipitation, and aerosols.', unit: 'km', agg: 'Min' },
];

// ── Component ────────────────────────────────────────────────────────────────

export default function InfoTab({ token }: { token: string }) {
  return (
    <ScrollView style={styles.scroll} contentContainerStyle={styles.content}>
      {/* Account */}
      <Text style={styles.heading}>Your account</Text>
      <View style={styles.card}>
        <Text style={styles.tokenValue} selectable>{formatToken(token)}</Text>
        <Text style={styles.tokenNote}>
          This token identifies your account. Save it to move your account to another device — enter
          it under “I already have a token” during setup.
        </Text>
        <TouchableOpacity
          style={styles.copyBtn}
          onPress={() => Clipboard.setStringAsync(token)}
          activeOpacity={0.7}
        >
          <Text style={styles.copyBtnText}>Copy token</Text>
        </TouchableOpacity>
      </View>

      {/* Getting started */}
      <Text style={[styles.heading, { marginTop: 28 }]}>Getting started</Text>
      <Text style={styles.para}>
        This app uses a custom weather forecast encoding to pack as much weather data as possible
        into each satellite message.
      </Text>

      <Step n={1} title="Build a request">
        On the <Bold>Builder</Bold> tab, choose your location, weather model, and variables. Each
        message is limited to 160 characters, so you may need to reduce the number of variables or
        the resolution to fit within the limit.
      </Step>
      <Step n={2} title="Send it">
        Tap <Bold>Share</Bold> and send the request to{' '}
        <Text style={styles.link} onPress={() => Linking.openURL(`mailto:${FORECAST_EMAIL}`)}>
          {FORECAST_EMAIL}
        </Text>{' '}
        from the Garmin Messenger app on your inReach device.
      </Step>
      <Step n={3} title="Decode the reply">
        When you receive a response, copy it and paste it into the <Bold>Decoder</Bold> tab to
        visualize the forecast. Decoded forecasts are cached on your device so you can revisit them
        offline under “Past forecasts.”
      </Step>

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
          <View style={styles.varHeader}>
            <Text style={styles.varName}>{v.name}</Text>
            <Text style={styles.varUnit}>{v.unit}</Text>
          </View>
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

function Bold({ children }: { children: React.ReactNode }) {
  return <Text style={styles.bold}>{children}</Text>;
}

function Step({ n, title, children }: { n: number; title: string; children: React.ReactNode }) {
  return (
    <View style={styles.step}>
      <View style={styles.stepNum}>
        <Text style={styles.stepNumText}>{n}</Text>
      </View>
      <View style={{ flex: 1 }}>
        <Text style={styles.stepTitle}>{title}</Text>
        <Text style={styles.para}>{children}</Text>
      </View>
    </View>
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
  content: { padding: 16, paddingBottom: 48 },

  heading: { fontSize: 13, fontWeight: '700', color: '#8e8e93', textTransform: 'uppercase', letterSpacing: 0.5, marginBottom: 12 },
  para: { fontSize: 14, color: '#3a3a3c', lineHeight: 21, marginBottom: 12 },
  bold: { fontWeight: '700', color: '#1c1c1e' },
  link: { color: '#2a6bb5', textDecorationLine: 'underline' },

  step: { flexDirection: 'row', gap: 12, marginBottom: 4 },
  stepNum: { width: 24, height: 24, borderRadius: 12, backgroundColor: '#2a6bb5', alignItems: 'center', justifyContent: 'center', marginTop: 1 },
  stepNumText: { color: '#fff', fontSize: 13, fontWeight: '700' },
  stepTitle: { fontSize: 15, fontWeight: '600', color: '#1c1c1e', marginBottom: 4 },

  card: { backgroundColor: '#fff', borderRadius: 12, padding: 14, marginBottom: 12 },
  tokenValue: { fontSize: 20, fontWeight: '600', fontFamily: 'Courier', color: '#1c1c1e', letterSpacing: 1, marginBottom: 10 },
  tokenNote: { fontSize: 13, color: '#6e6e73', lineHeight: 19, marginBottom: 12 },
  copyBtn: { alignSelf: 'flex-start', backgroundColor: '#eef3fa', borderRadius: 8, paddingHorizontal: 14, paddingVertical: 8 },
  copyBtnText: { color: '#2a6bb5', fontSize: 14, fontWeight: '600' },
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
  varHeader: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: 6 },
  varName: { fontSize: 15, fontWeight: '600', color: '#1c1c1e' },
  varUnit: { fontSize: 13, color: '#8e8e93', fontFamily: 'Courier' },
  varDesc: { fontSize: 13, color: '#3a3a3c', lineHeight: 19, marginBottom: 6 },
  varAgg: { fontSize: 12, color: '#6e6e73', lineHeight: 17 },
  varAggLabel: { fontWeight: '700', color: '#8e8e93' },

  footer: { fontSize: 13, color: '#8e8e93', marginTop: 20, lineHeight: 19 },
});
