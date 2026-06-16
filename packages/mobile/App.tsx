import { useState } from 'react';
import {
  StyleSheet,
  Text,
  View,
  ScrollView,
  TouchableOpacity,
  Share,
  ActivityIndicator,
  Alert,
  SafeAreaView,
  Switch,
} from 'react-native';
import { StatusBar } from 'expo-status-bar';
import {
  HEADER_CHARS,
  periodBitsForMask,
  nCharsForBits,
  VARS_BIT,
  VERSION,
  VAR_BITS,
} from '@weather/protocol';

const MAX_CHARS = 160;
const FORECAST_URL = 'https://weather.laneaasen.com/forecast';

const MODEL_UNAVAIL_VARS: Record<string, string[]> = {
  hres: ['freeze', 'w500', 'w600', 'w700'],
  gfs: [],
  icon: [],
  ifs: [],
};

const LOCATIONS = [
  { value: 'current', label: 'Current' },
  { value: '11k', label: '11k' },
  { value: '14k', label: '14k' },
  { value: '17k', label: '17k' },
  { value: 'summit', label: 'Summit' },
  { value: 'airstrip', label: 'Airstrip' },
];

const RESOLUTIONS = [
  { value: 1, label: '1h' },
  { value: 3, label: '3h' },
  { value: 6, label: '6h' },
  { value: 12, label: '12h' },
  { value: 24, label: '24h' },
];

const MODELS = [
  { value: 'hres', label: 'HRES' },
  { value: 'ifs', label: 'ECMWF' },
  { value: 'gfs', label: 'GFS' },
  { value: 'icon', label: 'ICON' },
];

const VAR_GROUPS = [
  {
    label: 'Surface',
    vars: [
      { value: 'precip', label: 'Precip %' },
      { value: 'temp', label: 'Max Temp' },
      { value: 'tmin', label: 'Min Temp' },
      { value: 'snow', label: 'Snow' },
      { value: 'freeze', label: 'Freezing Level' },
      { value: 'wind', label: 'Wind' },
    ],
  },
  {
    label: 'Cloud',
    vars: [
      { value: 'cc', label: 'Total' },
      { value: 'cch', label: 'High' },
      { value: 'ccm', label: 'Mid' },
      { value: 'ccl', label: 'Low' },
    ],
  },
  {
    label: 'Pressure Levels',
    vars: [
      { value: 'w500', label: '500mb Wind' },
      { value: 'w600', label: '600mb Wind' },
      { value: 'w700', label: '700mb Wind' },
    ],
  },
];

const DEFAULT_VARS = new Set([
  'precip', 'temp', 'tmin', 'snow', 'freeze', 'wind',
  'cch', 'ccm', 'ccl',
  'w500', 'w600', 'w700',
]);

function calcChars(days: number, resHours: number, varsMask: number): number {
  const periodsPerDay = resHours >= 24 ? 1 : 24 / resHours;
  const bodyBits = days * periodsPerDay * periodBitsForMask(varsMask, VAR_BITS);
  return HEADER_CHARS + nCharsForBits(bodyBits);
}

function buildMsg(location: string, days: number, resHours: number, model: string, vars: string[]): string {
  const parts: string[] = [];
  if (location && location !== 'current') parts.push(`l:${location}`);
  parts.push(`d:${days}`);
  if (resHours < 24) parts.push(`r:${resHours}h`);
  parts.push(`m:${model}`);
  if (vars.length) parts.push(`v:${vars.join(',')}`);
  parts.push(`v${VERSION}`);
  return parts.join(' ');
}

