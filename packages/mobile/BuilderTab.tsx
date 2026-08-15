import { useEffect, useRef, useState } from 'react';
import {
  StyleSheet, Text, View, ScrollView, TouchableOpacity,
  ActivityIndicator, Alert, TextInput, Modal, Linking, Platform,
} from 'react-native';
import * as Clipboard from 'expo-clipboard';
import * as Location from 'expo-location';
import * as Network from 'expo-network';
import MaterialCommunityIcons from '@expo/vector-icons/MaterialCommunityIcons';
import SegmentedControl from '@react-native-segmented-control/segmented-control';
import {
  VARS_BIT, V2_VERSION,
  ALWAYS_VARS_MASK, CONFIGURABLE_VAR_GROUPS, MODEL_BIT,
  MODE_DETAIL, MODE_AUTO, MODE_RANGE, predictCenter, estimatedLastFullRunMs, FILL_SLOTS,
  type RequestContext, type Center,
} from '@weather/protocol';
import { API_BASE } from './account';
import { deviceOffsetHours, offsetHoursAt } from './timezone';
import { allocCode } from './cache';
import LocationMap from './LocationMap';
import HelpScreen from './HelpScreen';
import { MODELS } from './models';
import { DEVICES, type Device } from './devices';

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
// Same number in E.164, for the sms: URL — the display form's punctuation isn't a valid recipient.
const FORECAST_NUMBER_E164 = '+14254345858';
const DEFAULT_MESSAGES = 1;
const FORECAST_URL = `${API_BASE}/forecast`;
// How long to wait on the forecast fetch before giving up. A connection the OS calls up but that
// carries nothing — a captive portal, a bar of stalled signal — otherwise hangs on the platform's
// own timeout, a minute of spinner with nothing to show for it.
const FETCH_TIMEOUT_MS = 15000;
// Shown both under a greyed-out Get Forecast and when the fetch times out: the same fact either
// way, and both times the answer is to take one of the other two routes — which now means changing
// the device rather than reaching for a different button.
const OFFLINE_MESSAGE = 'Not connected to the internet. Choose SMS or inReach to send your request instead.';

// Every way current location can fail ends at the same fallback: pick the spot yourself. Current
// location is a convenience — nothing in the app needs it — so these say what went wrong and then
// point at the map rather than treating a refusal as a dead end.
const LOCATION_FALLBACK = 'Pick a forecast location on the map instead.';
const LOCATION_DENIED = `Location access was denied. ${LOCATION_FALLBACK}`;
// Separate from the above because the OS stops showing its permission prompt after a hard denial,
// so tapping again does nothing and Settings is the only way back to current location.
const LOCATION_BLOCKED =
  'Location access is off for Going Blue. Turn it on in Settings or pick a forecast location ' +
  'on the map.';
const LOCATION_FAILED = `Couldn’t get your current location. ${LOCATION_FALLBACK}`;

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

// Stands in for the model stack until there's a location to attribute. Every selector option but
// EU resolves differently from place to place, so without coordinates there's nothing to name.
const MODEL_HINT_NO_LOCATION = 'Set a location to see which models will be used.';

// Device-selector help copy. Each line says what the button does on that device and what the route
// costs the user — data, a text message, or satellite airtime.
const DEVICE_INFO = [
  { name: 'Internet', desc: 'Fetches the forecast straight over your data connection, for when you still have service' },
  { name: 'SMS', desc: 'Opens Messages with the request ready to send, for weak cell reception without data' },
  { name: 'inReach', desc: 'Copies the request so you can paste it into your satellite messenger' },
];

// Help copy for the optional variable groups. Each optional variable costs response length, so
// the modal closes by noting the trade-off against forecast detail and range.
const VAR_INFO = [
  { name: 'Detailed Clouds', desc: 'Low (<3km), medium (3-8km), and high (>8km) cloud cover' },
  { name: 'High Altitude Winds', desc: 'Winds at 500, 600, and 700 hPa pressure levels' },
  { name: 'Freezing Level', desc: 'Altitude at which atmospheric temperature drops to 0°C' },
  { name: 'Precip Chance', desc: 'Chance of any precipitation during each period' },
];

