import { useEffect, useRef, useState } from 'react';
import {
  StyleSheet, Text, View, ScrollView, TouchableOpacity, SafeAreaView,
  ActivityIndicator, Alert, TextInput, Modal, Linking, Platform, Switch,
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
import { type AqiScale } from './settings';
import { deviceOffsetHours, offsetHoursAt } from './timezone';
import { allocCode } from './cache';
import LocationMap from './LocationMap';
import HelpScreen from './HelpScreen';
import { MODELS } from './models';
import { DEVICES, deviceCode, supportsMultiMessage, type Device } from './devices';

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

// How many characters one message holds is a property of the route, not a constant, and the
// server derives it from the request's `d:` and `n:` — the client never states it.
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
// have no freezing-level product (Europe's pressure winds are filled from IFS 0.25°). The
// air-quality variables never appear here: they come from CAMS, not from the weather center, so
// the `m:` choice doesn't reach them.
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
  { name: '🌐 Auto', desc: 'Chooses the highest resolution model for your location from over 30 regional weather models.' },
  { name: '🇺🇸 US', desc: 'Blend of HRRR (3km, 48hr, continental US) and GFS (13km, 16 day, global).' },
  { name: '🇨🇦 CA', desc: 'Blend of HRDPS (2.5km, 48hr, Canada) and GEM (15km, 10 day, global).' },
  { name: '🇪🇺 EU', desc: 'IFS HRES (9km, 15 day, global).' },
];
const OPEN_METEO_DOCS = 'https://open-meteo.com/en/docs#data_sources';

// Stands in for the model stack until there's a location to attribute. Every selector option but
// EU resolves differently from place to place, so without coordinates there's nothing to name.
const MODEL_HINT_NO_LOCATION = 'Set a location to see which models will be used.';

// Device-selector help copy. Each line says how the forecast travels on that device, which is what
// picks between them: the route a reader has left is usually the only one they have.
const DEVICE_INFO = [
  { name: 'Internet', desc: 'Fetches the forecast over a WiFi or cellular data connection.' },
  { name: 'SMS', desc: 'Sends the forecast over a text message for weak cell reception without data.' },
  { name: 'inReach', desc: 'Copies the message so that it can be pasted into the Garmin Earthmate app and sent over inReach.' },
  { name: 'iPhone', desc: 'Sends the forecast over a text message, and asks for the reply in a form that fits a single message over satellite. Choose this on an iPhone that can text without cell service.' },
];

// Why the iPhone route offers a message-count choice at all: one satellite bubble is a real
// forecast but a thin one, and the reader deciding between one message and two needs to know
// that before they are out of range and stuck with the answer.
const IPHONE_MESSAGE_NOTE =
  'iPhone satellite messages hold fewer characters than text messages. Use multiple messages '
  + 'for more detail.';

// Id of the subgroup the air-quality toggles fold under — stable across a change of scale, which
// its heading is not, so folding it open survives switching from one index to the other.
const AIR_SUBGROUP = 'air';

interface VarGroup {
  value: string;
  code: string;
  label: string;
  // Help copy for this group, shown in the Extra Variables modal. Kept beside the label so the two
  // can't drift: a row and its explanation are written once, in one place.
  desc: string;
  vars: readonly string[];
  // Set to fold this group into a collapsible sub-list under that subgroup's heading. Purely
  // display: the request carries each member's own code, and a subgroup is never toggled as a unit.
  subgroup?: string;
  // Set on the variables that belong to one air-quality index. Only the scale the reader has
  // chosen in Settings is offered; the other index's groups are left out of the list entirely, so
  // a request can't carry a scale the reader doesn't read in.
  scale?: AqiScale;
}

