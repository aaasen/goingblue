import { useState } from 'react';
import {
  StyleSheet, Text, View, ScrollView, TouchableOpacity,
  ActivityIndicator, Alert, TextInput, Modal, Linking,
} from 'react-native';
import * as Clipboard from 'expo-clipboard';
import * as Location from 'expo-location';
import SegmentedControl from '@react-native-segmented-control/segmented-control';
import {
  VARS_BIT, V1_VERSION,
  ALWAYS_VARS_MASK, CONFIGURABLE_VAR_GROUPS, MODEL_BIT,
  MODE_DETAIL, MODE_AUTO, MODE_RANGE, type RequestContext,
} from '@weather/protocol';
import { API_BASE } from './account';
import { deviceOffsetHours, offsetHoursAt } from './timezone';
import { allocCode } from './cache';
import LocationMap from './LocationMap';
import { MODELS } from './models';

// The request time, in UTC hours since the epoch, aligned down to the hour. Sent in the request
// (`t:`) so the forecast window is fixed against delivery delay, and stored in the request
// context so the client can reconstruct the period layout the slim response omits.
function alignedStartEpochHour(): number {
  return Math.floor(Date.now() / 3600000);
}

// The UTC offset the forecast's local-midnight period grid aligns to (`z:`), in whole hours —
// the FORECAST POINT's offset, looked up from its coordinates (see timezone.ts), so a location in
// another timezone gets its own midnight rather than the reader's. Derived rather than passed
// around: buildMsg and buildContext must agree exactly on the value, and a pure function of the
// same coordinates and instant can't drift between them.
function requestOffsetHours(coords: { lat: number; lon: number } | null, startEpochHour: number): number {
  return coords ? offsetHoursAt(coords.lat, coords.lon, startEpochHour * 3600000) : deviceOffsetHours();
}

const CHARS_PER_MESSAGE = 160; // one SMS segment holds 160 characters (satellite messengers bill per segment)
const FORECAST_NUMBER = '(425) 434-5858';
const DEFAULT_MESSAGES = 1;
const FORECAST_URL = `${API_BASE}/forecast`;

// Variables a forecast center can't supply. Only the freezing level varies now — GEM and ECMWF
// have no freezing-level product (Europe's pressure winds are filled from IFS 0.25°).
const MODEL_UNAVAIL_VARS: Record<string, string[]> = {
  best: [],
  us: [],
  ca: ['freeze'],
  eu: ['freeze'],
};

type LocationMode = 'current' | 'custom';
const LOCATION_MODES: LocationMode[] = ['current', 'custom'];
const LOCATION_LABELS = ['Current Location', 'Custom'];

// Priority modes. The server fills the reply by walking the mode's refinement path — Detail
// spends the budget on hourly detail first, Range on covering the whole horizon first, Auto
// balances the two. A mode is a priority, not a promise: the weather's entropy decides how far
// the fill gets, so the copy carries no hour/day numbers.
const PRIORITIES = [
  { value: MODE_DETAIL, token: 'd', label: 'Detail' },
  { value: MODE_AUTO, token: 'a', label: 'Auto' },
  { value: MODE_RANGE, token: 'r', label: 'Range' },
];

// Model-selector help copy. Each line pairs the option's flag label with the forecast center(s)
// behind it and, where it's a blend, the short-range/global pair with resolution and horizon.
const MODEL_INFO = [
  { name: '🌐 Auto', desc: 'Chooses the highest resolution model for your location from over 30 regional weather models' },
  { name: '🇺🇸 US', desc: 'Blend of HRRR (3km, 48hr, continental US) and GFS (13km, 16 day, global)' },
  { name: '🇨🇦 CA', desc: 'Blend of HRDPS (2.5km, 48hr, Canada) and GEM (15km, 10 day, global)' },
  { name: '🇪🇺 EU', desc: 'IFS HRES (9km, 15 day, global)' },
];
const OPEN_METEO_DOCS = 'https://open-meteo.com/en/docs#data_sources';

// Help copy for the optional variable groups. Each optional variable costs response length, so
// the modal closes by noting the trade-off against forecast detail and range.
const VAR_INFO = [
  { name: 'Precip Chance', desc: 'Chance of any precipitation during each period' },
  { name: 'Detailed Clouds', desc: 'Low (<3km), medium (3-8km), and high (>8km) cloud cover' },
  { name: 'High Altitude Winds', desc: 'Winds at 500, 600, and 700 hPa pressure levels' },
  { name: 'Freezing Level', desc: 'Altitude at which atmospheric temperature drops to 0°C' },
];