export default function App() {
  const [location, setLocation] = useState('14k');
  const [days, setDays] = useState(7);
  const [resHours, setResHours] = useState(24);
  const [model, setModel] = useState('ifs');
  const [vars, setVars] = useState<Set<string>>(new Set(DEFAULT_VARS));
  const [fetching, setFetching] = useState(false);

  const unavail = MODEL_UNAVAIL_VARS[model] ?? [];
  const activeVars = [...vars].filter((v) => !unavail.includes(v));
  const varsMask = activeVars.reduce((mask, v) => mask | (1 << (VARS_BIT[v] ?? -1)), 0);
  const nChars = calcChars(days, resHours, varsMask);
  const over = nChars > MAX_CHARS;
  const message = buildMsg(location, days, resHours, model, activeVars);

  function toggleVar(v: string) {
    setVars((prev) => {
      const next = new Set(prev);
      if (next.has(v)) next.delete(v);
      else next.add(v);
      return next;
    });
  }

  async function handleShare() {
    await Share.share({ message });
  }

  async function handleFetch() {
    setFetching(true);
    try {
      const resp = await fetch(FORECAST_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'text/plain' },
        body: message,
      });
      if (!resp.ok) throw new Error(await resp.text());
      const encoded = await resp.text();
      Alert.alert('Forecast received', encoded, [
        { text: 'Share', onPress: () => Share.share({ message: encoded }) },
        { text: 'OK' },
      ]);
    } catch (e) {
      Alert.alert('Error', String(e));
    } finally {
      setFetching(false);
    }
  }

  return (
    <SafeAreaView style={styles.safe}>
      <StatusBar style="dark" />
      <ScrollView style={styles.scroll} contentContainerStyle={styles.content}>
        <Text style={styles.title}>Forecast Request</Text>

        <Section label="Location">
          <ScrollView horizontal showsHorizontalScrollIndicator={false}>
            <View style={styles.pills}>
              {LOCATIONS.map((l) => (
                <Pill
                  key={l.value}
                  label={l.label}
                  selected={location === l.value}
                  onPress={() => setLocation(l.value)}
                />
              ))}
            </View>
          </ScrollView>
        </Section>

        <Section label={`Days: ${days}`}>
          <View style={styles.stepper}>
            <StepBtn label="−" onPress={() => setDays((d) => Math.max(1, d - 1))} />
            <View style={styles.stepTrack}>
              <View style={[styles.stepFill, { flex: days }]} />
              <View style={{ flex: 10 - days }} />
            </View>
            <StepBtn label="+" onPress={() => setDays((d) => Math.min(10, d + 1))} />
          </View>
        </Section>

        <Section label="Resolution">
          <View style={styles.pills}>
            {RESOLUTIONS.map((r) => (
              <Pill
                key={r.value}
                label={r.label}
                selected={resHours === r.value}
                onPress={() => setResHours(r.value)}
              />
            ))}
          </View>
        </Section>

        <Section label="Model">
          <View style={styles.pills}>
            {MODELS.map((m) => (
              <Pill
                key={m.value}
                label={m.label}
                selected={model === m.value}
                onPress={() => setModel(m.value)}
              />
            ))}
          </View>
        </Section>

        {VAR_GROUPS.map((group) => (
          <Section key={group.label} label={group.label}>
            <View style={styles.varList}>
              {group.vars.map((v, idx) => {
                const disabled = unavail.includes(v.value);
                const checked = vars.has(v.value) && !disabled;
                return (
                  <TouchableOpacity
                    key={v.value}
                    style={[
                      styles.varRow,
                      idx < group.vars.length - 1 && styles.varRowBorder,
                    ]}
                    onPress={() => !disabled && toggleVar(v.value)}
                    activeOpacity={disabled ? 1 : 0.6}
                  >
                    <Text style={[styles.varLabel, disabled && styles.varLabelDim]}>
                      {v.label}
                    </Text>
                    <Switch
                      value={checked}
                      onValueChange={() => !disabled && toggleVar(v.value)}
                      disabled={disabled}
                      trackColor={{ false: '#d1d1d6', true: '#2a6bb5' }}
                      thumbColor="#fff"
                    />
                  </TouchableOpacity>
                );
              })}
            </View>
          </Section>
        ))}

        <Section label="Forecast Length">
          <View style={styles.lenTrack}>
            <View
              style={[
                styles.lenFill,
                {
                  flex: Math.min(nChars, MAX_CHARS),
                  backgroundColor: over ? '#cc2222' : '#2a8f5a',
                },
              ]}
            />
            <View style={{ flex: Math.max(MAX_CHARS - nChars, 0) }} />
          </View>
          <Text style={[styles.lenText, over ? styles.lenOver : styles.lenOk]}>
            {over
              ? `${nChars} chars — exceeds ${MAX_CHARS}, reduce days or variables`
              : `${nChars} / ${MAX_CHARS} chars`}
          </Text>
        </Section>

        <Section label="Message">
          <View style={styles.msgBox}>
            <Text style={styles.msgText} selectable>
              {message}
            </Text>
          </View>
        </Section>

        <View style={styles.buttons}>
          <TouchableOpacity style={[styles.btn, styles.btnOutline]} onPress={handleShare}>
            <Text style={styles.btnOutlineText}>Share</Text>
          </TouchableOpacity>
          <TouchableOpacity
            style={[styles.btn, styles.btnPrimary, over && styles.btnDisabled]}
            onPress={handleFetch}
            disabled={over || fetching}
          >
            {fetching ? (
              <ActivityIndicator color="#fff" />
            ) : (
              <Text style={styles.btnPrimaryText}>Fetch Forecast</Text>
            )}
          </TouchableOpacity>
        </View>
      </ScrollView>
    </SafeAreaView>
  );
}

