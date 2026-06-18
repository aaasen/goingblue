import { useState } from 'react';
import {
  StyleSheet, Text, View, ScrollView, TouchableOpacity,
  ActivityIndicator, Alert, TextInput,
} from 'react-native';
import * as Clipboard from 'expo-clipboard';
import * as Location from 'expo-location';
import SegmentedControl from '@react-native-segmented-control/segmented-control';
import {
  V1_HEADER_CHARS, periodBitsForMask, nCharsForBits, VARS_BIT, V1_VERSION, VAR_BITS_V1,
} from '@weather/protocol';
import { API_BASE } from './account';
import LocationMap from './LocationMap';

const CHARS_PER_MESSAGE = 160; // each Garmin inReach message holds 160 characters
const FORECAST_SMS = '+1 (425) 434-5858';
const FORECAST_SMS_TEL = '+14254345858';
const DEFAULT_MESSAGES = 1;
const MESSAGE_OPTIONS = [1, 2, 3, 4, 5];
const MAX_PERIODS = 256;   // v1 header carries an 8-bit period count
const HORIZON_DAYS = 15;   // upstream forecast horizon
const FORECAST_URL = `${API_BASE}/forecast`;

const MODEL_UNAVAIL_VARS: Record<string, string[]> = {
  hres: ['freeze', 'w500', 'w600', 'w700'],
  gfs: [],
  icon: [],
  ifs: [],
};

type LocationMode = 'current' | 'custom';
const LOCATION_MODES: LocationMode[] = ['current', 'custom'];
const LOCATION_LABELS = ['Current Location', 'Custom'];

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
      { value: 'rain', label: 'Rain' },
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
  'precip', 'temp', 'tmin', 'snow', 'rain', 'freeze', 'wind',
  'cch', 'ccm', 'ccl',
  'w500', 'w600', 'w700',
]);

// Chars needed to encode `nPeriods` time periods with the given variables. The period count
// is carried directly, so resolution no longer affects the body size — only the count does.
function calcChars(nPeriods: number, varsMask: number): number {
  const bodyBits = nPeriods * periodBitsForMask(varsMask, VAR_BITS_V1);
  return V1_HEADER_CHARS + nCharsForBits(bodyBits);
}

// As many time periods as fit `maxChars` for the selected variables, bounded by the 8-bit
// header field and the forecast horizon. Returns 0 only if a single period won't fit.
function maxPeriodsFor(resHours: number, varsMask: number, maxChars: number): number {
  const periodsPerDay = resHours >= 24 ? 1 : 24 / resHours;
  const cap = Math.min(MAX_PERIODS, Math.floor(HORIZON_DAYS * periodsPerDay));
  for (let n = cap; n >= 1; n--) {
    if (calcChars(n, varsMask) <= maxChars) return n;
  }
  return 0;
}

// Day span as a short label, e.g. 2, 1.5, or "<1 day".
function formatSpan(days: number): string {
  if (days < 1) return '<1 day';
  const rounded = Math.round(days * 10) / 10;
  return `${rounded} day${rounded === 1 ? '' : 's'}`;
}

// The request leads with the protocol version and omits any period count — the server fits
// as many periods as the max response length (`c:`, in chars) allows for the chosen
// resolution and variables. `c:` is always included, even at the default length. `u:` carries
// the account token so the server can attribute the request to the user.
function buildMsg(token: string, coords: { lat: number; lon: number } | null, resHours: number, model: string, vars: string[], maxChars: number): string {
  const parts: string[] = [`v${V1_VERSION}`];
  if (coords) parts.push(`${coords.lat.toFixed(4)},${coords.lon.toFixed(4)}`);
  if (resHours < 24) parts.push(`r:${resHours}h`);
  parts.push(`m:${model}`);
  if (vars.length) parts.push(`v:${vars.join(',')}`);
  parts.push(`c:${maxChars}`);
  parts.push(`u:${token}`);
  return parts.join(' ');
}

// Parse a single "lat, lon" string into coordinates. Accepts comma- or whitespace-separated pairs
// (e.g. "47.45915, -121.45958" pasted from CalTopo). Returns null unless it's exactly two numbers.
function parseLatLon(s: string): { lat: number; lon: number } | null {
  const m = s.trim().match(/^(-?\d+(?:\.\d+)?)\s*[,\s]\s*(-?\d+(?:\.\d+)?)$/);
  if (!m) return null;
  return { lat: parseFloat(m[1]), lon: parseFloat(m[2]) };
}

interface Props {
  token: string;
  onForecastReceived: (encoded: string) => void;
}