// User-selectable variable groups. Each toggle enables/disables all of its underlying
// protocol variables together (e.g. "Clouds" covers high/mid/low cloud cover, not total).
const VAR_GROUPS = [
  { value: 'precip', code: 'p', label: 'Precip Chance', vars: CONFIGURABLE_VAR_GROUPS.p },
  { value: 'clouds', code: 'c', label: 'Detailed Clouds', vars: CONFIGURABLE_VAR_GROUPS.c },
  { value: 'highwind', code: 'w', label: 'High Altitude Winds', vars: CONFIGURABLE_VAR_GROUPS.w },
  { value: 'freeze', code: 'f', label: 'Freezing Level', vars: CONFIGURABLE_VAR_GROUPS.f },
];

// No extra variables selected by default.
const DEFAULT_GROUPS = new Set<string>();

// The request leads with the protocol version and picks a priority mode (`p:`), not a duration
// or resolution — the server fills the max response length (`c:`, in chars) along the mode's
// path. `z:` is the local-midnight UTC offset the period grid aligns to. `c:` is always
// included, even at the default length. `u:` carries the account token so the server can
// attribute the request to the user. `k:` is the message code the slim response echoes so the
// client can recover the request context (see cache.ts).
function buildMsg(token: string, coords: { lat: number; lon: number } | null, mode: number, model: string, variableCodes: string[], maxChars: number, code: number, startEpochHour: number): string {
  const parts: string[] = [`v${V1_VERSION}`];
  if (coords) parts.push(`${coords.lat.toFixed(4)},${coords.lon.toFixed(4)}`);
  parts.push(`p:${PRIORITIES.find((m) => m.value === mode)!.token}`);
  parts.push(`z:${requestOffsetHours(coords, startEpochHour)}`);
  parts.push(`m:${model}`);
  if (variableCodes.length) parts.push(`v:${variableCodes.join('')}`);
  parts.push(`c:${maxChars}`);
  parts.push(`u:${token}`);
  parts.push(`k:${code}`);
  parts.push(`t:${startEpochHour}`);
  return parts.join(' ');
}