// User-selectable variable groups. Each toggle enables/disables all of its underlying
// protocol variables together (e.g. "Clouds" covers high/mid/low cloud cover, not total).
// Order is display order only — the server ORs the `v:` codes into a mask, so the emitted
// order carries no meaning. Precip chance sits last of the weather groups: it costs the most for
// the least detail.
// The air-quality entries are single variables rather than bundles: smoke and ozone are different
// hazards on different schedules (a smoke plume arrives and stays for days; ozone peaks every
// afternoon), and someone watching for fire smoke shouldn't have to pay for the rest. Their labels
// name the pollutant and never the region: only one index is on offer at a time, so a row here is
// unambiguous, and the scale it's read on is settled in Settings.
const VAR_GROUPS: VarGroup[] = [
  {
    value: 'clouds', code: 'c', label: 'Detailed Clouds', vars: CONFIGURABLE_VAR_GROUPS.c,
    desc: 'Low, medium, and high cloud cover.',
  },
  {
    value: 'highwind', code: 'w', label: 'High Altitude Winds', vars: CONFIGURABLE_VAR_GROUPS.w,
    desc: 'Winds at 500, 600, and 700 hPa pressure levels.',
  },
  {
    value: 'freeze', code: 'f', label: 'Freezing Level', vars: CONFIGURABLE_VAR_GROUPS.f,
    desc: 'Altitude at which atmospheric temperature drops to 0°C.',
  },
  {
    value: 'precip', code: 'p', label: 'Precip Chance', vars: CONFIGURABLE_VAR_GROUPS.p,
    desc: 'Chance of measurable precipitation during the period.',
  },
  {
    value: 'aqi', code: 'a', label: 'AQI (Dominant pollutant)', vars: CONFIGURABLE_VAR_GROUPS.a,
    subgroup: AIR_SUBGROUP, scale: 'us',
    desc: 'Index of the worst pollutant out of PM2.5, PM10, ozone, nitrogen dioxide, sulphur '
      + 'dioxide, and carbon monoxide.',
  },
  {
    value: 'smoke', code: 's', label: 'PM2.5 (Smoke)', vars: CONFIGURABLE_VAR_GROUPS.s,
    subgroup: AIR_SUBGROUP, scale: 'us',
    desc: 'Fine-particulate pollution from wildfire smoke and haze.',
  },
  {
    value: 'pm10', code: 'm', label: 'PM10 (Dust)', vars: CONFIGURABLE_VAR_GROUPS.m,
    subgroup: AIR_SUBGROUP, scale: 'us',
    desc: 'Coarse particulates like blowing dust, pollen, and road grit.',
  },
  {
    value: 'ozone', code: 'o', label: 'Ozone (Smog)', vars: CONFIGURABLE_VAR_GROUPS.o,
    subgroup: AIR_SUBGROUP, scale: 'us',
    desc: 'Summer smog, which peaks in the afternoon.',
  },
  {
    value: 'no2', code: 'd', label: 'NO₂ (Traffic)', vars: CONFIGURABLE_VAR_GROUPS.d,
    subgroup: AIR_SUBGROUP, scale: 'us',
    desc: 'Combustion exhaust, worst near busy roads at rush hour.',
  },
  {
    value: 'so2', code: 'u', label: 'SO₂ (Industrial/Volcanic)', vars: CONFIGURABLE_VAR_GROUPS.u,
    subgroup: AIR_SUBGROUP, scale: 'us',
    desc: 'Smelters, coal plants, ship fuel, and volcanic vents.',
  },
  {
    value: 'aqi-eu', code: 'e', label: 'AQI (Dominant pollutant)', vars: CONFIGURABLE_VAR_GROUPS.e,
    subgroup: AIR_SUBGROUP, scale: 'eu',
    desc: 'Index of the worst pollutant out of PM2.5, PM10, ozone, nitrogen dioxide, and sulphur '
      + 'dioxide.',
  },
  {
    value: 'smoke-eu', code: '2', label: 'PM2.5 (Smoke)', vars: CONFIGURABLE_VAR_GROUPS['2'],
    subgroup: AIR_SUBGROUP, scale: 'eu',
    desc: 'Fine-particulate pollution from wildfire smoke and haze.',
  },
  {
    value: 'pm10-eu', code: '1', label: 'PM10 (Dust)', vars: CONFIGURABLE_VAR_GROUPS['1'],
    subgroup: AIR_SUBGROUP, scale: 'eu',
    desc: 'Coarse particulates like blowing dust, pollen, and road grit.',
  },
  {
    value: 'ozone-eu', code: '3', label: 'Ozone (Smog)', vars: CONFIGURABLE_VAR_GROUPS['3'],
    subgroup: AIR_SUBGROUP, scale: 'eu',
    desc: 'Summer smog, which peaks in the afternoon. This scale\'s most common worst pollutant.',
  },
  {
    value: 'no2-eu', code: 'n', label: 'NO₂ (Traffic)', vars: CONFIGURABLE_VAR_GROUPS.n,
    subgroup: AIR_SUBGROUP, scale: 'eu',
    desc: 'Combustion exhaust, worst near busy roads at rush hour.',
  },
  {
    value: 'so2-eu', code: 'q', label: 'SO₂ (Industrial/Volcanic)', vars: CONFIGURABLE_VAR_GROUPS.q,
    subgroup: AIR_SUBGROUP, scale: 'eu',
    desc: 'Smelters, coal plants, ship fuel, and volcanic vents.',
  },
];