export default function BuilderTab({ token, onForecastReceived }: Props) {
  const [locationMode, setLocationMode] = useState<LocationMode>('current');
  const [gpsCoords, setGpsCoords] = useState<{ lat: number; lon: number } | null>(null);
  const [customCoords, setCustomCoords] = useState('');
  const [resHours, setResHours] = useState(24);
  const [model, setModel] = useState('ifs');
  const [vars, setVars] = useState<Set<string>>(new Set(DEFAULT_VARS));
  const [numMessages, setNumMessages] = useState(DEFAULT_MESSAGES);
  const [numCopied, setNumCopied] = useState(false);
  const [fetching, setFetching] = useState(false);
  const [locating, setLocating] = useState(false);

  // The user picks how many 160-char messages the reply may span; that sets the response
  // length budget.
  const maxChars = numMessages * CHARS_PER_MESSAGE;

  const unavail = MODEL_UNAVAIL_VARS[model] ?? [];
  const activeVars = [...vars].filter((v) => !unavail.includes(v));
  const varsMask = activeVars.reduce((mask, v) => mask | (1 << (VARS_BIT[v] ?? -1)), 0);
  // The period count isn't user-selected: include as many time periods as the char budget allows.
  const periodsPerDay = resHours >= 24 ? 1 : 24 / resHours;
  const nPeriods = maxPeriodsFor(resHours, varsMask, maxChars);
  const fits = nPeriods > 0;
  const spanDays = nPeriods / periodsPerDay;
  const resLabel = RESOLUTIONS.find((r) => r.value === resHours)?.label ?? `${resHours}h`;

  const resolvedCoords = locationMode === 'current'
    ? gpsCoords
    : parseLatLon(customCoords);
  const coordsValid = resolvedCoords != null
    && isFinite(resolvedCoords.lat) && isFinite(resolvedCoords.lon);
  // In current-location mode we always show a preview (coords are omitted until GPS resolves);
  // in custom mode we only show a message once valid coords are entered.
  const showMessage = fits && (coordsValid || locationMode === 'current');
  const message = showMessage
    ? buildMsg(token, coordsValid ? resolvedCoords : null, resHours, model, activeVars, maxChars)
    : '';
  // In current-location mode the buttons stay tappable so they can request GPS on demand.
  const copyDisabled = locating || !fits || (locationMode === 'custom' && !coordsValid);
  const fetchDisabled = copyDisabled || fetching;

  async function requestCurrentLocation(): Promise<{ lat: number; lon: number } | null> {
    setLocating(true);
    try {
      const { status } = await Location.requestForegroundPermissionsAsync();
      if (status !== 'granted') {
        Alert.alert('Permission denied', 'Location access is required to use current location.');
        return null;
      }
      const pos = await Location.getCurrentPositionAsync({ accuracy: Location.Accuracy.Balanced });
      const coords = { lat: pos.coords.latitude, lon: pos.coords.longitude };
      setGpsCoords(coords);
      return coords;
    } catch (e) {
      Alert.alert('Error', 'Could not get location: ' + String(e));
      return null;
    } finally {
      setLocating(false);
    }
  }

  async function copyNumber() {
    await Clipboard.setStringAsync(FORECAST_SMS_TEL);
    setNumCopied(true);
    setTimeout(() => setNumCopied(false), 2000);
  }

  async function handleCopy() {
    let coords = resolvedCoords;
    if (locationMode === 'current' && !coordsValid) {
      coords = await requestCurrentLocation();
    }
    if (coords == null || !isFinite(coords.lat) || !isFinite(coords.lon)) return;
    const msg = buildMsg(token, coords, resHours, model, activeVars, maxChars);
    await Clipboard.setStringAsync(msg);
  }

  function toggleVar(v: string) {
    setVars((prev) => {
      const next = new Set(prev);
      if (next.has(v)) next.delete(v);
      else next.add(v);
      return next;
    });
  }

  async function handleFetch() {
    let coords = resolvedCoords;
    if (locationMode === 'current' && !coordsValid) {
      coords = await requestCurrentLocation();
    }
    if (coords == null || !isFinite(coords.lat) || !isFinite(coords.lon)) {
      Alert.alert('No location', 'Please set a valid location before fetching.');
      return;
    }
    setFetching(true);
    try {
      const resp = await fetch(FORECAST_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'text/plain' },
        body: buildMsg(token, coords, resHours, model, activeVars, maxChars),
      });
      if (!resp.ok) throw new Error(await resp.text());
      onForecastReceived(await resp.text());
    } catch (e) {
      Alert.alert('Error', String(e));
    } finally {
      setFetching(false);
    }
  }

  return (
    <ScrollView style={styles.scroll} contentContainerStyle={styles.content}>
      <Section label="Location">
        <SegmentedControl
          values={LOCATION_LABELS}
          selectedIndex={LOCATION_MODES.indexOf(locationMode)}
          onChange={(e) => setLocationMode(LOCATION_MODES[e.nativeEvent.selectedSegmentIndex])}
        />
        {locationMode === 'current' && (locating || gpsCoords) && (
          <View style={styles.locationStatus}>
            {locating ? (
              <ActivityIndicator size="small" color="#2a6bb5" />
            ) : (
              <Text style={styles.coordsText}>
                {gpsCoords!.lat.toFixed(4)}, {gpsCoords!.lon.toFixed(4)}
              </Text>
            )}
          </View>
        )}
        {locationMode === 'current' && gpsCoords && (
          <LocationMap coord={gpsCoords} height={160} />
        )}
        {locationMode === 'custom' && (
          <>
            <View style={styles.customCoords}>
              <View style={[styles.coordRow, styles.coordRowLast]}>
                <Text style={[styles.coordLabel, styles.coordLabelWide]}>Lat, Lon</Text>
                <TextInput
                  style={styles.coordInput}
                  value={customCoords}
                  onChangeText={setCustomCoords}
                  placeholder="47.45915, -121.45958"
                  keyboardType="numbers-and-punctuation"
                  autoCapitalize="none"
                  autoCorrect={false}
                  returnKeyType="done"
                />
              </View>
            </View>
            <Text style={styles.mapHint}>Paste “lat, lon”, or tap the map / drag the pin to set a location.</Text>
            <LocationMap
              coord={coordsValid ? resolvedCoords : null}
              onPick={(c) => setCustomCoords(`${c.lat.toFixed(5)}, ${c.lon.toFixed(5)}`)}
            />
          </>
        )}
      </Section>

      <Section label="Resolution">
        <SegmentedControl
          values={RESOLUTIONS.map((r) => r.label)}
          selectedIndex={RESOLUTIONS.findIndex((r) => r.value === resHours)}
          onChange={(e) => setResHours(RESOLUTIONS[e.nativeEvent.selectedSegmentIndex].value)}
        />
      </Section>

      <Section label="Number of Messages">
        <SegmentedControl
          values={MESSAGE_OPTIONS.map(String)}
          selectedIndex={MESSAGE_OPTIONS.indexOf(numMessages)}
          onChange={(e) => setNumMessages(MESSAGE_OPTIONS[e.nativeEvent.selectedSegmentIndex])}
        />
        <Text style={[styles.lenSummary, !fits && styles.lenOver]}>
          {fits
            ? `${formatSpan(spanDays)} · ${nPeriods} period${nPeriods === 1 ? '' : 's'}`
            : `Won't fit ${numMessages} message${numMessages === 1 ? '' : 's'} at ${resLabel} resolution — reduce variables or coarsen resolution`}
        </Text>
      </Section>

      <Section label="Model">
        <SegmentedControl
          values={MODELS.map((m) => m.label)}
          selectedIndex={MODELS.findIndex((m) => m.value === model)}
          onChange={(e) => setModel(MODELS[e.nativeEvent.selectedSegmentIndex].value)}
        />
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
                  style={[styles.varRow, idx < group.vars.length - 1 && styles.varRowBorder]}
                  onPress={() => !disabled && toggleVar(v.value)}
                  activeOpacity={disabled ? 1 : 0.6}
                >
                  <Text style={[styles.varLabel, disabled && styles.varLabelDim]}>{v.label}</Text>
                  <Text style={[styles.varCheck, !checked && styles.varCheckHidden]}>✓</Text>
                </TouchableOpacity>
              );
            })}
          </View>
        </Section>
      ))}

      <Section label="Message">
        <View style={styles.msgBox}>
          {message ? (
            <Text style={styles.msgText} selectable>{message}</Text>
          ) : (
            <Text style={styles.msgPlaceholder}>{fits ? 'Enter lat/lon above' : 'Reduce variables or coarsen resolution'}</Text>
          )}
        </View>
      </Section>

      <View style={styles.buttons}>
        <TouchableOpacity
          style={[styles.btn, styles.btnOutline, copyDisabled && styles.btnDisabled]}
          onPress={handleCopy}
          disabled={copyDisabled}
        >
          {locating ? <ActivityIndicator color="#2a6bb5" /> : <Text style={styles.btnOutlineText}>Copy Message</Text>}
        </TouchableOpacity>
        <TouchableOpacity
          style={[styles.btn, styles.btnPrimary, fetchDisabled && styles.btnDisabled]}
          onPress={handleFetch}
          disabled={fetchDisabled}
        >
          {fetching ? <ActivityIndicator color="#fff" /> : <Text style={styles.btnPrimaryText}>Fetch Forecast</Text>}
        </TouchableOpacity>
      </View>

      <Text style={styles.smsHint}>
        Copy the message and text it to the number below from your inReach. When you get a reply,
        paste it into the Decoder tab to view the forecast.
      </Text>
      <View style={styles.smsRow}>
        <Text style={styles.smsNumber} selectable>{FORECAST_SMS}</Text>
        <TouchableOpacity style={styles.smsCopyBtn} onPress={copyNumber} activeOpacity={0.7}>
          <Text style={styles.smsCopyText}>{numCopied ? 'Copied' : 'Copy'}</Text>
        </TouchableOpacity>
      </View>
    </ScrollView>
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