// The request context the client stores under the message code, mirroring how the server will
// parse this request (so the recovered fields exactly match what the response was encoded with).
function buildContext(coords: { lat: number; lon: number }, mode: number, model: string, varsMask: number, startEpochHour: number): RequestContext {
  return {
    mode,
    utcOffsetHours: requestOffsetHours(coords, startEpochHour),
    model: MODEL_BIT[model.toUpperCase()] ?? 0, // single model index
    vars_mask: varsMask,
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
  const [mode, setMode] = useState(MODE_AUTO);
  const [model, setModel] = useState('best');
  const [groups, setGroups] = useState<Set<string>>(new Set(DEFAULT_GROUPS));
  const [messageCopied, setMessageCopied] = useState(false);
  const [numCopied, setNumCopied] = useState(false);
  const [fetching, setFetching] = useState(false);
  const [locating, setLocating] = useState(false);
  const [priorityInfo, setPriorityInfo] = useState(false);
  const [modelInfo, setModelInfo] = useState(false);
  const [varsInfo, setVarsInfo] = useState(false);

  // The reply always spans a single 160-char message; that sets the response length budget.
  const maxChars = DEFAULT_MESSAGES * CHARS_PER_MESSAGE;

  const unavail = MODEL_UNAVAIL_VARS[model] ?? [];
  // Expand the always-on variables plus any enabled groups for the stored request context. Only
  // configurable variables go in the message because the server adds the always-on set.
  const activeGroups = VAR_GROUPS
    .filter((g) => groups.has(g.value))
    .map((g) => ({ ...g, vars: g.vars.filter((v) => !unavail.includes(v)) }))
    .filter((g) => g.vars.length > 0);
  const configurableVars = activeGroups.flatMap((g) => g.vars);
  const variableCodes = activeGroups.map((g) => g.code);
  const varsMask = configurableVars.reduce(
    (mask, v) => mask | (1 << (VARS_BIT[v] ?? -1)),
    ALWAYS_VARS_MASK,
  );
  const modeName = PRIORITIES.find((m) => m.value === mode)!.label;

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
    ? buildMsg(token, coordsValid ? resolvedCoords : null, mode, model, variableCodes, maxChars, 0, alignedStartEpochHour())
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
    await Clipboard.setStringAsync(FORECAST_NUMBER);
    setNumCopied(true);
    setTimeout(() => setNumCopied(false), 2000);
  }

  async function handleCopy() {
    let coords = resolvedCoords;
    if (locationMode === 'current' && !coordsValid) {
      coords = await requestCurrentLocation();
    }
    if (coords == null || !isFinite(coords.lat) || !isFinite(coords.lon)) return;
    const startHour = alignedStartEpochHour();
    const code = await allocCode(token, buildContext(coords, mode, model, varsMask, startHour), `${modeName} · ${model.toUpperCase()}`);
    const msg = buildMsg(token, coords, mode, model, variableCodes, maxChars, code, startHour);
    await Clipboard.setStringAsync(msg);
    setMessageCopied(true);
    setTimeout(() => setMessageCopied(false), 2000);
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
      const startHour = alignedStartEpochHour();
      const code = await allocCode(token, buildContext(coords, mode, model, varsMask, startHour), `${modeName} · ${model.toUpperCase()}`);
      const resp = await fetch(FORECAST_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'text/plain' },
        body: buildMsg(token, coords, mode, model, variableCodes, maxChars, code, startHour),
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

      <Section label="Priority" info={() => setPriorityInfo(true)}>
        <SegmentedControl
          values={PRIORITIES.map((m) => m.label)}
          selectedIndex={PRIORITIES.findIndex((m) => m.value === mode)}
          onChange={(e) => setMode(PRIORITIES[e.nativeEvent.selectedSegmentIndex].value)}
        />
      </Section>

      <Section label="Model" info={() => setModelInfo(true)}>
        <SegmentedControl
          values={MODELS.map((m) => m.label)}
          selectedIndex={MODELS.findIndex((m) => m.value === model)}
          onChange={(e) => setModel(MODELS[e.nativeEvent.selectedSegmentIndex].value)}
        />
      </Section>

      <Section label="Extra Variables" info={() => setVarsInfo(true)}>
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
          style={[
            styles.btn,
            styles.btnOutline,
            messageCopied && styles.btnSuccess,
            copyDisabled && styles.btnDisabled,
          ]}
          onPress={handleCopy}
          disabled={copyDisabled}
        >
          {locating ? (
            <ActivityIndicator color="#2a6bb5" />
          ) : (
            <Text style={[styles.btnOutlineText, messageCopied && styles.btnSuccessText]}>
              {messageCopied ? '✓ Copied' : 'Copy Message'}
            </Text>
          )}
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
        Copy the message above and text it to the number below from your phone or satellite messenger. When
        you get a reply, paste it into the Decoder tab to view the forecast.
      </Text>
      <View style={styles.smsRow}>
        <Text style={styles.smsNumber} selectable>{FORECAST_NUMBER}</Text>
        <TouchableOpacity style={styles.smsCopyBtn} onPress={copyNumber} activeOpacity={0.7}>
          <Text style={styles.smsCopyText}>{numCopied ? 'Copied' : 'Copy'}</Text>
        </TouchableOpacity>
      </View>

      <InfoModal visible={priorityInfo} title="Priority" onClose={() => setPriorityInfo(false)}>
        <Text style={styles.modalBody}>
          Going Blue packs as much information as it can into each message. Choose{' '}
          <Text style={styles.modalBold}>Detail</Text> for short-range hourly forecasts. Choose{' '}
          <Text style={styles.modalBold}>Range</Text> for extended forecasts up to 14 days. Choose{' '}
          <Text style={styles.modalBold}>Auto</Text> for a blend of the two.
        </Text>
      </InfoModal>

      <InfoModal visible={modelInfo} title="Model" onClose={() => setModelInfo(false)}>
        {MODEL_INFO.map((m) => (
          <Text key={m.name} style={styles.modalItem}>
            <Text style={styles.modalBold}>{m.name}</Text> — {m.desc}
          </Text>
        ))}
        <Text style={styles.modalBody}>
          For model details, see{' '}
          <Text style={styles.modalLink} onPress={() => Linking.openURL(OPEN_METEO_DOCS)}>
            Open-Meteo
          </Text>
          .
        </Text>
      </InfoModal>

      <InfoModal visible={varsInfo} title="Extra Variables" onClose={() => setVarsInfo(false)}>
        <Text style={styles.modalBody}>
          By default, Going Blue forecasts include temperature, precipitation, wind, and basic cloud
          cover. The following variables are optional:
        </Text>
        {VAR_INFO.map((v) => (
          <Text key={v.name} style={styles.modalItemIndent}>
            <Text style={styles.modalBold}>{v.name}</Text> — {v.desc}
          </Text>
        ))}
        <Text style={[styles.modalBody, styles.modalNote]}>Each added variable takes away from the detail and range of each forecast.</Text>
      </InfoModal>
    </ScrollView>
  );
}