// The groups on offer under a given scale preference: everything that isn't tied to an index, plus
// the chosen index's own. The single source for both what the list draws and what the request can
// carry, so a hidden group can't reach the `v:` token.
function visibleVarGroups(scale: AqiScale): VarGroup[] {
  return VAR_GROUPS.filter((g) => g.scale == null || g.scale === scale);
}

// The same groups as a display tree: runs of groups sharing a subgroup become one collapsible
// node, sitting where the run's first member did. Derived rather than written out a second time,
// so a new group can only ever be added in one place.
type VarNode =
  | { kind: 'group'; group: VarGroup }
  | { kind: 'subgroup'; id: string; label: string; desc: string; members: VarGroup[] };

// One drawn row of the open list, flattened out of the tree so the hairline separator can be
// dropped from the last row whichever kind it turns out to be.
type VarRow =
  | { key: string; kind: 'toggle'; group: VarGroup; indent: boolean }
  | { key: string; kind: 'subgroup'; id: string; label: string; members: VarGroup[] };

// What the two scales and their shared source need said once, above the rows, rather than
// repeated in each one's own line.
const AIR_DESC =
  'There are two different scales for air quality: US (0-500), and European (0-100). The scale '
  + 'can be changed in Settings. Sourced from the CAMS model, which has a time horizon of 4 days.';

function buildVarTree(scale: AqiScale): VarNode[] {
  // Air quality is the only subgroup. Its heading names the hazard and nothing else: which index
  // is in force is a Settings preference, and repeating it on every visit to the builder would
  // put a choice in front of the reader that isn't theirs to make here.
  const label = 'Air Quality';
  const tree: VarNode[] = [];
  for (const group of visibleVarGroups(scale)) {
    const open = tree[tree.length - 1];
    if (group.subgroup == null) tree.push({ kind: 'group', group });
    else if (open?.kind === 'subgroup' && open.id === group.subgroup) open.members.push(group);
    else tree.push({ kind: 'subgroup', id: group.subgroup, label, desc: AIR_DESC, members: [group] });
  }
  return tree;
}

// No extra variables selected by default.
const DEFAULT_GROUPS = new Set<string>();

// The request leads with the protocol version and picks a priority mode (`p:`), not a duration
// or resolution — the server fills the max response length (`c:`, in chars) along the mode's
// path. `z:` is the local-midnight UTC offset the period grid aligns to. `c:` is always
// included, even at the default length. `u:` carries the account token so the server can
// attribute the request to the user. `k:` is the message code the slim response echoes so the
// client can recover the request context (see cache.ts).
function buildMsg(token: string, coords: { lat: number; lon: number } | null, mode: number, model: string, variableCodes: string[], device: Device, messages: number, code: number, startEpochHour: number): string {
  const parts: string[] = [`v${V2_VERSION}`];
  if (coords) parts.push(`${coords.lat.toFixed(4)},${coords.lon.toFixed(4)}`);
  parts.push(`p:${PRIORITIES.find((m) => m.value === mode)!.token}`);
  parts.push(`z:${requestOffsetHours(coords, startEpochHour)}`);
  parts.push(`m:${model}`);
  if (variableCodes.length) parts.push(`v:${variableCodes.join('')}`);
  // `d:` is what tells the server which pipe the reply has to fit down — it picks the response
  // alphabet as well as its length. The length is derived from `d:` and `n:` at both ends, off
  // the one table in the protocol, so the request no longer spends characters restating it.
  parts.push(`d:${deviceCode(device)}`);
  // Omitted at one message, which is every route but a split iPhone reply — so the requests that
  // worked before this existed still go out byte for byte unchanged.
  if (messages > 1) parts.push(`n:${messages}`);
  parts.push(`u:${token}`);
  parts.push(`k:${code}`);
  parts.push(`t:${startEpochHour}`);
  return parts.join(' ');
}

