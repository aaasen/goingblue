import { useState } from 'react';
import {
  StyleSheet, Text, View, ScrollView, TouchableOpacity,
  ActivityIndicator, Alert, TextInput,
} from 'react-native';
import * as Clipboard from 'expo-clipboard';
import * as Location from 'expo-location';
import SegmentedControl from '@react-native-segmented-control/segmented-control';
import {
  VARS_BIT, V1_VERSION,
  RESOLUTION_HOURS, DEFAULT_VARS_MASK, MODEL_BIT, type RequestContext,
} from '@weather/protocol';
import { API_BASE } from './account';
import { allocCode } from './cache';
import LocationMap from './LocationMap';
import { MODELS } from './models';

// Resolution hours → protocol resolution index (inverse of RESOLUTION_HOURS).
const RES_HOURS_TO_IDX: Record<number, number> = Object.fromEntries(
  Object.entries(RESOLUTION_HOURS).map(([idx, hours]) => [hours, Number(idx)]),
);

// The forecast start, in UTC hours since the epoch, aligned down to the resolution boundary.
// Sent in the request (`t:`) so the start is fixed against delivery delay, and stored in the
// request context so the client can reconstruct the start datetime the slim response omits.
function alignedStartEpochHour(resHours: number): number {
  return Math.floor(Math.floor(Date.now() / 3600000) / resHours) * resHours;
}

const CHARS_PER_MESSAGE = 160; // each Garmin inReach message holds 160 characters
const FORECAST_EMAIL = 'inreach@going.blue';
const DEFAULT_MESSAGES = 1;
const FORECAST_URL = `${API_BASE}/forecast`;