// User-selectable variable groups. Each toggle enables/disables all of its underlying
// protocol variables together (e.g. "Clouds" covers high/mid/low cloud cover, not total).
// Order is display order only — the server ORs the `v:` codes into a mask, so the emitted
// order carries no meaning. Precip chance sits last: it costs the most for the least detail.
const VAR_GROUPS = [
  { value: 'clouds', code: 'c', label: 'Detailed Clouds', vars: CONFIGURABLE_VAR_GROUPS.c },
  { value: 'highwind', code: 'w', label: 'High Altitude Winds', vars: CONFIGURABLE_VAR_GROUPS.w },
  { value: 'freeze', code: 'f', label: 'Freezing Level', vars: CONFIGURABLE_VAR_GROUPS.f },
  { value: 'precip', code: 'p', label: 'Precip Chance', vars: CONFIGURABLE_VAR_GROUPS.p },
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
  const parts: string[] = [`v${V2_VERSION}`];
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

// Hand-off URL for the system SMS composer, addressed to the forecast number with the request
// prefilled. iOS separates the body with `&`, Android with `?`. Neither platform lets an app put
// an SMS on the wire on its own — the composer opens and the user taps send.
function smsUrl(body: string): string {
  const separator = Platform.OS === 'ios' ? '&' : '?';
  return `sms:${FORECAST_NUMBER_E164}${separator}body=${encodeURIComponent(body)}`;
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

// The last instant any forecast can reach: the end of the final day slot the fill path can cover
// (see layout.ts — the remainder of the request day plus FILL_HORIZON_DAYS whole local days).
// The maximum, not what a given request will get — how far the fill actually reaches depends on
// the weather's entropy, which isn't knowable before the reply comes back.
function forecastWindowEndMs(coords: { lat: number; lon: number }, startEpochHour: number): number {
  const offset = requestOffsetHours(coords, startEpochHour);
  const day0 = Math.floor((startEpochHour + offset) / 24) * 24; // local midnight of the request day
  return (day0 + 24 * FILL_SLOTS - offset) * 3600000;
}

// The models the selected option actually serves this location from, in the order they take over
// as each one's horizon runs out. Times come from the aligned request hour rather than the wall
// clock, so this reads the same instant the request would be stamped with.
//
// predictCenter returns Open-Meteo's priority order, which is a per-variable fill order, not a
// timeline: a model below another one is there to fill values the one above lacks at an hour it
// already covers. Two things therefore keep a model out of the chain. It's shadowed — nothing it
// reaches is left uncovered by the models above it, as with the ICON that sits under a GFS which
// both outranks and outlasts it over Seattle. Or it only comes into range past the end of the
// forecast window, which is where most of the trailing global models go: over the Alps IFS covers
// every slot the fill can reach, so the GFS behind it is real in the API and unreachable here.
//
// The survivors can still repeat a label: the AROME 15-minute domains carry their parent's short
// label and reach ~6 hours ahead of it, so both clear the horizon test. Keeping each label's
// first appearance leaves one entry per distinct model.
function modelStackLabel(
  model: string,
  coords: { lat: number; lon: number },
  startEpochHour: number,
): string | null {
  const nowMs = startEpochHour * 3600000;
  const windowEndMs = forecastWindowEndMs(coords, startEpochHour);
  const labels: string[] = [];
  let covered = 0;
  for (const spec of predictCenter(model as Center, coords.lat, coords.lon).models) {
    if (covered >= windowEndMs) break;
    const end = estimatedLastFullRunMs(spec, nowMs) + spec.horizonHours * 3600000;
    if (end <= covered) continue;
    covered = end;
    const label = `${spec.shortLabel} ${spec.resKm}km`;
    if (!labels.includes(label)) labels.push(label);
  }
  return labels.length ? labels.join(' › ') : null;
}

interface Props {
  token: string;
  onForecastReceived: (encoded: string) => void;
  active: boolean;
  // Owned by App so it can be read from storage behind the splash — see App.tsx.
  device: Device;
  onDeviceChange: (device: Device) => void;
}

export default function BuilderTab({ token, onForecastReceived, active, device, onDeviceChange }: Props) {
  const [locationMode, setLocationMode] = useState<LocationMode>('current');
  const [gpsCoords, setGpsCoords] = useState<{ lat: number; lon: number } | null>(null);
  const [customCoords, setCustomCoords] = useState('');
  const [mode, setMode] = useState(MODE_AUTO);
  const [model, setModel] = useState('best');
  const [groups, setGroups] = useState<Set<string>>(new Set(DEFAULT_GROUPS));
  const [messageCopied, setMessageCopied] = useState(false);
  const [fetching, setFetching] = useState(false);
  const [locating, setLocating] = useState(false);
  const [priorityInfo, setPriorityInfo] = useState(false);
  const [deviceInfo, setDeviceInfo] = useState(false);
  const [modelInfo, setModelInfo] = useState(false);
  const [varsInfo, setVarsInfo] = useState(false);
  const [help, setHelp] = useState(false);
  // Only `isConnected` is portable: iOS reports `isInternetReachable` as a copy of it rather than
  // verifying anything, so treating them as two signals would promise more than the OS gives. It's
  // undefined until the first reading lands, which isn't yet grounds to call the user offline —
  // hence the explicit `=== false`, so the button doesn't flicker disabled on mount.
  const offline = Network.useNetworkState().isConnected === false;

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
  // What the selected option resolves to here, so the choice isn't abstract: "Auto" means a 2km
  // model in the Alps and a 9km one over the Alaska Range, and the US and Canadian stacks drop to
  // their global member outside their short-range domains. Which models serve depends on run age,
  // hence the clock — but only through horizons that move together, so the chain is stable enough
  // that recomputing it on render is all it needs.
  const modelStack = coordsValid
    ? modelStackLabel(model, resolvedCoords, alignedStartEpochHour())
    : null;
  // In current-location mode the button stays tappable so it can request GPS on demand.
  const sendDisabled = locating || (locationMode === 'custom' && !coordsValid);
  const fetchDisabled = sendDisabled || fetching || offline;

  // Read the phone's position, assuming permission is already in hand. Null when no fix came back
  // — indoors, airplane mode, a cold start that timed out. Says nothing itself: its two callers
  // differ only in whether a failure is worth reporting, so that stays with them.
  async function fetchPosition(): Promise<{ lat: number; lon: number } | null> {
    try {
      const pos = await Location.getCurrentPositionAsync({ accuracy: Location.Accuracy.Balanced });
      const coords = { lat: pos.coords.latitude, lon: pos.coords.longitude };
      setGpsCoords(coords);
      return coords;
    } catch {
      return null;
    }
  }

  async function requestCurrentLocation(): Promise<{ lat: number; lon: number } | null> {
    setLocating(true);
    try {
      const { status, canAskAgain } = await Location.requestForegroundPermissionsAsync();
      if (status !== 'granted') {
        // Offer Settings only once the OS has stopped asking. While it still prompts, tapping
        // the button again is the shorter way back, and Settings isn't where a soft denial gets
        // fixed. openSettings lands on the app's own page — a deep link to the Location pane
        // needs a private URL scheme Apple rejects for.
        if (canAskAgain) Alert.alert('Location unavailable', LOCATION_DENIED);
        else Alert.alert('Location unavailable', LOCATION_BLOCKED, [
          { text: 'Cancel', style: 'cancel' },
          { text: 'Open Settings', onPress: () => { Linking.openSettings(); } },
        ]);
        return null;
      }
      const coords = await fetchPosition();
      // The error behind a missing fix names nothing useful, so don't put it in front of anyone —
      // the fallback is the same whatever it was.
      if (coords == null) Alert.alert('Location unavailable', LOCATION_FAILED);
      return coords;
    } finally {
      setLocating(false);
    }
  }

  // Fill in the current location the first time the builder is opened, so the model subtext has
  // coordinates to attribute before the user touches anything. Only when access has already been
  // granted: an unprompted permission dialog on open asks for something the user hasn't tried to
  // do yet, and the send buttons still raise the prompt at the moment it's actually needed. The
  // attempt is silent and doesn't set `locating` either — nothing waits on it, so a background
  // convenience shouldn't spin the buttons or raise an alert about a fix nobody asked for.
  const autoLocated = useRef(false);
  useEffect(() => {
    if (!active || autoLocated.current || gpsCoords != null) return;
    autoLocated.current = true;
    (async () => {
      const { granted } = await Location.getForegroundPermissionsAsync();
      if (granted) await fetchPosition();
    })();
  }, [active]);

  // Resolve the location (asking for GPS on demand in current-location mode), allocate the message
  // code the reply will echo, and build the request it belongs to. Null when there's no usable
  // location. Every send path goes through here so each outgoing request gets its own code.
  //
  // Callers just stop on null and say nothing: the only branch that can produce one is a failed
  // requestCurrentLocation, which has already raised its own alert and notice. The other route to
  // null — custom mode with unparseable coordinates — greys out the action button, so it never
  // gets this far.
  async function prepareMessage(): Promise<string | null> {
    let coords = resolvedCoords;
    if (locationMode === 'current' && !coordsValid) {
      coords = await requestCurrentLocation();
    }
    if (coords == null || !isFinite(coords.lat) || !isFinite(coords.lon)) return null;
    const startHour = alignedStartEpochHour();
    const code = await allocCode(token, buildContext(coords, mode, model, varsMask, startHour), `${modeName} · ${model.toUpperCase()}`);
    return buildMsg(token, coords, mode, model, variableCodes, maxChars, code, startHour);
  }

  async function handleCopy() {
    const msg = await prepareMessage();
    if (msg == null) return;
    await Clipboard.setStringAsync(msg);
    setMessageCopied(true);
    setTimeout(() => setMessageCopied(false), 2000);
  }

  // Hands the request to the phone's Messages app, addressed and prefilled. Only useful on a phone
  // with cell service — over a satellite messenger the message is copied across instead.
  async function handleSendSms() {
    const msg = await prepareMessage();
    if (msg == null) return;
    try {
      await Linking.openURL(smsUrl(msg));
    } catch {
      Alert.alert('Could not open Messages', `Copy the message and text it to ${FORECAST_NUMBER} instead.`);
    }
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
    const msg = await prepareMessage();
    if (msg == null) return;
    setFetching(true);
    // An abort we raised ourselves is indistinguishable from any other in the catch, so the timer
    // records that it fired. AbortController rather than AbortSignal.timeout, which React Native's
    // fetch polyfill doesn't carry.
    const controller = new AbortController();
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; controller.abort(); }, FETCH_TIMEOUT_MS);
    try {
      const resp = await fetch(FORECAST_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'text/plain' },
        body: msg,
        signal: controller.signal,
      });
      if (!resp.ok) throw new Error(await resp.text());
      onForecastReceived(await resp.text());
    } catch (e) {
      if (timedOut) Alert.alert('No connection', OFFLINE_MESSAGE);
      else Alert.alert('Error', String(e));
    } finally {
      clearTimeout(timer);
      setFetching(false);
    }
  }

  // What the one action button does, per device. The label and icon come from the device table
  // (devices.ts); what stays here is the part that depends on this screen's state — which handler
  // sends the request, and what has to be true before it can. Only the internet route needs a
  // connection, and only it can sit in a fetch, so only it is greyed out by either.
  const ACTIONS: Record<Device, { onPress: () => void; disabled: boolean; busy: boolean }> = {
    internet: { onPress: handleFetch, disabled: fetchDisabled, busy: fetching || locating },
    sms: { onPress: handleSendSms, disabled: sendDisabled, busy: locating },
    inreach: { onPress: handleCopy, disabled: sendDisabled, busy: locating },
  };
  const deviceSpec = DEVICES.find((d) => d.value === device)!;
  const action = ACTIONS[device];
  // Copy is the only action with something to confirm — the other two hand off to another app,
  // which is its own confirmation.
  const copied = device === 'inreach' && messageCopied;

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
        {/* Left to wrap rather than clipped to a line: the deepest chains run five models (the
            ICON-D2 branch over central Europe), and truncating would hide exactly the long-range
            model the last days of the forecast come from. */}
        <Text style={styles.modelHint}>{modelStack ?? MODEL_HINT_NO_LOCATION}</Text>
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

      {/* The way out of the builder. Which device you carry decides how the request travels, so it
          sits with the button it drives rather than up with the forecast's own options. */}
      <Section label="Device" info={() => setDeviceInfo(true)}>
        <SegmentedControl
          values={DEVICES.map((d) => d.label)}
          selectedIndex={DEVICES.findIndex((d) => d.value === device)}
          onChange={(e) => {
            setMessageCopied(false);
            onDeviceChange(DEVICES[e.nativeEvent.selectedSegmentIndex].value);
          }}
        />
      </Section>

      <View style={styles.buttons}>
        <ActionButton
          icon={copied ? 'check' : deviceSpec.icon}
          label={copied ? 'Copied' : deviceSpec.action}
          onPress={action.onPress}
          disabled={action.disabled}
          busy={action.busy}
          variant={copied ? 'success' : 'primary'}
        />
      </View>

      {/* Says why Get Forecast is greyed out, so it's shown only when that's the button on screen.
          Keyed on `offline` alone, not on fetchDisabled — a button greyed for want of a location is
          a different problem with a different fix. */}
      {device === 'internet' && offline && <Text style={styles.offlineNote}>{OFFLINE_MESSAGE}</Text>}

      <TouchableOpacity
        style={styles.helpLink}
        onPress={() => setHelp(true)}
        activeOpacity={0.7}
        accessibilityRole="button"
      >
        <Text style={styles.helpLinkText}>How do I get a forecast?</Text>
      </TouchableOpacity>

      <HelpScreen visible={help} onClose={() => setHelp(false)} />

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

      <InfoModal visible={deviceInfo} title="Device" onClose={() => setDeviceInfo(false)}>
        <Text style={styles.modalBody}>How the request leaves your phone:</Text>
        {DEVICE_INFO.map((d) => (
          <Text key={d.name} style={styles.modalItemIndent}>
            <Text style={styles.modalBold}>{d.name}</Text> — {d.desc}
          </Text>
        ))}
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