function Section({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <View style={styles.section}>
      <Text style={styles.sectionLabel}>{label}</Text>
      {children}
    </View>
  );
}

function Pill({
  label,
  selected,
  onPress,
}: {
  label: string;
  selected: boolean;
  onPress: () => void;
}) {
  return (
    <TouchableOpacity
      style={[styles.pill, selected && styles.pillSelected]}
      onPress={onPress}
      activeOpacity={0.7}
    >
      <Text style={[styles.pillText, selected && styles.pillTextSelected]}>{label}</Text>
    </TouchableOpacity>
  );
}

function StepBtn({ label, onPress }: { label: string; onPress: () => void }) {
  return (
    <TouchableOpacity style={styles.stepBtn} onPress={onPress} activeOpacity={0.7}>
      <Text style={styles.stepBtnText}>{label}</Text>
    </TouchableOpacity>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: '#f2f2f7' },
  scroll: { flex: 1 },
  content: { padding: 16, paddingBottom: 48 },

  title: { fontSize: 22, fontWeight: '700', color: '#1c1c1e', marginBottom: 20 },

  section: { marginBottom: 20 },
  sectionLabel: {
    fontSize: 12,
    fontWeight: '600',
    color: '#6e6e73',
    textTransform: 'uppercase',
    letterSpacing: 0.5,
    marginBottom: 8,
  },

  pills: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  pill: {
    paddingHorizontal: 16,
    paddingVertical: 8,
    borderRadius: 20,
    backgroundColor: '#fff',
    borderWidth: 1,
    borderColor: '#d1d1d6',
  },
  pillSelected: { backgroundColor: '#2a6bb5', borderColor: '#2a6bb5' },
  pillText: { fontSize: 14, fontWeight: '500', color: '#1c1c1e' },
  pillTextSelected: { color: '#fff' },

  stepper: { flexDirection: 'row', alignItems: 'center', gap: 12 },
  stepBtn: {
    width: 36,
    height: 36,
    borderRadius: 18,
    backgroundColor: '#fff',
    borderWidth: 1,
    borderColor: '#d1d1d6',
    alignItems: 'center',
    justifyContent: 'center',
  },
  stepBtnText: { fontSize: 20, color: '#1c1c1e', lineHeight: 24 },
  stepTrack: {
    flex: 1,
    height: 6,
    flexDirection: 'row',
    borderRadius: 3,
    backgroundColor: '#e5e5ea',
    overflow: 'hidden',
  },
  stepFill: { height: 6, backgroundColor: '#2a6bb5', borderRadius: 3 },

  varList: { backgroundColor: '#fff', borderRadius: 12, overflow: 'hidden' },
  varRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 16,
    paddingVertical: 10,
  },
  varRowBorder: {
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: '#d1d1d6',
  },
  varLabel: { fontSize: 15, color: '#1c1c1e' },
  varLabelDim: { color: '#aeaeb2' },

  lenTrack: {
    height: 8,
    flexDirection: 'row',
    borderRadius: 4,
    backgroundColor: '#e5e5ea',
    overflow: 'hidden',
    marginBottom: 6,
  },
  lenFill: { height: 8 },
  lenText: { fontSize: 13 },
  lenOk: { color: '#2a8f5a' },
  lenOver: { color: '#cc2222', fontWeight: '500' },

  msgBox: { backgroundColor: '#fff', borderRadius: 12, padding: 14 },
  msgText: { fontFamily: 'Courier', fontSize: 14, color: '#1c1c1e', lineHeight: 22 },

  buttons: { flexDirection: 'row', gap: 12, marginTop: 4 },
  btn: { flex: 1, height: 50, borderRadius: 14, alignItems: 'center', justifyContent: 'center' },
  btnPrimary: { backgroundColor: '#2a6bb5' },
  btnOutline: { backgroundColor: '#fff', borderWidth: 1, borderColor: '#d1d1d6' },
  btnDisabled: { backgroundColor: '#aeaeb2' },
  btnPrimaryText: { color: '#fff', fontSize: 16, fontWeight: '600' },
  btnOutlineText: { color: '#2a6bb5', fontSize: 16, fontWeight: '600' },
});