function Section({ label, info, children }: { label: string; info?: () => void; children: React.ReactNode }) {
  return (
    <View style={styles.section}>
      <View style={styles.sectionHeader}>
        <Text style={styles.sectionLabel}>{label}</Text>
        {info && (
          <TouchableOpacity
            onPress={info}
            hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}
            accessibilityRole="button"
            accessibilityLabel={`About ${label}`}
          >
            <Text style={styles.sectionInfo}>ⓘ</Text>
          </TouchableOpacity>
        )}
      </View>
      {children}
    </View>
  );
}

function InfoModal({ visible, title, onClose, children }: {
  visible: boolean; title: string; onClose: () => void; children: React.ReactNode;
}) {
  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={onClose}>
      <TouchableOpacity style={styles.modalBackdrop} activeOpacity={1} onPress={onClose}>
        <TouchableOpacity style={styles.modalCard} activeOpacity={1}>
          <Text style={styles.modalTitle}>{title}</Text>
          {children}
          <TouchableOpacity style={styles.modalButton} onPress={onClose} accessibilityRole="button">
            <Text style={styles.modalButtonText}>Got it</Text>
          </TouchableOpacity>
        </TouchableOpacity>
      </TouchableOpacity>
    </Modal>
  );
}

const styles = StyleSheet.create({
  scroll: { flex: 1, backgroundColor: '#f2f2f7' },
  // Bottom pad covers the home-indicator inset the scroll view now extends under.
  content: { padding: 16, paddingBottom: 72 },

  modalBackdrop: { flex: 1, backgroundColor: 'rgba(0,0,0,0.4)', alignItems: 'center', justifyContent: 'center', padding: 32 },
  modalCard: { backgroundColor: '#fff', borderRadius: 16, padding: 20, width: '100%', maxWidth: 340 },
  modalTitle: { fontSize: 18, fontWeight: '700', color: '#1c1c1e', marginBottom: 10 },
  modalBody: { fontSize: 15, color: '#3a3a3c', lineHeight: 22 },
  modalItem: { fontSize: 15, color: '#3a3a3c', lineHeight: 22, marginBottom: 10 },
  modalItemIndent: { fontSize: 15, color: '#3a3a3c', lineHeight: 22, marginTop: 10, paddingLeft: 12 },
  modalBold: { fontWeight: '700', color: '#1c1c1e' },
  modalNote: { marginTop: 14 },
  modalLink: { color: '#2a6bb5', textDecorationLine: 'underline' },
  modalButton: { marginTop: 18, height: 44, borderRadius: 12, backgroundColor: '#2a6bb5', alignItems: 'center', justifyContent: 'center' },
  modalButtonText: { color: '#fff', fontSize: 16, fontWeight: '600' },

  section: { marginBottom: 20 },
  sectionHeader: { flexDirection: 'row', alignItems: 'center', marginBottom: 8 },
  sectionLabel: { fontSize: 12, fontWeight: '600', color: '#6e6e73', textTransform: 'uppercase', letterSpacing: 0.5 },
  sectionInfo: { fontSize: 14, color: '#2a6bb5', marginLeft: 6 },

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
  btnSuccess: { backgroundColor: '#e8f5ec', borderColor: '#2a8f5a' },
  btnDisabled: { backgroundColor: '#aeaeb2' },
  btnPrimaryText: { color: '#fff', fontSize: 16, fontWeight: '600' },
  btnOutlineText: { color: '#2a6bb5', fontSize: 16, fontWeight: '600' },
  btnSuccessText: { color: '#2a8f5a' },

  smsHint: { fontSize: 13, color: '#6e6e73', lineHeight: 19, marginTop: 14 },
  smsRow: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    backgroundColor: '#fff', borderRadius: 12, paddingHorizontal: 14, paddingVertical: 12, marginTop: 10,
  },
  smsNumber: { fontSize: 16, fontWeight: '600', color: '#1c1c1e', fontFamily: 'Courier' },
  smsCopyBtn: { backgroundColor: '#eef3fa', borderRadius: 8, paddingHorizontal: 16, paddingVertical: 7 },
  smsCopyText: { color: '#2a6bb5', fontSize: 14, fontWeight: '600' },
});