const MODEL_UNAVAIL_VARS: Record<string, string[]> = {
  hres: ['freeze', 'w500', 'w600', 'w700'],
  gfs: [],
  icon: [],
  ifs: ['freeze'],
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

// Variables included in every request; not user-selectable.
const ALWAYS_VARS = ['precip', 'temp', 'tmin', 'snow', 'rain', 'wind'];

// User-selectable variable groups. Each toggle enables/disables all of its underlying
// protocol variables together (e.g. "Clouds" covers high/mid/low cloud cover, not total).
const VAR_GROUPS = [
  { value: 'clouds', label: 'Clouds', vars: ['cch', 'ccm', 'ccl'] },
  { value: 'highwind', label: 'High Altitude Winds', vars: ['w500', 'w600', 'w700'] },
  { value: 'freeze', label: 'Freezing Level', vars: ['freeze'] },
];

// Clouds on by default; high altitude winds and freezing level off.
const DEFAULT_GROUPS = new Set(['clouds']);

// The request leads with the protocol version and omits any period count — the server fits
// as many periods as the max response length (`c:`, in chars) allows for the chosen
// resolution and variables. `c:` is always included, even at the default length. `u:` carries
// the account token so the server can attribute the request to the user. `k:` is the message code
// the slim response echoes so the client can recover the request context (see cache.ts).
function buildMsg(token: string, coords: { lat: number; lon: number } | null, resHours: number, model: string, vars: string[], maxChars: number, code: number, startEpochHour: number): string {
  const parts: string[] = [`v${V1_VERSION}`];
  if (coords) parts.push(`${coords.lat.toFixed(4)},${coords.lon.toFixed(4)}`);
  if (resHours < 24) parts.push(`r:${resHours}h`);
  parts.push(`m:${model}`);
  if (vars.length) parts.push(`v:${vars.join(',')}`);
  parts.push(`c:${maxChars}`);
  parts.push(`u:${token}`);
  parts.push(`k:${code}`);
  parts.push(`t:${startEpochHour}`);
  return parts.join(' ');
}

// The request context the client stores under the message code, mirroring how the server will
// parse this request (so the recovered fields exactly match what the response was encoded with).
function buildContext(coords: { lat: number; lon: number }, resHours: number, model: string, varsMask: number, startEpochHour: number): RequestContext {
  return {
    resolution: RES_HOURS_TO_IDX[resHours] ?? 0,
    model: MODEL_BIT[model.toUpperCase()] ?? 0, // single model index
    vars_mask: varsMask === 0 ? DEFAULT_VARS_MASK : varsMask, // mirror the server's empty-vars default
    lat: coords.lat,
    lon: coords.lon,
    start: startEpochHour * 3600000, // UTC epoch ms
  };
}

// Parse a single "lat, lon" string into coordinates. Accepts comma- or whitespace-separated pairs,
// optionally wrapped in parentheses (e.g. "(-44.9412396, -99.8386085)"). Returns null unless it's
// exactly two numbers.
function parseLatLon(s: string): { lat: number; lon: number } | null {
  let value = s.trim();
  const hasOpeningParen = value.startsWith('(');
  const hasClosingParen = value.endsWith(')');
  if (hasOpeningParen !== hasClosingParen) return null;
  if (hasOpeningParen) value = value.slice(1, -1).trim();
  const m = value.match(/^(-?\d+(?:\.\d+)?)\s*[,\s]\s*(-?\d+(?:\.\d+)?)$/);
  if (!m) return null;
  return { lat: parseFloat(m[1]), lon: parseFloat(m[2]) };
}

interface Props {
  token: string;
  onForecastReceived: (encoded: string) => void;
  active: boolean;
}

export default function BuilderTab({ token, onForecastReceived, active }: Props) {
  const [locationMode, setLocationMode] = useState<LocationMode>('current');
  const [gpsCoords, setGpsCoords] = useState<{ lat: number; lon: number } | null>(null);
  const [customCoords, setCustomCoords] = useState('');
  const [resHours, setResHours] = useState(3);
  const [model, setModel] = useState('hres');
  const [groups, setGroups] = useState<Set<string>>(new Set(DEFAULT_GROUPS));
  const [numCopied, setNumCopied] = useState(false);
  const [fetching, setFetching] = useState(false);
  const [locating, setLocating] = useState(false);

  // The reply always spans a single 160-char message; that sets the response length budget.
  const maxChars = DEFAULT_MESSAGES * CHARS_PER_MESSAGE;

  const unavail = MODEL_UNAVAIL_VARS[model] ?? [];
  // At 1h resolution each period is a single hourly sample, so tmin is identical to temp
  // (the max) — drop it rather than send a redundant column.
  const resUnavail = resHours === 1 ? ['tmin'] : [];
  // Expand the always-on variables plus any enabled groups, then drop ones the model or
  // resolution can't supply.
  const selectedVars = new Set(ALWAYS_VARS);
  for (const g of VAR_GROUPS) {
    if (groups.has(g.value)) for (const v of g.vars) selectedVars.add(v);
  }
  const activeVars = [...selectedVars].filter((v) => !unavail.includes(v) && !resUnavail.includes(v));
  const varsMask = activeVars.reduce((mask, v) => mask | (1 << (VARS_BIT[v] ?? -1)), 0);
  const resLabel = RESOLUTIONS.find((r) => r.value === resHours)?.label ?? `${resHours}h`;

  const parsedCustomCoords = parseLatLon(customCoords);
  const customCoordsInvalid = customCoords.trim().length > 0 && parsedCustomCoords == null;
  const resolvedCoords = locationMode === 'current'
    ? gpsCoords
    : parsedCustomCoords;
  const coordsValid = resolvedCoords != null
    && isFinite(resolvedCoords.lat) && isFinite(resolvedCoords.lon);
  // In current-location mode we always show a preview (coords are omitted until GPS resolves);
  // in custom mode we only show a message once valid coords are entered.
  const showMessage = coordsValid || locationMode === 'current';
  // Preview only — the real message code is allocated on copy/fetch (buildContext + allocCode).
  const message = showMessage
    ? buildMsg(token, coordsValid ? resolvedCoords : null, resHours, model, activeVars, maxChars, 0, alignedStartEpochHour(resHours))
    : '';
  // In current-location mode the buttons stay tappable so they can request GPS on demand.
  const copyDisabled = locating || (locationMode === 'custom' && !coordsValid);
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
    await Clipboard.setStringAsync(FORECAST_EMAIL);
    setNumCopied(true);
    setTimeout(() => setNumCopied(false), 2000);
  }

  async function handleCopy() {
    let coords = resolvedCoords;
    if (locationMode === 'current' && !coordsValid) {
      coords = await requestCurrentLocation();
    }
    if (coords == null || !isFinite(coords.lat) || !isFinite(coords.lon)) return;
    const startHour = alignedStartEpochHour(resHours);
    const code = await allocCode(token, buildContext(coords, resHours, model, varsMask, startHour), `${resLabel} · ${model.toUpperCase()}`);
    const msg = buildMsg(token, coords, resHours, model, activeVars, maxChars, code, startHour);
    await Clipboard.setStringAsync(msg);
  }

  function toggleGroup(v: string) {
    setGroups((prev) => {
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
      const startHour = alignedStartEpochHour(resHours);
      const code = await allocCode(token, buildContext(coords, resHours, model, varsMask, startHour), `${resLabel} · ${model.toUpperCase()}`);
      const resp = await fetch(FORECAST_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'text/plain' },
        body: buildMsg(token, coords, resHours, model, activeVars, maxChars, code, startHour),
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
        {locationMode === 'custom' && (
          <>
            <View style={[styles.customCoords, customCoordsInvalid && styles.customCoordsInvalid]}>
              <View style={[styles.coordRow, styles.coordRowLast]}>
                <Text style={[styles.coordLabel, styles.coordLabelWide]}>Coordinates</Text>
                <TextInput
                  style={[styles.coordInput, customCoordsInvalid && styles.coordInputInvalid]}
                  value={customCoords}
                  onChangeText={setCustomCoords}
                  placeholder="latitude, longitude"
                  keyboardType="numbers-and-punctuation"
                  autoCapitalize="none"
                  autoCorrect={false}
                  returnKeyType="done"
                />
              </View>
            </View>
            <Text style={styles.mapHint}>Tap the map to set a location</Text>
            <LocationMap
              coord={coordsValid ? resolvedCoords : null}
              onPick={(c) => setCustomCoords(`${c.lat.toFixed(5)}, ${c.lon.toFixed(5)}`)}
              active={active}
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

      <Section label="Model">
        <SegmentedControl
          values={MODELS.map((m) => m.label)}
          selectedIndex={MODELS.findIndex((m) => m.value === model)}
          onChange={(e) => setModel(MODELS[e.nativeEvent.selectedSegmentIndex].value)}
        />
      </Section>

      <Section label="Variables">
        <View style={styles.varList}>
          {VAR_GROUPS.map((group, idx) => {
            // A group is unavailable when the model can't supply any of its variables.
            const disabled = group.vars.every((v) => unavail.includes(v));
            const checked = groups.has(group.value) && !disabled;
            return (
              <TouchableOpacity
                key={group.value}
                style={[styles.varRow, idx < VAR_GROUPS.length - 1 && styles.varRowBorder]}
                onPress={() => !disabled && toggleGroup(group.value)}
                activeOpacity={disabled ? 1 : 0.6}
              >
                <Text style={[styles.varLabel, disabled && styles.varLabelDim]}>{group.label}</Text>
                <Text style={[styles.varCheck, !checked && styles.varCheckHidden]}>✓</Text>
              </TouchableOpacity>
            );
          })}
        </View>
      </Section>

      <Section label="Message">
        <View style={styles.msgBox}>
          {message ? (
            <Text style={styles.msgText} selectable>{message}</Text>
          ) : (
            <Text style={styles.msgPlaceholder}>Enter lat/lon above</Text>
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
        Copy the message and email it to the address below from your inReach. When you get a reply,
        paste it into the Decoder tab to view the forecast.
      </Text>
      <View style={styles.smsRow}>
        <Text style={styles.smsNumber} selectable>{FORECAST_EMAIL}</Text>
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

  customCoords: { marginTop: 10, backgroundColor: '#fff', borderRadius: 12, overflow: 'hidden' },
  customCoordsInvalid: { borderWidth: 1, borderColor: '#cc2222' },
  coordRow: { flexDirection: 'row', alignItems: 'baseline', paddingHorizontal: 14, paddingVertical: 12, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: '#d1d1d6' },
  coordRowLast: { borderBottomWidth: 0 },
  coordLabel: { width: 30, fontSize: 15, fontWeight: '600', color: '#6e6e73' },
  coordLabelWide: { width: 104 },
  coordInput: { flex: 1, fontSize: 15, color: '#1c1c1e' },
  coordInputInvalid: { color: '#cc2222' },
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