const styles = StyleSheet.create({
  scroll: { flex: 1, backgroundColor: '#f2f2f7' },
  content: { padding: 16, paddingBottom: 48 },

  section: { marginBottom: 20 },
  sectionLabel: { fontSize: 12, fontWeight: '600', color: '#6e6e73', textTransform: 'uppercase', letterSpacing: 0.5, marginBottom: 8 },

  varList: { backgroundColor: '#fff', borderRadius: 12, overflow: 'hidden' },
  varRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: 16, paddingVertical: 10 },
  varRowBorder: { borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: '#d1d1d6' },
  varLabel: { fontSize: 15, color: '#1c1c1e' },
  varLabelDim: { color: '#aeaeb2' },
  varCheck: { fontSize: 17, fontWeight: '600', color: '#2a6bb5' },
  varCheckHidden: { opacity: 0 },

  lenSummary: { fontSize: 13, color: '#6e6e73', marginTop: 8 },
  lenOver: { color: '#cc2222', fontWeight: '500' },

  locationStatus: { marginTop: 10, alignItems: 'flex-start' },
  coordsText: { fontFamily: 'Courier', fontSize: 13, color: '#2a6bb5' },
  customCoords: { marginTop: 10, backgroundColor: '#fff', borderRadius: 12, overflow: 'hidden' },
  coordRow: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 14, paddingVertical: 10, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: '#d1d1d6' },
  coordRowLast: { borderBottomWidth: 0 },
  coordLabel: { width: 30, fontSize: 14, fontWeight: '600', color: '#6e6e73' },
  coordLabelWide: { width: 64 },
  coordInput: { flex: 1, fontSize: 14, color: '#1c1c1e', fontFamily: 'Courier' },
  mapHint: { fontSize: 12, color: '#8e8e93', marginTop: 10 },

  msgBox: { backgroundColor: '#fff', borderRadius: 12, padding: 14 },
  msgText: { fontFamily: 'Courier', fontSize: 14, color: '#1c1c1e', lineHeight: 22 },
  msgPlaceholder: { fontFamily: 'Courier', fontSize: 14, color: '#aeaeb2', lineHeight: 22 },

  buttons: { flexDirection: 'row', gap: 12, marginTop: 4 },
  btn: { flex: 1, height: 50, borderRadius: 14, alignItems: 'center', justifyContent: 'center' },
  btnPrimary: { backgroundColor: '#2a6bb5' },
  btnOutline: { backgroundColor: '#fff', borderWidth: 1, borderColor: '#d1d1d6' },
  btnDisabled: { backgroundColor: '#aeaeb2' },
  btnPrimaryText: { color: '#fff', fontSize: 16, fontWeight: '600' },
  btnOutlineText: { color: '#2a6bb5', fontSize: 16, fontWeight: '600' },

  smsHint: { fontSize: 13, color: '#6e6e73', lineHeight: 19, marginTop: 14 },
  smsRow: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    backgroundColor: '#fff', borderRadius: 12, paddingHorizontal: 14, paddingVertical: 12, marginTop: 10,
  },
  smsNumber: { fontSize: 16, fontWeight: '600', color: '#1c1c1e', fontFamily: 'Courier' },
  smsCopyBtn: { backgroundColor: '#eef3fa', borderRadius: 8, paddingHorizontal: 16, paddingVertical: 7 },
  smsCopyText: { color: '#2a6bb5', fontSize: 14, fontWeight: '600' },
});