// The request context the client stores under the message code, mirroring how the server will
// parse this request (so the recovered fields exactly match what the response was encoded with).
function buildContext(coords: { lat: number; lon: number }, mode: number, model: string, varsMask: number, startEpochHour: number, device: Device): RequestContext {
  return {
    mode,
    utcOffsetHours: requestOffsetHours(coords, startEpochHour),
    model: MODEL_BIT[model.toUpperCase()] ?? 0, // single model index
    vars_mask: varsMask,
    lat: coords.lat,
    lon: coords.lon,
    start: startEpochHour * 3600000, // UTC epoch ms
    // The route decides the reply's alphabet, so the decoder needs it as much as the server does.
    // Stored with the request rather than read from the selector at decode time: the selector can
    // move between sending and reading, and the reply was written for the route it left by.
    device: deviceCode(device),
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

// A forecast fetch on the wire. `cancelled` separates an abort we raised on purpose from the
// timeout's and from any other failure, which the catch can't tell apart on its own.
interface InFlight {
  controller: AbortController;
  cancelled: boolean;
}

interface Props {
  token: string;
  onForecastReceived: (encoded: string) => void;
  active: boolean;
  // Owned by App so it can be read from storage behind the splash — see App.tsx.
  device: Device;
  onDeviceChange: (device: Device) => void;
  twoMessages: boolean;
  onTwoMessagesChange: (on: boolean) => void;
  // Which air-quality index to offer. A Settings preference, changed there rather than here.
  aqiScale: AqiScale;
}

export default function BuilderTab({ token, onForecastReceived, active, device, onDeviceChange, twoMessages, onTwoMessagesChange, aqiScale }: Props) {
  const [locationMode, setLocationMode] = useState<LocationMode>('current');
  const [gpsCoords, setGpsCoords] = useState<{ lat: number; lon: number } | null>(null);
  const [customCoords, setCustomCoords] = useState('');
  const [mode, setMode] = useState(MODE_AUTO);
  const [model, setModel] = useState('best');
  const [groups, setGroups] = useState<Set<string>>(new Set(DEFAULT_GROUPS));
  // Subgroups start closed. Nothing is selected by default, so a closed one hides only rows whose
  // state its own count already reports.
  const [openSubgroups, setOpenSubgroups] = useState<Set<string>>(new Set());
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

  // How many messages the reply may use, and what that buys. Only the iPhone route can spend
  // more than one; everywhere else the choice isn't offered and this stays at the default.
  const messages = supportsMultiMessage(device) && twoMessages ? 2 : DEFAULT_MESSAGES;

  // The forecast fetch currently on the wire, so something other than its own timeout can call it
  // off. Only the internet route has one — the other devices hand the request to another app and
  // are done with it.
  const inFlight = useRef<InFlight | null>(null);

  // Drop the in-flight fetch, if there is one. The request itself is still valid — what's changed
  // is that its reply would come back in the wrong shape for the route now selected, so it's
  // abandoned rather than left to land. Marking it cancelled first keeps its own catch quiet: an
  // abort we asked for isn't an error to report.
  function cancelFetch() {
    const req = inFlight.current;
    if (req == null) return;
    req.cancelled = true;
    req.controller.abort();
    inFlight.current = null;
    setFetching(false);
  }

  const unavail = MODEL_UNAVAIL_VARS[model] ?? [];
  // Expand the always-on variables plus any enabled groups for the stored request context. Only
  // configurable variables go in the message because the server adds the always-on set. Read off
  // the scale-filtered list, so switching the Settings preference drops the other index's
  // variables from the request without having to clear what's ticked: come back to that scale and
  // the selection is as it was left.
  const activeGroups = visibleVarGroups(aqiScale)
    .filter((g) => groups.has(g.value))
    .map((g) => ({ ...g, vars: g.vars.filter((v) => !unavail.includes(v)) }))
    .filter((g) => g.vars.length > 0);
  // What a closed subgroup counts. A group the model can't supply adds nothing to the request, so
  // it isn't reported as if it did — activeGroups has already dropped those.
  const activeValues = new Set(activeGroups.map((g) => g.value));
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
    const code = await allocCode(token, buildContext(coords, mode, model, varsMask, startHour, device), `${modeName} · ${model.toUpperCase()}`);
    return buildMsg(token, coords, mode, model, variableCodes, device, messages, code, startHour);
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

  // Open or close a subgroup's rows. Selection is untouched: folding the air-quality rows away is
  // a way to stop looking at them, not a way to turn them off, and a request built with the list
  // closed still carries whatever is ticked inside it.
  function toggleSubgroup(id: string) {
    setOpenSubgroups((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  async function handleFetch() {
    const msg = await prepareMessage();
    if (msg == null) return;
    setFetching(true);
    // An abort we raised ourselves is indistinguishable from any other in the catch, so both the
    // timer and cancelFetch record that they fired. AbortController rather than
    // AbortSignal.timeout, which React Native's fetch polyfill doesn't carry.
    const req: InFlight = { controller: new AbortController(), cancelled: false };
    inFlight.current = req;
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; req.controller.abort(); }, FETCH_TIMEOUT_MS);
    try {
      const resp = await fetch(FORECAST_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'text/plain' },
        body: msg,
        signal: req.controller.signal,
      });
      if (!resp.ok) throw new Error(await resp.text());
      const encoded = await resp.text();
      // A reply that landed in the gap between the abort and this line answers a request the user
      // has already walked away from — hand it on and the decoder opens on a route they left.
      if (req.cancelled) return;
      onForecastReceived(encoded);
    } catch (e) {
      if (req.cancelled) return;
      if (timedOut) Alert.alert('No connection', OFFLINE_MESSAGE);
      else Alert.alert('Error', String(e));
    } finally {
      clearTimeout(timer);
      // A cancel has already cleared the slot and stopped the spinner, and may have put a newer
      // request in this one's place — either way this reply is no longer the one on screen.
      if (inFlight.current === req) {
        inFlight.current = null;
        setFetching(false);
      }
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
    // iPhone hands off to Messages exactly as SMS does — same text, same recipient. What differs
    // is the reply, which comes back in the wide alphabet so it lands in a single bubble.
    iphone: { onPress: handleSendSms, disabled: sendDisabled, busy: locating },
  };
  const deviceSpec = DEVICES.find((d) => d.value === device)!;
  const action = ACTIONS[device];
  // Copy is the only action with something to confirm — the other two hand off to another app,
  // which is its own confirmation.
  const copied = device === 'inreach' && messageCopied;

  // The list to draw, under the scale the reader has chosen. Cheap enough to rebuild each render,
  // like the model chain above it.
  const varTree = buildVarTree(aqiScale);
  // The variable rows to draw: each subgroup's heading always, its members only while it's open.
  const varRows: VarRow[] = [];
  for (const node of varTree) {
    if (node.kind === 'group') {
      varRows.push({ key: node.group.value, kind: 'toggle', group: node.group, indent: false });
      continue;
    }
    varRows.push({ key: node.id, kind: 'subgroup', id: node.id, label: node.label, members: node.members });
    if (openSubgroups.has(node.id)) {
      for (const group of node.members) {
        varRows.push({ key: group.value, kind: 'toggle', group, indent: true });
      }
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
        {/* Left to wrap rather than clipped to a line: the deepest chains run five models (the
            ICON-D2 branch over central Europe), and truncating would hide exactly the long-range
            model the last days of the forecast come from. */}
        <Text style={styles.modelHint}>{modelStack ?? MODEL_HINT_NO_LOCATION}</Text>
      </Section>

      <Section label="Extra Variables" info={() => setVarsInfo(true)}>
        <View style={styles.varList}>
          {varRows.map((row, idx) => {
            const border = idx < varRows.length - 1 && styles.varRowBorder;
            if (row.kind === 'subgroup') {
              // Nothing under the heading is selectable when the model supplies none of it, which
              // no current model does to air quality — CAMS is a separate forecast from the
              // weather center. Handled anyway so the rule lives with the rows, not with the data.
              const disabled = row.members.every((m) => m.vars.every((v) => unavail.includes(v)));
              const open = openSubgroups.has(row.id);
              const selected = row.members.filter((m) => activeValues.has(m.value)).length;
              return (
                <TouchableOpacity
                  key={row.key}
                  style={[styles.varRow, border]}
                  onPress={() => !disabled && toggleSubgroup(row.id)}
                  activeOpacity={disabled ? 1 : 0.6}
                  accessibilityRole="button"
                  accessibilityState={{ expanded: open, disabled }}
                  accessibilityLabel={`${row.label}, ${selected} of ${row.members.length} selected`}
                >
                  <Text style={[styles.varLabel, disabled && styles.varLabelDim]}>{row.label}</Text>
                  <View style={styles.varRowTrailing}>
                    {/* Only when something is on: a "0" against every other row's blank check
                        column would read as a value rather than as an empty count. */}
                    {selected > 0 && <Text style={styles.varCount}>{selected}</Text>}
                    <MaterialCommunityIcons
                      name={open ? 'chevron-up' : 'chevron-down'}
                      size={20}
                      color="#8e8e93"
                    />
                  </View>
                </TouchableOpacity>
              );
            }
            // A group is unavailable when the model can't supply any of its variables.
            const disabled = row.group.vars.every((v) => unavail.includes(v));
            const checked = groups.has(row.group.value) && !disabled;
            return (
              <TouchableOpacity
                key={row.key}
                style={[styles.varRow, row.indent && styles.varRowIndent, border]}
                onPress={() => !disabled && toggleGroup(row.group.value)}
                activeOpacity={disabled ? 1 : 0.6}
                accessibilityRole="checkbox"
                accessibilityState={{ checked, disabled }}
              >
                <Text style={[styles.varLabel, disabled && styles.varLabelDim]}>{row.group.label}</Text>
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
            // The device is what the reply's length and alphabet are cut to, so a fetch started
            // under the old one can only come back wrong. Switching is also how someone gets out
            // of a stalled internet request — leaving it running would spin the button on a route
            // that no longer fetches anything.
            cancelFetch();
            onDeviceChange(DEVICES[e.nativeEvent.selectedSegmentIndex].value);
          }}
        />
        {supportsMultiMessage(device) && (
          <>
            <Text style={styles.deviceNote}>{IPHONE_MESSAGE_NOTE}</Text>
            {/* A switch rather than an On/Off segment: this is one setting being turned on, not a
                choice between two things, and it is read far more often than it is changed. */}
            <View style={styles.switchRow}>
              <Text style={styles.switchLabel}>Multi-message forecast</Text>
              <Switch
                value={twoMessages}
                onValueChange={onTwoMessagesChange}
                accessibilityLabel="Multi-message forecast"
              />
            </View>
          </>
        )}
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
            <Text style={styles.modalBold}>{m.name}</Text>: {m.desc}
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
        <Text style={styles.modalBody}>
          Going Blue can deliver forecasts with several different devices. Each device has a
          different message length and character set.
        </Text>
        {DEVICE_INFO.map((d) => (
          <Text key={d.name} style={styles.modalItemIndent}>
            <Text style={styles.modalBold}>{d.name}</Text>: {d.desc}
          </Text>
        ))}
      </InfoModal>

      <InfoModal visible={varsInfo} title="Extra Variables" onClose={() => setVarsInfo(false)}>
        <Text style={styles.modalBody}>
          By default, forecasts include temperature, rain, snow, wind, and basic cloud cover. The
          following variables are optional:
        </Text>
        {/* Same tree the list draws from, so the modal describes exactly the rows on screen —
            including which air-quality index the scale preference has put there. */}
        {varTree.map((node) => (node.kind === 'group' ? (
          <Text key={node.group.value} style={styles.modalItemIndent}>
            <Text style={styles.modalBold}>{node.group.label}</Text>: {node.group.desc}
          </Text>
        ) : (
          <View key={node.id}>
            <Text style={styles.modalSubhead}>{node.label}</Text>
            <Text style={styles.modalSubdesc}>{node.desc}</Text>
            {node.members.map((m) => (
              <Text key={m.value} style={[styles.modalItemIndent, styles.modalItemNested]}>
                <Text style={styles.modalBold}>{m.label}</Text>: {m.desc}
              </Text>
            ))}
          </View>
        )))}
        <Text style={[styles.modalBody, styles.modalNote]}>Each added variable takes away from the detail and range of the forecast.</Text>
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

// The ⓘ screens. A centered card was the wrong container once the variable list grew past a
// screen: bounding it left the card filling the display anyway, minus a margin, with its body
// cut mid-sentence at a scroll edge that didn't look like one. Full screen rather than a page
// sheet because UIKit rounds a sheet's corners to the display's own curve, which reads as a lot
// of radius for a page of text — and RN gives no way to ask for less. The trade is the swipe-down
// dismissal a sheet comes with, so Done is the way out and sits where a sheet's would.
function InfoModal({ visible, title, onClose, children }: {
  visible: boolean; title: string; onClose: () => void; children: React.ReactNode;
}) {
  return (
    <Modal visible={visible} animationType="slide" presentationStyle="fullScreen" onRequestClose={onClose}>
      <SafeAreaView style={styles.sheet}>
        <View style={styles.sheetHeader}>
          <Text style={styles.sheetTitle}>{title}</Text>
          <TouchableOpacity
            onPress={onClose}
            accessibilityRole="button"
            hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}
          >
            <Text style={styles.sheetDone}>Done</Text>
          </TouchableOpacity>
        </View>
        <ScrollView style={styles.sheetScroll} contentContainerStyle={styles.sheetContent}>
          {children}
        </ScrollView>
      </SafeAreaView>
    </Modal>
  );
}

const styles = StyleSheet.create({
  scroll: { flex: 1, backgroundColor: '#f2f2f7' },
  // Bottom pad covers the home-indicator inset the scroll view now extends under.
  content: { padding: 16, paddingBottom: 72 },

  // Sheet frame, matching HelpScreen's. The safe area carries the status bar inset now that this
  // runs the full height, so the header only needs the same 12pt the tab bar's rows use.
  sheet: { flex: 1, backgroundColor: '#fff' },
  sheetHeader: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    paddingHorizontal: 16, paddingTop: 12, paddingBottom: 12,
  },
  sheetTitle: { flex: 1, fontSize: 20, fontWeight: '700', color: '#1c1c1e' },
  sheetDone: { fontSize: 16, fontWeight: '600', color: '#2a6bb5', paddingLeft: 12 },
  sheetScroll: { flex: 1 },
  sheetContent: { paddingHorizontal: 16, paddingBottom: 40 },

  // Sheet body copy, shared by all four ⓘ sheets.
  modalBody: { fontSize: 15, color: '#3a3a3c', lineHeight: 22 },
  modalItem: { fontSize: 15, color: '#3a3a3c', lineHeight: 22, marginBottom: 10 },
  modalItemIndent: { fontSize: 15, color: '#3a3a3c', lineHeight: 22, marginTop: 10, paddingLeft: 12 },
  // Entries under a subgroup heading, set in one step further than the top-level ones.
  modalItemNested: { paddingLeft: 24 },
  modalSubhead: { fontSize: 15, fontWeight: '700', color: '#1c1c1e', marginTop: 14, paddingLeft: 12 },
  // A subgroup's own paragraph, sitting between its heading and its entries at the heading's indent.
  modalSubdesc: { fontSize: 15, color: '#3a3a3c', lineHeight: 22, marginTop: 4, paddingLeft: 12 },
  modalBold: { fontWeight: '700', color: '#1c1c1e' },
  modalNote: { marginTop: 14 },
  modalLink: { color: '#2a6bb5', textDecorationLine: 'underline' },

  section: { marginBottom: 20 },
  sectionHeader: { flexDirection: 'row', alignItems: 'center', marginBottom: 8 },
  sectionLabel: { fontSize: 12, fontWeight: '600', color: '#6e6e73', textTransform: 'uppercase', letterSpacing: 0.5 },
  sectionInfo: { fontSize: 14, color: '#2a6bb5', marginLeft: 6 },

  varList: { backgroundColor: '#fff', borderRadius: 12, overflow: 'hidden' },
  varRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: 16, paddingVertical: 10 },
  // Members of an open subgroup, set in from their heading and off the white of the top-level rows.
  varRowIndent: { paddingLeft: 32, backgroundColor: '#fafafc' },
  varRowBorder: { borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: '#d1d1d6' },
  varLabel: { fontSize: 15, color: '#1c1c1e' },
  varLabelDim: { color: '#aeaeb2' },
  varCheck: { fontSize: 17, fontWeight: '600', color: '#2a6bb5' },
  varCheckHidden: { opacity: 0 },
  // The subgroup heading's right-hand side: how many of its rows are on, then the disclosure.
  varRowTrailing: { flexDirection: 'row', alignItems: 'center' },
  varCount: { fontSize: 13, color: '#8e8e93', marginRight: 6 },

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
  deviceNote: { fontSize: 13, color: '#6e6e73', lineHeight: 19, marginTop: 12 },
  // A settings row: label left, switch right, the switch's own height setting the row's.
  switchRow: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    gap: 12, marginTop: 10,
  },
  switchLabel: { flexShrink: 1, fontSize: 15, color: '#1c1c1e' },

  helpLink: { alignSelf: 'center', marginTop: 18, paddingVertical: 6, paddingHorizontal: 12 },
  helpLinkText: { color: '#2a6bb5', fontSize: 14, fontWeight: '600' },
});