// A full-width action button: icon and label, replaced by a spinner while the action resolves.
// The variants differ only in fill, so one tint drives the icon and the label together — and a
// disabled button is filled grey, which needs the light tint whatever its variant.
function ActionButton({ icon, label, onPress, disabled, busy, variant }: {
  icon: React.ComponentProps<typeof MaterialCommunityIcons>['name'];
  label: string;
  onPress: () => void;
  disabled: boolean;
  busy: boolean;
  variant: 'primary' | 'success';
}) {
  const fill = { primary: styles.btnPrimary, success: styles.btnSuccess }[variant];
  const tint = disabled || variant === 'primary' ? '#fff' : '#2a8f5a';
  return (
    <TouchableOpacity
      style={[styles.btn, fill, disabled && styles.btnDisabled]}
      onPress={onPress}
      disabled={disabled}
      accessibilityRole="button"
      accessibilityLabel={label}
    >
      {busy ? (
        <ActivityIndicator color={tint} />
      ) : (
        <>
          <MaterialCommunityIcons name={icon} size={19} color={tint} style={styles.btnIcon} />
          {/* One line always: the row is a fixed 50pt, so a label that wrapped would be clipped
              rather than grow the button. */}
          <Text style={[styles.btnText, { color: tint }]} numberOfLines={1}>{label}</Text>
        </>
      )}
    </TouchableOpacity>
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
  modelHint: { fontSize: 12, color: '#8e8e93', lineHeight: 17, marginTop: 8 },

  // Full-width action, its icon and label on a single centered row.
  buttons: { marginTop: 4 },
  btn: { flexDirection: 'row', height: 50, borderRadius: 14, alignItems: 'center', justifyContent: 'center' },
  btnPrimary: { backgroundColor: '#2a6bb5' },
  btnSuccess: { backgroundColor: '#e8f5ec', borderWidth: 1, borderColor: '#2a8f5a' },
  btnDisabled: { backgroundColor: '#aeaeb2', borderColor: '#aeaeb2' },
  btnIcon: { marginRight: 8 },
  btnText: { fontSize: 16, fontWeight: '600' },

  offlineNote: { fontSize: 13, color: '#6e6e73', lineHeight: 19, textAlign: 'center', marginTop: 10 },

  helpLink: { alignSelf: 'center', marginTop: 18, paddingVertical: 6, paddingHorizontal: 12 },
  helpLinkText: { color: '#2a6bb5', fontSize: 14, fontWeight: '600' },
});
