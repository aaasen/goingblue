import { memo, useCallback, useEffect, useInsertionEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator, Alert, Animated, AppState, Image, Linking, Modal, Platform, Pressable,
  ScrollView, StyleSheet, Switch, Text, TextInput, TouchableOpacity, View, useWindowDimensions,
} from 'react-native';
import { SafeAreaProvider, SafeAreaView } from 'react-native-safe-area-context';
import * as Clipboard from 'expo-clipboard';
import * as Location from 'expo-location';
import * as Network from 'expo-network';
import { pageInsets } from './insets';
import MaterialCommunityIcons from '@expo/vector-icons/MaterialCommunityIcons';
import SegmentedControl from '@react-native-segmented-control/segmented-control';
import {
  VAR, type Variable, WIRE_VERSION,
  ALWAYS_VARS, VAR_CODES, MODEL_BIT,
  WIND_LEVELS_HPA, WIND_LEVEL_VARS, varGroupCodesFor, windLevelsToken,
  MODE_DETAIL, MODE_AUTO, MODE_RANGE, MODE_NAMES, DEFAULT_MODE,
  predictCenter, estimatedLastFullRunMs, fillSlotsFor, multiMessageOffered, startDatetime,
  MODELS as MODEL_SPECS,
  type RequestContext, type Center, type ForecastMessage, type ModelSpec,
} from '@weather/protocol';
import { API_BASE } from './account';
import { type AqiScale, type TimeFormat, type UnitPrefs, loadPinnedCoords, savePinnedCoords } from './settings';
import { ladderLabel } from './cloudBand';
import { deviceOffsetHours, offsetHoursAt } from './timezone';
import {
  allocCode, attachResponse, chunksCollected, decodeAny, loadStore, mergeReply, normalizeReply,
  prunePastForecasts, replyParts, type Slot,
} from './cache';
import LocationMap from './LocationMap';
import Meteogram, { PINNED_STACK_H, type PageScroll } from './Meteogram';
import HelpScreen from './HelpScreen';
import { MODELS, modelLabelFromMask } from './models';
import { DEVICES, deviceCode, platformCode, type Device } from './devices';
import { parseLatLon } from './coords';
import { SHOW_COORDINATES } from './features';
import { palette, SEGMENT_PROPS, SWITCH_PROPS } from './palette';

// The whole flow on one screen, in the order the steps happen: build a request at the top, send
// it with the device's button, paste the reply in under that, and read the decoded forecast
// below, with saved forecasts at the bottom. What used to be the Builder and Decoder tabs.

// ── Building the request ───────────────────────────────────────────────────

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
// Shown under the greyed action button when the location is pinned and the field has no usable
// coordinates, because it is empty or unreadable. Whichever it is, the fix is the same, so one
// message covers both.
const NO_LOCATION_MESSAGE = 'Choose a location to request a forecast';

// A fix taken when the app was opened can be hours old by the time a request goes out, and a
// forecast for where the phone used to be reads exactly like the right one. Sends re-fix beyond
// this age; under it, a burst of copies and sends stays instant. The map holds itself to the same
// age: a fix this old is dropped rather than drawn as the phone's position.
const GPS_FIX_MAX_AGE_MS = 60_000;
// How the foreground position watch is tuned: coarse (cell and wifi) accuracy keeps it cheap, and
// a fix is only delivered once the phone has moved this far, so a phone on a table costs nothing.
const GPS_WATCH_OPTIONS: Location.LocationOptions = {
  accuracy: Location.Accuracy.Balanced, distanceInterval: 25, timeInterval: 30_000,
};

// Variables a forecast center can't supply. Only the freezing level varies now — GEM and ECMWF
// have no freezing-level product (Europe's pressure winds are filled from IFS 0.25°). The
// air-quality variables never appear here: they come from CAMS, not from the weather center, so
// the `m:` choice doesn't reach them.
const MODEL_UNAVAIL_VARS: Record<string, Variable[]> = {
  best: [],
  us: [],
  ca: [VAR.freeze],
  eu: [VAR.freeze],
  de: [],
};
// One shared empty list, so a model with nothing unavailable reads as the same value every render.
const NO_UNAVAIL_VARS: readonly Variable[] = [];

// The map is always on screen, so it shares the builder with everything below it; fullscreen is
// there for precision.
const BUILDER_MAP_HEIGHT = 220;

// How the coordinates field writes a point, and what a map pick puts in it.
function formatLatLon(c: { lat: number; lon: number }): string {
  return `${c.lat.toFixed(5)}, ${c.lon.toFixed(5)}`;
}

// Priority modes. The server fills the reply by walking the mode's refinement path — Detail
// spends the budget on hourly detail first, Range on covering the whole horizon first, Auto
// balances the two. A mode is a priority, not a promise: the weather's entropy decides how far
// the fill gets, so the copy carries no hour/day numbers.
// `hint` is the line under the selector: what the chosen priority trades away, since the labels
// alone don't say which way each one leans.
const PRIORITIES = [
  { value: MODE_DETAIL, token: 'd', label: 'Detail', hint: 'Hourly resolution with shorter range' },
  { value: MODE_AUTO, token: 'a', label: 'Auto', hint: 'Balance of resolution and range' },
  { value: MODE_RANGE, token: 'r', label: 'Range', hint: 'Long-range forecasts with lower resolution' },
];

// Model-selector help copy: the option's label, the center behind it, and the models it
// serves, highest resolution first, which is the order they serve in, so the list reads as the
// blend outward that Auto's line describes. Names and horizons come off the specs, keeping this
// text saying what the meteogram's band labels say; only the region is written here.
interface ModelInfoEntry { spec: ModelSpec; region: string }
const M = MODEL_SPECS;
const MODEL_INFO: Array<{ name: string; desc: string; models: ModelInfoEntry[] }> = [
  {
    name: 'Auto',
    desc: 'Chooses the highest resolution model for your location from over 30 regional weather '
      + 'models. Seamlessly blends to lower-resolution global models at longer time horizons.',
    models: [],
  },
  {
    name: 'NOAA',
    desc: 'US National Oceanic and Atmospheric Administration',
    models: [
      { spec: M.gfs_hrrr, region: 'continental US' },
      { spec: M.gfs_global, region: 'global' },
    ],
  },
  {
    name: 'GEM',
    desc: 'Environment and Climate Change Canada',
    models: [
      { spec: M.gem_hrdps_continental, region: 'Canada and the northern US' },
      { spec: M.gem_regional, region: 'North America' },
      { spec: M.gem_global, region: 'global' },
    ],
  },
  {
    name: 'ECMWF',
    desc: 'European Centre for Medium-Range Weather Forecasts',
    models: [{ spec: M.ecmwf_ifs, region: 'global' }],
  },
  {
    name: 'ICON',
    desc: 'Deutscher Wetterdienst (Germany)',
    models: [
      { spec: M.icon_d2, region: 'central Europe' },
      { spec: M.icon_eu, region: 'Europe' },
      { spec: M.icon_global, region: 'global' },
    ],
  },
];

// A spec's horizon in the units the reader thinks in: hours while a run is short enough to plan
// an outing around, days once it isn't. Halves survive the switch (ICON Global's 7.5 days).
function horizonText(hours: number): string {
  if (hours < 96) return `${hours} hours`;
  const days = hours / 24;
  return `${Number.isInteger(days) ? days : days.toFixed(1)} days`;
}
const OPEN_METEO_DOCS = 'https://open-meteo.com/en/docs#data_sources';

// Compare-pill names by MODEL_BIT index, matching the selector.
const COMPARE_MODEL_LABELS = MODELS.map((m) => m.label);

// Kilometres between two coordinates — equirectangular, exact enough at the ~1 km radii the
// comparable-forecast rules use (the compare selector and the map's remount key).
function kmApart(a: { lat: number; lon: number }, b: { lat: number; lon: number }): number {
  const dLat = (a.lat - b.lat) * 111.32;
  const dLon = (a.lon - b.lon) * 111.32 * Math.cos((a.lat * Math.PI) / 180);
  return Math.sqrt(dLat * dLat + dLon * dLon);
}

// Stands in for the model stack until there's a location to attribute. Every selector option but
// EU resolves differently from place to place, so without coordinates there's nothing to name.
const MODEL_HINT_NO_LOCATION = 'Set a location to see which models will be used.';

// Device-selector help copy. Each line says how the forecast travels on that device, which is what
// picks between them: the route a reader has left is usually the only one they have. Filtered
// against DEVICES so a route the platform hides loses its help line with it.
const DEVICE_INFO = [
  { name: 'Internet', desc: 'Fetches the forecast over a WiFi or cellular data connection.' },
  { name: 'SMS', desc: 'Sends the forecast over a text message for weak cell reception without data.' },
  { name: 'inReach', desc: 'Copies the message so that it can be pasted into the Garmin Earthmate or Messenger app and sent over inReach.' },
  { name: 'ZOLEO', desc: 'Copies the message so that it can be pasted into the ZOLEO app and sent over satellite.' },
  { name: 'iPhone', desc: 'Sends the forecast over a text message, and asks for the reply in a form that fits a single message over satellite. Choose this on an iPhone that can text without cell service.' },
].filter((info) => DEVICES.some((d) => d.label === info.name));

// Id of the subgroup the air-quality toggles fold under — stable across a change of scale, which
// its heading is not, so folding it open survives switching from one index to the other.
const AIR_SUBGROUP = 'air';
// Id of the subgroup the pressure-level wind toggles fold under, one row per level.
const WIND_SUBGROUP = 'wind';

interface VarGroup {
  value: string;
  // The group's `v:` request code — or, for a pressure-level wind row, absent: those travel in
  // the `w:` token as ladder indices (`windLevel`).
  code?: string;
  windLevel?: number;
  label: string;
  // Help copy for this group, shown in the Extra Variables modal. Kept beside the label so the two
  // can't drift: a row and its explanation are written once, in one place.
  desc: string;
  vars: readonly Variable[];
  // Set to fold this group into a collapsible sub-list under that subgroup's heading. Purely
  // display: the request carries each member's own code, and a subgroup is never toggled as a unit.
  subgroup?: string;
  // Set on the variables that belong to one air-quality index. Only the scale the reader has
  // chosen in Settings is offered; the other index's groups are left out of the list entirely, so
  // a request can't carry a scale the reader doesn't read in.
  scale?: AqiScale;
}

// User-selectable variable groups. Each toggle enables/disables all of its underlying
// protocol variables together (e.g. "Clouds" covers the pressure-level band, not total cover).
// Order is display order only — the server unions the `v:` codes into the vars set, so the emitted
// order carries no meaning. The single-row weather groups lead, and the two collapsible
// subgroups sit at the end, where opening one can't push the rest of the list out of reach.
// The air-quality entries are single variables rather than bundles: smoke and ozone are different
// hazards on different schedules (a smoke plume arrives and stays for days; ozone peaks every
// afternoon), and someone watching for fire smoke shouldn't have to pay for the rest. Their labels
// name the pollutant and never the region: only one index is on offer at a time, so a row here is
// unambiguous, and the scale it's read on is settled in Settings.
const VAR_GROUPS: VarGroup[] = [
  {
    value: 'clouds', code: 'c', label: 'Detailed Clouds', vars: [VAR_CODES.c],
    desc: 'Cloud cover at 8 different levels of the atmosphere.',
  },
  {
    value: 'humidity', code: 'h', label: 'Humidity', vars: [VAR_CODES.h],
    desc: 'Dewpoint, relative humidity, and feels-like temperature.',
  },
  {
    value: 'precip', code: 'p', label: 'Precipitation Probability', vars: [VAR_CODES.p],
    desc: 'Probability of more than 0.1mm of precipitation in the hour. Computed from an '
      + 'ensemble model.',
  },
  {
    value: 'freeze', code: 'f', label: 'Freezing Level', vars: [VAR_CODES.f],
    desc: 'Altitude at which atmospheric temperature drops to 0°C.',
  },
  {
    value: 'agreement', code: 'g', label: 'Model Agreement', vars: [VAR_CODES.g],
    desc: 'How well the other forecast centers agree with the precip, wind, and temperature '
      + 'of this forecast.',
  },
  {
    value: 'aqi', code: 'a', label: 'AQI (Dominant pollutant)', vars: [VAR_CODES.a],
    subgroup: AIR_SUBGROUP, scale: 'us',
    desc: 'Index of the worst pollutant out of PM2.5, PM10, ozone, NO₂, and SO₂.',
  },
  {
    value: 'smoke', code: 's', label: 'PM2.5 (Smoke)', vars: [VAR_CODES.s],
    subgroup: AIR_SUBGROUP, scale: 'us',
    desc: 'Fine-particulate pollution from wildfire smoke and haze.',
  },
  {
    value: 'pm10', code: 'm', label: 'PM10 (Dust)', vars: [VAR_CODES.m],
    subgroup: AIR_SUBGROUP, scale: 'us',
    desc: 'Coarse particulates like blowing dust, pollen, and road grit.',
  },
  {
    value: 'ozone', code: 'o', label: 'Ozone (Smog)', vars: [VAR_CODES.o],
    subgroup: AIR_SUBGROUP, scale: 'us',
    desc: 'Summer smog, which peaks in the afternoon.',
  },
  {
    value: 'no2', code: 'd', label: 'NO₂ (Traffic)', vars: [VAR_CODES.d],
    subgroup: AIR_SUBGROUP, scale: 'us',
    desc: 'Combustion exhaust, worst near busy roads at rush hour.',
  },
  {
    value: 'so2', code: 'u', label: 'SO₂ (Industrial/Volcanic)', vars: [VAR_CODES.u],
    subgroup: AIR_SUBGROUP, scale: 'us',
    desc: 'Smelters, coal plants, ship fuel, and volcanic vents.',
  },
  {
    value: 'aqi-eu', code: 'e', label: 'AQI (Dominant pollutant)', vars: [VAR_CODES.e],
    subgroup: AIR_SUBGROUP, scale: 'eu',
    desc: 'Index of the worst pollutant out of PM2.5, PM10, ozone, NO₂, and SO₂.',
  },
  {
    value: 'smoke-eu', code: '2', label: 'PM2.5 (Smoke)', vars: [VAR_CODES['2']],
    subgroup: AIR_SUBGROUP, scale: 'eu',
    desc: 'Fine-particulate pollution from wildfire smoke and haze.',
  },
  {
    value: 'pm10-eu', code: '1', label: 'PM10 (Dust)', vars: [VAR_CODES['1']],
    subgroup: AIR_SUBGROUP, scale: 'eu',
    desc: 'Coarse particulates like blowing dust, pollen, and road grit.',
  },
  {
    value: 'ozone-eu', code: '3', label: 'Ozone (Smog)', vars: [VAR_CODES['3']],
    subgroup: AIR_SUBGROUP, scale: 'eu',
    desc: 'Summer smog, which peaks in the afternoon. This scale\'s most common worst pollutant.',
  },
  {
    value: 'no2-eu', code: 'n', label: 'NO₂ (Traffic)', vars: [VAR_CODES.n],
    subgroup: AIR_SUBGROUP, scale: 'eu',
    desc: 'Combustion exhaust, worst near busy roads at rush hour.',
  },
  {
    value: 'so2-eu', code: 'q', label: 'SO₂ (Industrial/Volcanic)', vars: [VAR_CODES.q],
    subgroup: AIR_SUBGROUP, scale: 'eu',
    desc: 'Smelters, coal plants, ship fuel, and volcanic vents.',
  },
  // One row per pressure level, highest first. The label is the level's rung on the cloud
  // band's altitude ladder (ladderLabel — the same rough band the meteogram's rail names), the
  // pressure after it for the reader who thinks in hectopascals; the rung is written in the
  // reader's unit at render time (windLevelLabel). Every ticked level is carried — a reader on a
  // summit who ticks 925 hPa gets model air under the terrain, which is theirs to leave out.
  ...WIND_LEVELS_HPA.map((hpa, li): VarGroup => ({
    value: `w${hpa}`, windLevel: li, label: `${hpa} hPa`, vars: [WIND_LEVEL_VARS[li]],
    subgroup: WIND_SUBGROUP,
    desc: `Wind speed and direction at the ${hpa} hPa pressure level.`,
  })),
];

// "18k ft (500 hPa)": the level's rung on the altitude ladder, then the pressure the wire names —
// or just "500 hPa" for the reader whose ladder IS pressure, where the pair would say it twice.
function windLevelLabel(hpa: number, units: UnitPrefs): string {
  return units.level === 'hpa' ? `${hpa} hPa` : `${ladderLabel(hpa, units.level)} (${hpa} hPa)`;
}
// A group's label in the reader's units — only the wind levels carry a unit.
function groupLabel(g: VarGroup, units: UnitPrefs): string {
  return g.windLevel != null ? windLevelLabel(WIND_LEVELS_HPA[g.windLevel], units) : g.label;
}

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
  | {
      kind: 'subgroup'; id: string; label: string; desc: string; members: VarGroup[];
      // Set where the heading's own paragraph says everything its rows would: the info card then
      // prints the paragraph alone. The rows still draw in the list — that is where they are
      // picked — but in the card they would only restate their own labels.
      descCoversMembers?: boolean;
    };

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
const WIND_DESC = 'Winds at up to 7 pressure levels in the atmosphere.';
// The subgroup headings. The air-quality one names the hazard and nothing else: which index is
// in force is a Settings preference, and repeating it on every visit here would put a choice in
// front of the reader that isn't theirs to make here.
const SUBGROUPS: Record<string, {
  label: string; desc: string; descCoversMembers?: boolean;
}> = {
  // One row per level, each described by its own label — the count in WIND_DESC is the whole story.
  [WIND_SUBGROUP]: { label: 'Pressure-Level Winds', desc: WIND_DESC, descCoversMembers: true },
  [AIR_SUBGROUP]: { label: 'Air Quality', desc: AIR_DESC },
};

function buildVarTree(scale: AqiScale): VarNode[] {
  const tree: VarNode[] = [];
  for (const group of visibleVarGroups(scale)) {
    const open = tree[tree.length - 1];
    if (group.subgroup == null) tree.push({ kind: 'group', group });
    else if (open?.kind === 'subgroup' && open.id === group.subgroup) open.members.push(group);
    else tree.push({ kind: 'subgroup', id: group.subgroup, ...SUBGROUPS[group.subgroup], members: [group] });
  }
  return tree;
}

// No extra variables selected by default.
const DEFAULT_GROUPS = new Set<string>();

// The request leads with the protocol version and picks a priority mode (`p:`), not a duration
// or resolution — the server refines along the mode's path until the reply reaches the budget the
// route allows, which `d:` and `n:` name and both ends derive from one table (see devices.ts).
// On the internet route there is no budget, so it refines until the upstream data runs out.
// `z:` is the local-midnight UTC offset the period grid aligns to. `u:` carries the account token
// so the server can attribute the request to the user. `o:` is the operating system, for the
// server's records. `k:` is the message code the slim response echoes so the client can recover
// the request context (see cache.ts).
function buildMsg(token: string, coords: { lat: number; lon: number } | null, mode: number, model: string, vars: ReadonlySet<Variable>, device: Device, messages: number, code: number, startEpochHour: number): string {
  const parts: string[] = [`v${WIRE_VERSION}`];
  if (coords) parts.push(`${coords.lat.toFixed(4)},${coords.lon.toFixed(4)}`);
  parts.push(`p:${PRIORITIES.find((m) => m.value === mode)!.token}`);
  parts.push(`z:${requestOffsetHours(coords, startEpochHour)}`);
  parts.push(`m:${model}`);
  // Both variable tokens are derived from the one selection set: `v:` carries the group codes,
  // `w:` the ladder indices of the selected pressure levels (`w:234` = 500/600/700 hPa).
  const groupCodes = varGroupCodesFor(vars);
  if (groupCodes) parts.push(`v:${groupCodes}`);
  const windLevels = windLevelsToken(vars);
  if (windLevels) parts.push(`w:${windLevels}`);
  // `d:` is what tells the server which pipe the reply has to fit down — it picks the response
  // alphabet as well as its length. The length is derived from `d:` and `n:` at both ends, off
  // the one table in the protocol, so the request no longer spends characters restating it.
  parts.push(`d:${deviceCode(device)}`);
  // `o:` names the operating system, which the route does not imply: Android sends over SMS
  // and the internet exactly as iOS does. The server records it and nothing more.
  parts.push(`o:${platformCode()}`);
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
function buildContext(coords: { lat: number; lon: number }, mode: number, model: string, vars: ReadonlySet<Variable>, startEpochHour: number, device: Device): RequestContext {
  return {
    mode,
    utcOffsetHours: requestOffsetHours(coords, startEpochHour),
    model: MODEL_BIT[model.toUpperCase()] ?? 0, // single model index
    vars,
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

// The last instant a forecast from this model can reach: the end of the final day slot its fill
// path can cover (see layout.ts — the remainder of the request day plus whole local days, capped
// by the model's slot count for a short-horizon center). The maximum, not what a given request
// will get — how far the fill actually reaches depends on the weather's entropy, which isn't
// knowable before the reply comes back.
function forecastWindowEndMs(model: string, coords: { lat: number; lon: number }, startEpochHour: number): number {
  const offset = requestOffsetHours(coords, startEpochHour);
  const day0 = Math.floor((startEpochHour + offset) / 24) * 24; // local midnight of the request day
  const slots = fillSlotsFor(MODEL_BIT[model.toUpperCase()] ?? 0, startEpochHour, offset);
  return (day0 + 24 * slots - offset) * 3600000;
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
  const windowEndMs = forecastWindowEndMs(model, coords, startEpochHour);
  const labels: string[] = [];
  let covered = 0;
  for (const spec of predictCenter(model as Center, coords.lat, coords.lon).models) {
    if (covered >= windowEndMs) break;
    const end = estimatedLastFullRunMs(spec, nowMs) + spec.horizonHours * 3600000;
    if (end <= covered) continue;
    covered = end;
    if (!labels.includes(spec.label)) labels.push(spec.label);
  }
  return labels.length ? labels.join(' › ') : null;
}

// A forecast fetch on the wire. `cancelled` separates an abort we raised on purpose from the
// timeout's and from any other failure, which the catch can't tell apart on its own.
interface InFlight {
  controller: AbortController;
  cancelled: boolean;
}

// ── Reading the reply ──────────────────────────────────────────────────────

function latLonLabel(msg: ForecastMessage): string {
  const latStr = `${Math.abs(msg.lat).toFixed(2)}°${msg.lat >= 0 ? 'N' : 'S'}`;
  const lonStr = `${Math.abs(msg.lon).toFixed(2)}°${msg.lon >= 0 ? 'E' : 'W'}`;
  return `${latStr} ${lonStr}`;
}

// The priority mode the forecast was requested with (msg.mode: Detail/Auto/Range),
// labelled the same way as the builder's priority selector.
function priorityLabel(msg: ForecastMessage): string {
  return MODE_NAMES[msg.mode] ?? MODE_NAMES[DEFAULT_MODE];
}

/**
 * The forecast point's elevation, in the user's units. Empty at sea level, which
 * is also what the wire format reports when it has no elevation to carry.
 */
function elevationLabel(msg: ForecastMessage, units: UnitPrefs): string {
  if (msg.elevation <= 0) return '';
  return units.altitude === 'ft'
    ? `${Math.round(msg.elevation * 3.28084).toLocaleString()}ft`
    : `${Math.round(msg.elevation).toLocaleString()}m`;
}

function requestTimeLabel(requestedAt: number): string {
  return new Date(requestedAt).toLocaleTimeString('en-US', {
    hour: 'numeric', minute: '2-digit', hour12: true,
  }).replace(/\s/g, '').toLowerCase();
}

function requestDateTimeLabel(requestedAt: number): string {
  const date = new Date(requestedAt);
  return `${date.toLocaleDateString()} ${requestTimeLabel(requestedAt)}`;
}

// Compares a paste against a cached slot on the REASSEMBLED message, so a reply pasted as two
// numbered parts still matches the slot that holds it whole. This one must never throw: a paste
// with only the first part of two is a normal in-progress state here, not an error, so anything
// that won't reassemble yet falls back to its raw text and simply matches nothing.
function normalizedForecastData(encoded: string): string {
  try {
    return normalizeReply(encoded);
  } catch {
    return encoded.replace(/\s/g, '');
  }
}

/** The loaded forecast's own meta row: when it was requested and where it is for. */
function loadedMetaLabel(slot: Slot, msg: ForecastMessage | null, units: UnitPrefs): string {
  if (!msg) return 'Unknown';
  const elev = elevationLabel(msg, units);
  const elevStr = elev ? ` · ${elev}` : '';
  return `${requestDateTimeLabel(slot.requestedAt)} · ${latLonLabel(msg)}${elevStr}`;
}

/**
 * One line per entry in the past-forecast list: request time · model · priority ·
 * location, naming the priority only when it isn't the Auto default.
 */
function pastMetaLabel(slot: Slot, msg: ForecastMessage | null): string {
  if (!msg) return 'Unknown';
  const priority = msg.mode !== MODE_AUTO ? ` · ${priorityLabel(msg)}` : '';
  const model = modelLabelFromMask(msg.models_mask);
  return `${requestTimeLabel(slot.requestedAt)} · ${model}${priority} · ${latLonLabel(msg)}`;
}

const OPTIONAL_VARIABLE_TAGS: { vars: readonly Variable[]; tag: string; label: string }[] = [
  { vars: [VAR.clouds], tag: 'C', label: 'Detailed clouds' },
  { vars: WIND_LEVEL_VARS, tag: 'W', label: 'Pressure-level winds' },
  { vars: [VAR.freeze], tag: 'FL', label: 'Freezing level' },
  { vars: [VAR.dewpoint], tag: 'H', label: 'Humidity' },
  { vars: [VAR.precip], tag: 'P', label: 'Precipitation probability' },
  { vars: [VAR.agreement], tag: 'A', label: 'Model agreement' },
  // One tag for the whole air-quality block: which index a request picked is the meteogram's
  // business, and five near-identical chips on a cache row would say less than one.
  { vars: [VAR.aqi, VAR.aq_pm25, VAR.aq_o3, VAR.aq_pm10, VAR.aq_no2, VAR.aq_so2,
           VAR.aqi_eu, VAR.aqi_eu_pm25, VAR.aqi_eu_o3, VAR.aqi_eu_pm10, VAR.aqi_eu_no2, VAR.aqi_eu_so2],
    tag: 'AQI', label: 'Air quality' },
];

function variableTagsFor(selected: ReadonlySet<Variable>) {
  return OPTIONAL_VARIABLE_TAGS.filter(({ vars }) =>
    vars.some((variable) => selected.has(variable)),
  );
}

function cacheVariableTags(msg: ForecastMessage | null) {
  return msg ? variableTagsFor(msg.vars) : [];
}

interface PastForecastGroup {
  day: number;
  slots: Slot[];
}

/** Group forecasts by their local start day while preserving newest-first order. */
function groupPastForecasts(slots: Slot[], msgOf: (slot: Slot) => ForecastMessage | null): PastForecastGroup[] {
  const groups: PastForecastGroup[] = [];
  for (const slot of slots) {
    const msg = msgOf(slot);
    // A slot that no longer decodes groups by its saved/request time instead.
    const start = msg ? startDatetime(msg) : new Date(slot.savedAt ?? slot.requestedAt);
    const day = new Date(start.getFullYear(), start.getMonth(), start.getDate()).getTime();
    const group = groups.find((candidate) => candidate.day === day);
    if (group) group.slots.push(slot);
    else groups.push({ day, slots: [slot] });
  }
  return groups.sort((a, b) => b.day - a.day);
}

function dayLabel(day: number): string {
  const date = new Date(day);
  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const yesterday = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1).getTime();
  const numericDate = `${date.getMonth() + 1}/${date.getDate()}`;
  if (day === today) return `Today ${numericDate}`;
  if (day === yesterday) return `Yesterday ${numericDate}`;
  return date.toLocaleDateString(undefined, {
    weekday: 'long', month: 'short', day: 'numeric',
    ...(date.getFullYear() !== now.getFullYear() ? { year: 'numeric' } : {}),
  });
}

// ── Multi-message collection ───────────────────────────────────────────────

// What a reader has pasted of a reply that arrived as several messages. Half a reply is a normal
// in-progress state on this route, not a failure, so it gets its own state rather than an error.
//
// `total` is 0 when nothing in the reply says how many messages it has — the case where the
// transport, not the server, broke it up. Then `have` is simply 1..n in paste order (see
// chunksCollected), and how many are still to come is not knowable until the reply decodes.
interface Collecting {
  total: number;
  have: number[];
}

// One small box per message of the reply — a green check for what has been pasted, an empty grey
// box for what is still in the reader's messages — sitting directly under the paste button, since
// what it asks for is another press of that button. The boxes are in message order and carry no
// numbers: which one is missing is the position, and the caption says what to do about it.
//
// A labelled reply says how many messages it has, so all of them get a box from the start. An
// unlabelled one doesn't: it gets a box per message pasted and a single open box after them,
// which is the whole of what can honestly be shown about a reply whose length only decoding it
// reveals. The reader keeps pasting until the forecast appears.
//
// Clear drops the collection. It lives here, with the boxes, because this is the one state
// with no other way out: an unlabelled collection that has taken a stray message can never
// decode, and pasting the first message again is ignored as a duplicate. Everything else the
// paste button holds is replaced by the next paste.
function CollectingBox({ total, have, onClear }: Collecting & { onClear: () => void }) {
  const boxes = total > 0
    ? Array.from({ length: total }, (_, i) => have.includes(i + 1))
    : [...have.map(() => true), false];
  const boxLabel = (index: number, received: boolean): string => {
    if (total > 0) return `Message ${index} of ${total} ${received ? 'received' : 'missing'}`;
    return received ? `Message ${index} received` : 'Next message not yet pasted';
  };
  return (
    <View style={styles.collectArea}>
      <View style={styles.collectRow}>
        <View style={styles.segmentRow}>
          {boxes.map((received, i) => (
            <View
              key={i}
              style={[styles.segment, received ? styles.segmentReceived : styles.segmentMissing]}
              accessibilityLabel={boxLabel(i + 1, received)}
            >
              {received && <Text style={styles.segmentCheck}>✓</Text>}
            </View>
          ))}
        </View>
        <TouchableOpacity
          style={styles.collectClearBtn}
          onPress={onClear}
          accessibilityRole="button"
          accessibilityLabel="Clear"
          accessibilityHint="Drops the messages pasted so far"
        >
          <Text style={styles.collectClearText}>Clear</Text>
        </TouchableOpacity>
      </View>
      <Text style={styles.collectCaption}>
        {total > 0 ? 'Paste remaining forecast segments' : 'Paste remaining message parts'}
      </Text>
    </View>
  );
}

// ── HomeScreen ─────────────────────────────────────────────────────────────

// What the paste button says after a press, and whether it says it in green or red. The same
// dwell as the Copy inReach Message confirmation.
interface Outcome {
  label: string;
  failed: boolean;
}
const OUTCOME_MS = 2000;
const FAILED_LABEL = 'Error loading forecast';

interface Props {
  token: string;
  // Owned by App so it can be read from storage behind the splash — see App.tsx.
  device: Device;
  onDeviceChange: (device: Device) => void;
  twoMessages: boolean;
  onTwoMessagesChange: (on: boolean) => void;
  // Which air-quality index to offer. A Settings preference, changed there rather than here.
  aqiScale: AqiScale;
  // The reader's units, for the wind levels' altitude rungs and the forecast display.
  units: UnitPrefs;
  timeFormat: TimeFormat;
  // Owned by App so deleting the account can clear it along with everything else.
  forecastData: string;
  onForecastDataChange: (v: string) => void;
  // Opens the Settings sheet, which App owns — it outlives this screen's scroll position.
  onOpenSettings: () => void;
}

export default function HomeScreen({ token, device, onDeviceChange, twoMessages, onTwoMessagesChange, aqiScale, units, timeFormat, forecastData, onForecastDataChange, onOpenSettings }: Props) {
  // ── Builder state ────────────────────────────────────────────────────────
  // Whether the pin rides the phone's position. Following resolves the location from the last fix
  // and re-fixes at send; pinned takes whatever is in the coordinates field. A fresh install starts
  // following, so the first send asks for location on its own.
  const [following, setFollowing] = useState(true);
  const [gpsCoords, setGpsCoords] = useState<{ lat: number; lon: number } | null>(null);
  // When the fix in gpsCoords was taken (ms epoch, 0 = never). The OS's own timestamp, not ours:
  // getCurrentPositionAsync may hand back a cached fix, and its age is the fix's, not the call's.
  const gpsFixedAt = useRef(0);
  const [coordsText, setCoordsText] = useState('');
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

  // ── Forecast state ───────────────────────────────────────────────────────
  // The page's scroll offset, native-driven, handed to the meteogram so each block can pin its
  // date header to the top of the screen once the drawn one scrolls away.
  const scrollY = useRef(new Animated.Value(0)).current;
  const [decoded, setDecoded] = useState<ForecastMessage | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [collecting, setCollecting] = useState<Collecting | null>(null);
  // What the paste button is reporting — the outcome of the last press, or null when it is back
  // to offering the paste (see flash).
  const [outcome, setOutcome] = useState<Outcome | null>(null);
  const outcomeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [cache, setCache] = useState<Slot[]>([]);
  // Every cached forecast decoded once per cache change. The past-forecast list needs each
  // slot's message three times per render (its day, its label, its variable icons), and a
  // decode of a full-fill message runs a few milliseconds; decoding in render made every
  // HomeScreen render pay for the whole list.
  const slotMessages = useMemo(() => {
    const decoded = new Map<Slot, ForecastMessage | null>();
    for (const slot of cache) {
      try { decoded.set(slot, decodeAny(slot.encoded!, token)); } catch { decoded.set(slot, null); }
    }
    return decoded;
  }, [cache, token]);
  const slotMessage = useCallback((slot: Slot) => slotMessages.get(slot) ?? null, [slotMessages]);
  // When true, the next decode came from loading a cached entry — don't re-attach it.
  const suppressNextCache = useRef(false);
  // A cached entry put on screen by loadPast ahead of the decode effect, with the text it was
  // decoded from: the effect finds it settled and leaves its state alone.
  const predecoded = useRef<{ data: string; msg: ForecastMessage } | null>(null);

  // The forecast is below the whole builder, so a reply that decodes while the reader is looking
  // at the request form would land out of sight. A successful decode of new text raises
  // `pendingScroll`; the scroll itself needs the meta row's position (`metaY`, measured on
  // layout), so whichever of the decode effect and the layout callback learns its half last is
  // the one that scrolls. Refs, not state: none of this should redraw anything.
  // Where the resting content seats, per orientation (see insets.ts): below the status bar in
  // portrait, at the very top in iPhone landscape — where the sides inset instead, clear of the
  // camera cutout. Meteogram derives its dock line and page width from the same rule.
  const { width: winW, height: winH } = useWindowDimensions();
  const { top: topInset, side: sideInset } = pageInsets(winW, winH);
  const scrollRef = useRef<ScrollView>(null);
  // Lets the overview strip hold the page still while it is scrubbed (see OverviewStrip). Set on
  // the native view directly: a prop would re-render this whole screen on every touch.
  const pageScroll = useMemo<PageScroll>(() => ({
    setScrollEnabled: (enabled) => scrollRef.current?.setNativeProps({ scrollEnabled: enabled }),
  }), []);
  const metaY = useRef<number | null>(null);
  const pendingScroll = useRef(false);
  // Set by a compare-pill tap: the reader is already looking at the meteogram, so the decode
  // that follows should swap the forecast in place rather than scroll the page back to its top.
  const suppressNextViewScroll = useRef(false);
  // The map's remount key, held steady while the loaded forecast stays within ~1 km of the
  // key's coordinate: flipping between comparable forecasts must not tear the map view down
  // and rebuild it (LocationMap tracks small coordinate nudges itself, with an animated ease).
  // A genuinely new location still gets a fresh key, remounting and recentering as before.
  const mapKeyRef = useRef<{ key: string; lat: number; lon: number } | null>(null);
  // The forecast map's frame in the scroll content, measured on layout, and where the forecast
  // display ends (a zero-height marker after the compare row — the meteogram block's immediate
  // follower; the attribution lives further down, below Saved forecasts). Together
  // they drive the map's parking translation: once the map's bottom edge has scrolled up to the
  // status bar's bottom, the map stops and its tail stays parked in the status-bar band — the
  // clock reads over map tiles while the meteogram's strip docks flush beneath it (see
  // Meteogram's pin). The park ends where the docked assembly beneath it ends: the right clamp
  // stops the translation at the same offset the strip and plate start riding off (their own
  // clamp end), so the stack leaves the screen together, the map slice stacked directly above
  // the strip — rather than the map owning the status bar over everything below it, or landing
  // displaced over the meteogram's tail.
  const [mapFrame, setMapFrame] = useState<{ y: number; h: number } | null>(null);
  const [forecastEnd, setForecastEnd] = useState<number | null>(null);
  // The open tap detail panel's height (0 when closed). It sits between the meteogram's last
  // rows and the end-of-forecast marker, so it stretches forecastEnd without moving Meteogram's own clamp
  // end — left in, the map would stay parked over the panel for that extra stretch of scroll
  // after the strip and plate had ridden off, leaving a map slice under the status bar.
  const [detailH, setDetailH] = useState(0);
  const mapPark = useMemo(() => {
    if (mapFrame == null || forecastEnd == null) return null;
    const parkY = mapFrame.y + mapFrame.h - topInset;
    // How far the park carries: the forecast's height below the map, less the docked stack that
    // rides off beneath it. forecastEnd (the end-of-forecast marker) minus the detail panel and the
    // stack height is the same scroll offset Meteogram's own clamp ends at, so the exits align.
    const travel = forecastEnd - detailH - (mapFrame.y + mapFrame.h) - PINNED_STACK_H;
    if (travel <= 0) return null;
    return scrollY.interpolate({
      inputRange: [parkY, parkY + travel], outputRange: [0, travel], extrapolate: 'clamp',
    });
  }, [mapFrame, forecastEnd, detailH, scrollY, topInset]);
  function scrollToForecast() {
    if (!pendingScroll.current || metaY.current == null) return;
    pendingScroll.current = false;
    scrollRef.current?.scrollTo({ y: Math.max(metaY.current - topInset - 8, 0), animated: true });
  }
  useEffect(() => { if (decoded) scrollToForecast(); }, [decoded]);

  // The forecast fetch currently on the wire, so something other than its own timeout can call it
  // off. Only the internet route has one — the other devices hand the request to another app and
  // are done with it.
  const inFlight = useRef<InFlight | null>(null);
  // A fetch whose reply is in the decoder's hands. The spinner runs until the forecast is on
  // screen, not until its bytes arrive: between those two moments sit the store load, the decode
  // and the meteogram's first (heavy) render, and a spinner that stopped at the bytes left that
  // whole stretch looking stalled. Set on a successful reply, cleared when the decode effect
  // settles that text — whichever way it settles.
  const fetchDecoding = useRef(false);

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
    fetchDecoding.current = false;
    setFetching(false);
  }

  // The busy action button's press: call off whichever wait is holding it, the GPS re-fix or
  // the forecast fetch (only one can be running; both calls are no-ops when idle).
  function cancelAction() {
    locateGen.current++;
    setLocating(false);
    cancelFetch();
  }

  const unavail = MODEL_UNAVAIL_VARS[model] ?? NO_UNAVAIL_VARS;
  // Expand the always-on variables plus any enabled groups for the stored request context. Only
  // configurable variables go in the message because the server adds the always-on set. Read off
  // the scale-filtered list, so switching the Settings preference drops the other index's
  // variables from the request without having to clear what's ticked: come back to that scale and
  // the selection is as it was left.
  //
  // Memoized, like everything the builder is handed: the builder re-renders only when one of its
  // inputs changes identity (see RequestBuilder).
  const { activeValues, vars } = useMemo(() => {
    const activeGroups = visibleVarGroups(aqiScale)
      .filter((g) => groups.has(g.value))
      .map((g) => ({ ...g, vars: g.vars.filter((v) => !unavail.includes(v)) }))
      .filter((g) => g.vars.length > 0);
    // What a closed subgroup counts. A group the model can't supply adds nothing to the request,
    // so it isn't reported as if it did — activeGroups has already dropped those.
    return {
      activeValues: new Set(activeGroups.map((g) => g.value)),
      vars: new Set<Variable>([...ALWAYS_VARS, ...activeGroups.flatMap((g) => g.vars)]),
    };
  }, [aqiScale, groups, unavail]);
  const modeName = PRIORITIES.find((m) => m.value === mode)!.label;

  // Whether the multi-message switch is on offer at all, and so how many messages the reply may
  // use. The route decides whether a second message is possible, the selection whether it is
  // worth asking about (multiMessageOffered states the rule per route); a switch left on from an
  // earlier selection counts only while it is showing, so narrowing the variables back down
  // returns to one message without the reader having to find and turn it off.
  const multiMessageShown = multiMessageOffered(deviceCode(device), vars);
  const messages = multiMessageShown && twoMessages ? 2 : DEFAULT_MESSAGES;

  const parsedCoords = useMemo(() => parseLatLon(coordsText), [coordsText]);
  const coordsInvalid = !following && coordsText.trim().length > 0 && parsedCoords == null;
  const resolvedCoords = following ? gpsCoords : parsedCoords;
  // What the field shows: the fix while following, otherwise whatever was typed or picked.
  const coordsField = following ? (gpsCoords ? formatLatLon(gpsCoords) : '') : coordsText;
  const coordsValid = resolvedCoords != null
    && isFinite(resolvedCoords.lat) && isFinite(resolvedCoords.lon);
  const mapCoord = coordsValid ? resolvedCoords : null;
  // What the selected option resolves to here, so the choice isn't abstract: "Auto" means a 2km
  // model in the Alps and a 9km one over the Alaska Range, and the US and Canadian stacks drop to
  // their global member outside their short-range domains. Which models serve depends on run age,
  // hence the clock — but only through horizons that move together, so the chain is stable enough
  // that recomputing it on render is all it needs.
  const modelStack = coordsValid
    ? modelStackLabel(model, resolvedCoords, alignedStartEpochHour())
    : null;
  // While following, the button stays tappable so it can request GPS on demand.
  const sendDisabled = locating || (!following && !coordsValid);
  const fetchDisabled = sendDisabled || fetching || offline;

  // Read the phone's position, assuming permission is already in hand. Null when no fix came back
  // — indoors, airplane mode, a cold start that timed out. Says nothing itself: its two callers
  // differ only in whether a failure is worth reporting, so that stays with them.
  async function fetchPosition(): Promise<{ lat: number; lon: number } | null> {
    try {
      return takeFix(await Location.getCurrentPositionAsync({ accuracy: Location.Accuracy.Balanced }));
    } catch {
      return null;
    }
  }

  // Store a fix as the phone's position. The OS's own timestamp, not the time of arrival: a watch
  // hands over whatever it last knew before it has anything new, and that can be hours old.
  function takeFix(pos: Location.LocationObject): { lat: number; lon: number } {
    const coords = { lat: pos.coords.latitude, lon: pos.coords.longitude };
    setGpsCoords(coords);
    gpsFixedAt.current = pos.timestamp;
    return coords;
  }

  // Which GPS wait is current. getCurrentPositionAsync can't be aborted, so cancelling one means
  // abandoning it: the cancel bumps the generation, and a wait whose generation has passed
  // returns null without alerting, its eventual fix ignored (though fetchPosition still stores
  // it, which only makes the next send fresher).
  const locateGen = useRef(0);

  async function requestCurrentLocation(): Promise<{ lat: number; lon: number } | null> {
    const gen = ++locateGen.current;
    setLocating(true);
    try {
      const { status, canAskAgain } = await Location.requestForegroundPermissionsAsync();
      setLocationGranted(status === 'granted');
      if (locateGen.current !== gen) return null;
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
      if (locateGen.current !== gen) return null;
      // The error behind a missing fix names nothing useful, so don't put it in front of anyone —
      // the fallback is the same whatever it was.
      if (coords == null) Alert.alert('Location unavailable', LOCATION_FAILED);
      return coords;
    } finally {
      // A cancelled wait has already had its spinner cleared, possibly by a newer wait that now
      // owns it.
      if (locateGen.current === gen) setLocating(false);
    }
  }

  // Whether the app is in the foreground. The position watch below only runs while it is, and
  // each return to the foreground is where a fix taken before the app was put away gets dropped.
  const [foreground, setForeground] = useState(AppState.currentState !== 'background');
  useEffect(() => {
    const sub = AppState.addEventListener('change', (state) => {
      const active = state === 'active';
      setForeground(active);
      // Permission can change in Settings while the app is away, in either direction.
      if (active) Location.getForegroundPermissionsAsync().then(({ granted }) => setLocationGranted(granted));
      // Whatever fix was on the map is now as old as the time away. Showing nothing until the
      // watch delivers is better than showing where the phone was when it was put away.
      if (active) setGpsCoords((c) => (c && Date.now() - gpsFixedAt.current > GPS_FIX_MAX_AGE_MS ? null : c));
    });
    return () => sub.remove();
  }, []);

  // Follow the phone's position while the app is open, so the map and the model subtext show
  // where the phone is now rather than where it was opened. Only when access has already been
  // granted: an unprompted permission dialog on open asks for something the user hasn't tried to
  // do yet, and the send buttons still raise the prompt at the moment it's actually needed. The
  // watch is silent and doesn't set `locating` either: nothing waits on it, so a background
  // convenience shouldn't spin the buttons or raise an alert about a fix nobody asked for.
  // A watch opens with the last fix the OS has, which may predate the app; one that old is left
  // for the send path to replace rather than drawn as current.
  const [locationGranted, setLocationGranted] = useState(false);
  useEffect(() => {
    Location.getForegroundPermissionsAsync().then(({ granted }) => setLocationGranted(granted));
  }, []);
  useEffect(() => {
    if (!locationGranted || !foreground) return;
    let sub: Location.LocationSubscription | null = null;
    let stopped = false;
    Location.watchPositionAsync(GPS_WATCH_OPTIONS, (pos) => {
      if (Date.now() - pos.timestamp <= GPS_FIX_MAX_AGE_MS) takeFix(pos);
    }).then((s) => {
      if (stopped) s.remove();
      else sub = s;
    }, () => {});
    return () => {
      stopped = true;
      sub?.remove();
    };
  }, [locationGranted, foreground]);

  // Pin the location at whatever the field holds. Typing, picking on the map and clearing all come
  // through here, so each of them takes the pin off the phone's position.
  function pinCoordsText(text: string) {
    setCoordsText(text);
    setFollowing(false);
  }

  // The locate button: a fresh fix, and the pin back on the phone's position if one came. A failed
  // fix leaves things as they were; requestCurrentLocation has already said why.
  async function follow(): Promise<{ lat: number; lon: number } | null> {
    const coords = await requestCurrentLocation();
    if (coords) setFollowing(true);
    return coords;
  }

  // A pinned point outlives the session; following does not. Nothing is saved until the restore
  // has landed, or the mount's default of following would erase the point before it was read.
  const pinRestored = useRef(false);
  useEffect(() => {
    loadPinnedCoords().then((text) => {
      if (text != null) {
        setCoordsText(text);
        setFollowing(false);
      }
      pinRestored.current = true;
    });
  }, []);
  useEffect(() => {
    if (pinRestored.current) savePinnedCoords(following ? null : coordsText);
  }, [following, coordsText]);

  // Resolve the location (asking for GPS on demand while following), allocate the message
  // code the reply will echo, and build the request it belongs to. Null when there's no usable
  // location. Every send path goes through here so each outgoing request gets its own code.
  //
  // Callers just stop on null and say nothing: the only branch that can produce one is a failed
  // requestCurrentLocation, which has already raised its own alert and notice. The other route to
  // null — a pinned point with unparseable coordinates — greys out the action button, so it never
  // gets this far.
  async function prepareMessage(): Promise<string | null> {
    let coords = resolvedCoords;
    // A stale fix takes the same on-demand path as a missing one: a send is the moment the
    // location has to be right, and refreshing through requestCurrentLocation means a failed
    // re-fix aborts with the same alert instead of quietly sending where the phone used to be.
    if (following
      && (!coordsValid || Date.now() - gpsFixedAt.current > GPS_FIX_MAX_AGE_MS)) {
      coords = await requestCurrentLocation();
    }
    if (coords == null || !isFinite(coords.lat) || !isFinite(coords.lon)) return null;
    const startHour = alignedStartEpochHour();
    const code = await allocCode(token, buildContext(coords, mode, model, vars, startHour, device), `${modeName} · ${model.toUpperCase()}`);
    return buildMsg(token, coords, mode, model, vars, device, messages, code, startHour);
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
      // has already walked away from — hand it on and it draws a forecast for a route they left.
      if (req.cancelled) return;
      if (encoded === forecastData) {
        // The reply is the text already on screen, so nothing will re-decode — there is no
        // settling to wait for. Just bring the forecast back into view.
        pendingScroll.current = true;
        scrollToForecast();
      } else {
        fetchDecoding.current = true;
        onForecastDataChange(encoded);
      }
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
        if (!fetchDecoding.current) setFetching(false);
      }
    }
  }

  // ── Decoding ─────────────────────────────────────────────────────────────

  useEffect(() => {
    prunePastForecasts(token).then(setCache);
  }, [token]);

  useEffect(() => () => { if (outcomeTimer.current) clearTimeout(outcomeTimer.current); }, []);

  // Puts an outcome on the paste button and takes it off again. A failure is held for the same
  // beat as a success and no longer: the button has to go back to offering the paste, since
  // pasting again is the whole of what a reader can do about any of these — the box below keeps
  // saying what went wrong for as long as it applies.
  const flash = useCallback((label: string, failed = false) => {
    setOutcome({ label, failed });
    if (outcomeTimer.current) clearTimeout(outcomeTimer.current);
    outcomeTimer.current = setTimeout(() => setOutcome(null), OUTCOME_MS);
  }, []);

  useEffect(() => {
    let cancelled = false;
    if (!forecastData.trim()) {
      setDecoded(null);
      setError(null);
      setCollecting(null);
      suppressNextCache.current = false;
      fetchDecoding.current = false;
      return;
    }
    const pre = predecoded.current?.data === forecastData ? predecoded.current.msg : null;
    predecoded.current = null;
    (async () => {
      try {
        // The store maps the message code → request context; load it before the (sync) decode.
        await loadStore(token);
        if (cancelled) return;
        const msg = pre ?? decodeAny(forecastData, token);
        // A cached entry loaded by loadPast is already on screen, its scroll already settled.
        if (!pre) {
          setDecoded(msg);
          setError(null);
          setCollecting(null);
          // A decode of new text is the moment the forecast should come on screen, whichever way
          // the text arrived — a fetch reply, a completed paste, a cached entry loaded back.
          // Except a compare-pill swap: the reader is already there.
          pendingScroll.current = !suppressNextViewScroll.current;
          suppressNextViewScroll.current = false;
        }
        if (suppressNextCache.current) {
          suppressNextCache.current = false;
        } else {
          attachResponse(token, msg.code, forecastData).then((slots) => { if (!cancelled) setCache(slots); });
        }
      } catch (e) {
        suppressNextCache.current = false;
        setDecoded(null);
        setCollecting(null);
        const msg = String(e);
        const parts = replyParts(forecastData);
        if (msg.includes('Missing message') && parts.total > 0) {
          // Not an error: the rest of a multi-message reply is still in the reader's messages,
          // and the boxes say which. Anything else about the paste is wrong and stays an error.
          setError(null);
          setCollecting(parts);
          return;
        }
        // The same in-progress state for a reply nothing labelled, which is what the reader has
        // when the transport did the splitting. There is no error to distinguish here — an
        // incomplete body fails to decode exactly the way corrupt text does — so what makes this
        // a collection rather than a failure is that it starts with the header of a forecast this
        // device asked for, and that is what chunksCollected checks.
        const held = chunksCollected(forecastData, token);
        if (held > 0) {
          setError(null);
          setCollecting({ total: 0, have: Array.from({ length: held }, (_, i) => i + 1) });
          return;
        }
        flash(FAILED_LABEL, true);
        if (msg.includes('different forecast') || msg.includes('pasted twice')) {
          // Reassembly failures that name the message at fault are the reader's to fix, so they go
          // through as written. Stray text mixed into a paste is NOT one of them: the protocol's
          // wording tells the reader to paste each message on its own, which is advice about a
          // text field this screen doesn't have — a paste like that is just an invalid forecast.
          setError(msg.replace(/^Error:\s*/, ''));
        } else if (msg.includes('Unknown forecast code')) {
          setError("This forecast doesn't match a request from this device. It may have been sent elsewhere or expired. Request a new forecast.");
        } else {
          // Everything else is one message, on purpose. A version the codec doesn't know reads as
          // a retired or future protocol, but a message's first character IS its version tag, so
          // any text that isn't a reply lands there too — and the version-specific advice was
          // wrong in both directions: the cache is pruned of undecodable forecasts on every load,
          // so a stale saved forecast never reaches here, and a reader in the field can neither
          // need an app update (the request carries the version they encoded with) nor get one.
          setError('Invalid forecast. Request a new forecast and paste the reply from your device.');
        }
      } finally {
        // The reply this decode settled came off the wire — stop the spinner it was holding.
        // Batched with the setDecoded/setError above, so the spinner leaves in the very commit
        // that puts the forecast (or its error) on screen, and the scroll follows straight off
        // that commit's layout.
        if (fetchDecoding.current) {
          fetchDecoding.current = false;
          setFetching(false);
        }
      }
    })();
    return () => { cancelled = true; };
  }, [forecastData, token, flash]);

  // A reply that arrived as two messages is pasted as two messages, so a paste folds into what
  // is already here when — and only when — it is another part of the same reply (see mergeReply).
  //
  // The button then reports what the press actually did, the way the Copy inReach Message button
  // confirms a copy: the clipboard gives no sign of having been read, and the screen may not change
  // at all — a re-pasted message merges to what is already loaded, and a segment that leaves the
  // reply incomplete draws no forecast. Without a label for those, a press that did nothing and a
  // press that collected a message look identical.
  const pasteFromClipboard = useCallback(async () => {
    try {
      const text = await Clipboard.getStringAsync();
      // An empty clipboard (or one holding an image, which reads back as '') still gets an
      // outcome: a silent return here left the press looking like it did nothing.
      if (!text.trim()) {
        flash('Clipboard is empty', true);
        return;
      }
      // Both the merge and the label below ask whether a message belongs to a request this device
      // made, so the store has to be warm before either — it is loaded on mount, but a paste is
      // the first thing a reader does and needn't lose that race.
      await loadStore(token);
      const merged = mergeReply(forecastData, text, token);
      const incoming = replyParts(text);
      // Messages of an unlabelled reply are counted, not numbered: the reply says nothing about
      // which one this was, only the reader's paste order does. Zero once it decodes.
      const held = chunksCollected(merged, token);
      onForecastDataChange(merged);
      // The labels below confirm the press, so they must not outrun the decoder: text that will
      // neither decode nor stand as a collection gets the failure label here rather than a green
      // beat the decode effect flips to red a moment later. Checked on the merged text whether or
      // not the paste changed it — a re-paste of the same broken text changes nothing, never
      // reaches the decode effect at all, and still isn't "Already loaded". The same decode the
      // effect will run, so the two always agree on which this is.
      let settles = held > 0;
      if (!settles) {
        try {
          decodeAny(merged, token);
          settles = true;
        } catch (e) {
          settles = String(e).includes('Missing message') && replyParts(merged).total > 0;
        }
      }
      if (!settles) {
        flash(FAILED_LABEL, true);
        return;
      }
      flash(
        merged.trim() === forecastData.trim() ? (held ? 'Already added' : 'Already loaded')
          : held ? `Added message ${held}`
            : incoming.have.length === 1 ? `Loaded part ${incoming.have[0]}/${incoming.total}`
              : 'Loaded forecast',
      );
    } catch {
      setError('Could not read the clipboard.');
      flash(FAILED_LABEL, true);
    }
  }, [forecastData, onForecastDataChange, flash, token]);

  // Drops whatever is held. Nothing decoded is lost — a forecast that decoded is in the cache and
  // a tap away in Saved forecasts — but a half-collected reply is, which is the point: it is the
  // way out of a collection that can never decode, and without it a reader who pasted the wrong
  // message would be stuck in one, with no text field to edit.
  const clearForecast = useCallback(() => {
    if (outcomeTimer.current) clearTimeout(outcomeTimer.current);
    setOutcome(null);
    onForecastDataChange('');
  }, [onForecastDataChange]);

  const loadPast = useCallback((encoded: string) => {
    suppressNextCache.current = true;
    // A cached entry is decoded already (slotMessages), so it goes on screen in the render that
    // takes its text rather than a decode effect and a second commit later. The pill index, the
    // meta line and the meteogram then change in one commit and one layout pass. The decode
    // effect still runs for the entry and finds it settled (predecoded).
    const slot = cache.find((s) => s.encoded === encoded);
    const msg = slot ? slotMessages.get(slot) : null;
    if (msg) {
      predecoded.current = { data: encoded, msg };
      pendingScroll.current = !suppressNextViewScroll.current;
      suppressNextViewScroll.current = false;
      setDecoded(msg);
      setError(null);
      setCollecting(null);
    }
    onForecastDataChange(encoded);
  }, [cache, slotMessages, onForecastDataChange]);

  // A compare-pill tap: loadPast, minus the scroll-to-forecast (see suppressNextViewScroll).
  const loadCompare = useCallback((encoded: string) => {
    suppressNextViewScroll.current = true;
    loadPast(encoded);
  }, [loadPast]);

  // ── Render ───────────────────────────────────────────────────────────────

  // What the one action button does, per device. The label and icon come from the device table
  // (devices.ts); what stays here is the part that depends on this screen's state — which handler
  // sends the request, and what has to be true before it can. Only the internet route needs a
  // connection, and only it can sit in a fetch, so only it is greyed out by either.
  const ACTIONS: Record<Device, { onPress: () => void; disabled: boolean; busy: boolean }> = {
    internet: { onPress: handleFetch, disabled: fetchDisabled, busy: fetching || locating },
    sms: { onPress: handleSendSms, disabled: sendDisabled, busy: locating },
    inreach: { onPress: handleCopy, disabled: sendDisabled, busy: locating },
    zoleo: { onPress: handleCopy, disabled: sendDisabled, busy: locating },
    // iPhone hands off to Messages exactly as SMS does — same text, same recipient. What differs
    // is the reply, which comes back in the wide alphabet so it lands in a single bubble.
    iphone: { onPress: handleSendSms, disabled: sendDisabled, busy: locating },
  };
  const deviceSpec = DEVICES.find((d) => d.value === device)!;
  const action = ACTIONS[device];
  // Copy is the only action with something to confirm — the others hand off to another app,
  // which is its own confirmation.
  const copied = (device === 'inreach' || device === 'zoleo') && messageCopied;

  // The list to draw, under the scale the reader has chosen, and the rows it becomes: each
  // subgroup's heading always, its members only while it's open.
  const varTree = useMemo(() => buildVarTree(aqiScale), [aqiScale]);
  const varRows = useMemo(() => {
    const rows: VarRow[] = [];
    for (const node of varTree) {
      if (node.kind === 'group') {
        rows.push({ key: node.group.value, kind: 'toggle', group: node.group, indent: false });
        continue;
      }
      rows.push({ key: node.id, kind: 'subgroup', id: node.id, label: node.label, members: node.members });
      if (openSubgroups.has(node.id)) {
        for (const group of node.members) {
          rows.push({ key: group.value, kind: 'toggle', group, indent: true });
        }
      }
    }
    return rows;
  }, [varTree, openSubgroups]);

  // The builder's handlers, with one identity each (useStableHandler): the functions above are
  // rewritten every render because they read this screen's state through their closures.
  const onPick = useStableHandler((c: { lat: number; lon: number }) => pinCoordsText(formatLatLon(c)));
  const onCoordsText = useStableHandler(pinCoordsText);
  const onLocate = useStableHandler(follow);
  const onToggleGroup = useStableHandler(toggleGroup);
  const onToggleSubgroup = useStableHandler(toggleSubgroup);
  const onDevice = useStableHandler((next: Device) => {
    setMessageCopied(false);
    // The device is what the reply's length and alphabet are cut to, so a fetch started under
    // the old one can only come back wrong. Switching is also how someone gets out of a stalled
    // internet request — leaving it running would spin the button on a route that no longer
    // fetches anything.
    cancelFetch();
    onDeviceChange(next);
  });
  const onAction = useStableHandler(() => action.onPress());
  const onCancelAction = useStableHandler(cancelAction);
  // pasteFromClipboard is keyed on the forecast text, so it changes on every load; the parent's
  // multi-message callback is whatever App passed this render.
  const onPaste = useStableHandler(pasteFromClipboard);
  const onTwoMessages = useStableHandler(onTwoMessagesChange);

  const pastGroups = useMemo(() => groupPastForecasts(cache, slotMessage), [cache, slotMessage]);
  const loadedSlot = cache.find((slot) =>
    normalizedForecastData(slot.encoded!) === normalizedForecastData(forecastData),
  );

  // ── Compare selector ─────────────────────────────────────────────────────
  // Cached forecasts comparable to the one on screen — same request hour, same spot (within
  // ~1 km), the same rule the meteogram's scroll hold uses — so flipping between takes on the
  // same weather window is one tap under the meteogram. One segment per distinct look: the
  // center's short name plus its optional-variable count ("US +2"), so two requests to the
  // same center with different variables compare as easily as two centers. Behind one label,
  // the most recent response wins — except the loaded slot, which always keeps its segment so
  // exactly one is selected. Ordering is fixed (center, then count) and never depends on which
  // segment is selected.
  const optionalVarCount = (vars: ReadonlySet<Variable>) => {
    let n = 0;
    for (const v of vars) if (!ALWAYS_VARS.includes(v)) n++;
    return n;
  };
  const compareRef = loadedSlot?.context;
  const compareOptions = (() => {
    if (!compareRef) return [] as { label: string; slot: Slot }[];
    // Segments sit in the order their forecasts were first requested — the order the reader
    // built the comparison in — which stays put however the selection moves (`order` is the
    // label's earliest request, so a newer response re-winning a label doesn't reseat it).
    const byLabel = new Map<string, { label: string; order: number; slot: Slot }>();
    for (const s of cache) {
      if (!s.encoded) continue;
      if (Math.abs(s.context.start - compareRef.start) > 3600_000) continue;
      if (kmApart(s.context, compareRef) > 1) continue;
      const count = optionalVarCount(s.context.vars);
      const base = COMPARE_MODEL_LABELS[s.context.model] ?? '?';
      const label = count ? `${base} +${count}` : base;
      const held = byLabel.get(label);
      const heldIsLoaded = held?.slot.code === loadedSlot!.code;
      const order = Math.min(held?.order ?? Infinity, s.requestedAt);
      if (!held || (!heldIsLoaded && (s.code === loadedSlot!.code
        || (s.savedAt ?? 0) > (held.slot.savedAt ?? 0)))) {
        byLabel.set(label, { label, order, slot: s });
      } else {
        held.order = order;
      }
    }
    return [...byLabel.values()].sort((a, b) => a.order - b.order);
  })();

  // The past list takes only stable inputs (see PastForecasts), so a HomeScreen render that
  // changes nothing about it, a layout measurement or the minute tick, leaves it alone.
  const loadedKey = normalizedForecastData(forecastData);

  return (
    <Animated.ScrollView
      ref={scrollRef}
      style={styles.scroll}
      contentContainerStyle={[styles.content, { paddingTop: topInset, paddingHorizontal: sideInset }]}
      scrollIndicatorInsets={{ top: topInset }}
      keyboardShouldPersistTaps="handled"
      scrollEventThrottle={16}
      onScroll={Animated.event(
        [{ nativeEvent: { contentOffset: { y: scrollY } } }],
        { useNativeDriver: true },
      )}
    >
      {/* The title row scrolls with the page — it's the page's heading, not chrome — and
          Settings hangs off it. Icon and wordmark are the splash's, small. */}
      <View style={styles.titleRow}>
        <View style={styles.titleBrand}>
          <Image source={require('./assets/icon.png')} style={styles.titleIcon} />
          <Text style={styles.titleText}>Going Blue</Text>
        </View>
        <TouchableOpacity
          onPress={onOpenSettings}
          hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}
          accessibilityRole="button"
          accessibilityLabel="Settings"
        >
          <MaterialCommunityIcons name="cog-outline" size={24} color={palette.pageIcon} />
        </TouchableOpacity>
      </View>
      <View style={styles.titleRule} />

      {/* The builder carries the scroll content's side padding itself: the forecast pieces below
          it run full-bleed, and the meteogram's pinned headers measure their offset against the
          scroll content, which they can only do as its direct children. */}
      <RequestBuilder
        mapCoord={mapCoord} onPick={onPick} gpsCoords={gpsCoords} following={following} onLocate={onLocate}
        locating={locating} coordsField={coordsField} coordsInvalid={coordsInvalid} onCoordsText={onCoordsText}
        model={model} modelStack={modelStack} onModel={setModel} setModelInfo={setModelInfo}
        varRows={varRows} unavail={unavail} openSubgroups={openSubgroups} activeValues={activeValues} groups={groups}
        units={units} onToggleGroup={onToggleGroup} onToggleSubgroup={onToggleSubgroup} setVarsInfo={setVarsInfo}
        mode={mode} onMode={setMode} setPriorityInfo={setPriorityInfo}
        device={device} onDevice={onDevice} setDeviceInfo={setDeviceInfo}
        multiMessageShown={multiMessageShown} twoMessages={twoMessages} onTwoMessagesChange={onTwoMessages}
        deviceSpec={deviceSpec} copied={copied} onAction={onAction} onCancelAction={onCancelAction}
        actionDisabled={action.disabled} actionBusy={action.busy} offline={offline} coordsValid={coordsValid}
        setHelp={setHelp} outcome={outcome} onPaste={onPaste} onClearForecast={clearForecast}
        collecting={collecting} error={error}
      />

      {decoded && (
        <>
          {/* Meta. Its layout position is the scroll target that brings a fresh decode on screen. */}
          <View
            style={styles.metaRow}
            onLayout={(e) => { metaY.current = e.nativeEvent.layout.y; scrollToForecast(); }}
          >
            {/* Blank for the frames between the decode and the cache write that gives the
                message its slot; the row holds a line's height so nothing under it moves. */}
            <Text style={styles.metaText} numberOfLines={3}>
              {loadedSlot ? loadedMetaLabel(loadedSlot, slotMessage(loadedSlot), units) : ''}
            </Text>
          </View>

          {/* Forecast location. Keyed on the coordinate so loading a new forecast recenters the
              map. The wrapper parks: its bottom edge stops at the status bar's bottom (mapPark)
              and everything after it slides underneath — hence the zIndex. */}
          <Animated.View
            style={[styles.mapFloat, mapPark && { transform: [{ translateY: mapPark }] }]}
            onLayout={(e) => {
              const { y, height } = e.nativeEvent.layout;
              setMapFrame((prev) => (prev?.y === y && prev?.h === height ? prev : { y, h: height }));
            }}
          >
            <LocationMap
              key={(() => {
                const held = mapKeyRef.current;
                if (held && kmApart(held, decoded) <= 1) return held.key;
                const key = `${decoded.lat},${decoded.lon}`;
                mapKeyRef.current = { key, lat: decoded.lat, lon: decoded.lon };
                return key;
              })()}
              coord={{ lat: decoded.lat, lon: decoded.lon }}
              height={200}
              userCoord={gpsCoords}
            />
          </Animated.View>

          {/* Forecast meteogram. Nothing hides this screen any more, so it is always active — the
              prop still exists for the repaint-after-hide machinery it drives inside. */}
          <Meteogram msg={decoded} units={units} timeFormat={timeFormat} active scrollY={scrollY} onDetailHeight={setDetailH} pageScroll={pageScroll} />

          {/* Compare selector: one segment per center holding a comparable cached forecast
              (see compareOptions), the same system control the request builder's selectors
              use. Only rendered when there's something to flip to; the meteogram's scroll
              hold keeps the viewport on the same stretch of time across a swap. */}
          {compareOptions.length > 1 && (
            <View style={styles.compareRow}>
              <SegmentedControl
                {...SEGMENT_PROPS}
                values={compareOptions.map((o) => o.label)}
                selectedIndex={compareOptions.findIndex((o) => o.slot.code === loadedSlot?.code)}
                onChange={(e) => {
                  const opt = compareOptions[e.nativeEvent.selectedSegmentIndex];
                  if (opt && opt.slot.code !== loadedSlot?.code) loadCompare(opt.slot.encoded!);
                }}
              />
            </View>
          )}

          {/* Zero-height marker for where the forecast display ends — the map's parking clamp
              reads this y (forecastEnd). The attribution used to both credit and mark; it now
              lives below Saved forecasts, so only the marker stays. */}
          <View
            onLayout={(e) => {
              const { y } = e.nativeEvent.layout;
              setForecastEnd((prev) => (prev === y ? prev : y));
            }}
          />
        </>
      )}

      {/* Where the forecast will be. Not shown while a collection or an error is under the paste
          button, which already say what to do next. */}
      {!decoded && !collecting && !error && (
        <View style={styles.emptyForecast}>
          <Text style={styles.emptyTitle}>No forecast loaded</Text>
          <Text style={styles.emptyHint}>Paste an encoded forecast reply to visualize it</Text>
        </View>
      )}

      <PastForecasts groups={pastGroups} loadedKey={loadedKey} slotMessage={slotMessage} units={units} onLoad={loadPast} />

      {/* Open-Meteo's data is CC BY 4.0, which asks for credit where the data is shown —
          the Settings footer alone doesn't satisfy that. Same wording as there. */}
      {decoded && (
        <Text style={styles.attribution}>
          Weather data provided by{' '}
          <Text style={styles.attributionLink} onPress={() => Linking.openURL('https://open-meteo.com/')}>
            Open-Meteo
          </Text>.
        </Text>
      )}

      <HelpScreen visible={help} onClose={() => setHelp(false)} />

      <InfoModal visible={priorityInfo} title="Fill Priority" onClose={() => setPriorityInfo(false)}>
        <View style={styles.modalItem}>
          <Text style={styles.modalBody}>
            Going Blue packs as much information as it can into each message. You can control what
            it prioritizes depending on what information is most important to you.
          </Text>
        </View>
        <Text style={styles.modalBody}>
          <Text style={styles.modalBold}>Detail</Text>: Hourly resolution with shorter range.
        </Text>
        <Text style={styles.modalBody}>
          <Text style={styles.modalBold}>Auto</Text>: Balance of resolution and range.
        </Text>
        <Text style={styles.modalBody}>
          <Text style={styles.modalBold}>Range</Text>: Long-range forecasts with lower resolution.
        </Text>
      </InfoModal>

      <InfoModal visible={modelInfo} title="Weather Model" onClose={() => setModelInfo(false)}>
        {MODEL_INFO.map((m) => (
          <View key={m.name} style={styles.modalItem}>
            <Text style={styles.modalBody}>
              <Text style={styles.modalBold}>{m.name}</Text>: {m.desc}
            </Text>
            {m.models.map(({ spec, region }) => (
              <Text key={spec.id} style={styles.modalBullet}>
                {'\u2022'} {spec.label}: {horizonText(spec.horizonHours)}, {region}
              </Text>
            ))}
          </View>
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
          By default, forecasts include temperature, rain, snow, wind, and weathercode. The
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
            {/* A subgroup whose paragraph covers its rows has nothing under it to head, so it
                reads as one more entry — same label, colon and text as the top-level ones. */}
            {node.descCoversMembers ? (
              <Text style={styles.modalItemIndent}>
                <Text style={styles.modalBold}>{node.label}</Text>: {node.desc}
              </Text>
            ) : (
              <>
                <Text style={styles.modalSubhead}>{node.label}</Text>
                <Text style={styles.modalSubdesc}>{node.desc}</Text>
                {node.members.map((m) => (
                  <Text key={m.value} style={[styles.modalItemIndent, styles.modalItemNested]}>
                    <Text style={styles.modalBold}>{groupLabel(m, units)}</Text>: {m.desc}
                  </Text>
                ))}
              </>
            )}
          </View>
        )))}
        <Text style={[styles.modalBody, styles.modalNote]}>Each added variable takes away from the detail and range of the forecast.</Text>
      </InfoModal>
    </Animated.ScrollView>
  );
}

// One cached forecast in the past list. Memoized on its own so a switch, which changes only which
// row is loaded, re-renders the two rows whose highlight flips and no others.
const PastForecastRow = memo(function PastForecastRow({ slot, msg, isLoaded, units, onLoad }: {
  slot: Slot; msg: ForecastMessage | null; isLoaded: boolean; units: UnitPrefs; onLoad: (encoded: string) => void;
}) {
  const variableTags = cacheVariableTags(msg);
  return (
    <View style={[styles.pastItem, isLoaded && styles.pastItemLoaded]}>
      <View style={styles.pastDetails}>
        <Text style={styles.pastMeta} numberOfLines={2}>{pastMetaLabel(slot, msg)}</Text>
        {variableTags.length > 0 && (
          <View style={styles.variableRow}>
            <Text style={styles.variableLabel}>Variables:</Text>
            {variableTags.map((entry) => (
              <Text
                key={entry.label}
                style={styles.pastTag}
                accessibilityLabel={entry.label}
              >
                {entry.tag}
              </Text>
            ))}
          </View>
        )}
      </View>
      <View style={styles.pastBtns}>
        <TouchableOpacity
          style={[styles.pastLoadBtn, isLoaded && styles.pastLoadBtnDisabled]}
          onPress={() => onLoad(slot.encoded!)}
          disabled={isLoaded}
        >
          <Text style={styles.pastLoadText}>Load</Text>
        </TouchableOpacity>
      </View>
    </View>
  );
});

// The past-forecast list. Every prop is stable across a HomeScreen render that doesn't concern
// the list: the groups are memoized on the cache, `loadedKey` is the loaded forecast's text
// normalized (a string, so it compares by value), and the lookup and load handler are memoized
// callbacks. A layout measurement or the minute tick then re-renders HomeScreen without
// walking this subtree, which on a long history is the taller half of the screen.
const PastForecasts = memo(function PastForecasts({ groups, loadedKey, slotMessage, units, onLoad }: {
  groups: PastForecastGroup[]; loadedKey: string; slotMessage: (slot: Slot) => ForecastMessage | null;
  units: UnitPrefs; onLoad: (encoded: string) => void;
}) {
  // Nothing saved, no section: the page ends at the paste step.
  if (groups.length === 0) return null;
  return (
    <View style={styles.pastSection}>
      <View style={styles.sectionEnd} />
      <Text style={styles.savedTitle}>Saved forecasts</Text>
      {groups.map((group) => (
        <View key={group.day} style={styles.pastGroup}>
          <Text style={styles.pastDayText}>{dayLabel(group.day)}</Text>
          {group.slots.map((slot) => (
            <PastForecastRow key={slot.code} slot={slot} msg={slotMessage(slot)}
              isLoaded={normalizedForecastData(slot.encoded!) === loadedKey} units={units} onLoad={onLoad} />
          ))}
        </View>
      ))}
    </View>
  );
});

// A handler with one identity for the component's lifetime that calls the latest render's
// closure. HomeScreen's handlers read most of its state, so they are rewritten every render;
// handed to a memoized child as they are, they would re-render it every time.
function useStableHandler<A extends unknown[], R>(fn: (...args: A) => R): (...args: A) => R {
  const ref = useRef(fn);
  useInsertionEffect(() => { ref.current = fn; });
  return useCallback((...args: A) => ref.current(...args), []);
}

// The request builder: the map, the model, variable, priority and device sections, the action
// button and the paste step. Memoized, and every prop is a primitive, a piece of state, a
// memoized derivation or a stable handler, so a render of HomeScreen that concerns the forecast
// below it (a load, a switch, a layout measurement) does not walk the builder.
const RequestBuilder = memo(function RequestBuilder({
  mapCoord, onPick, gpsCoords, following, onLocate, locating, coordsField, coordsInvalid, onCoordsText,
  model, modelStack, onModel, setModelInfo,
  varRows, unavail, openSubgroups, activeValues, groups, units, onToggleGroup, onToggleSubgroup, setVarsInfo,
  mode, onMode, setPriorityInfo,
  device, onDevice, setDeviceInfo, multiMessageShown, twoMessages, onTwoMessagesChange,
  deviceSpec, copied, onAction, onCancelAction, actionDisabled, actionBusy, offline, coordsValid, setHelp,
  outcome, onPaste, onClearForecast, collecting, error,
}: {
  mapCoord: { lat: number; lon: number } | null; onPick: (c: { lat: number; lon: number }) => void;
  gpsCoords: { lat: number; lon: number } | null; following: boolean; onLocate: () => Promise<{ lat: number; lon: number } | null>; locating: boolean;
  coordsField: string; coordsInvalid: boolean; onCoordsText: (text: string) => void;
  model: string; modelStack: string | null; onModel: (model: string) => void; setModelInfo: (open: boolean) => void;
  varRows: VarRow[]; unavail: readonly Variable[]; openSubgroups: ReadonlySet<string>; activeValues: ReadonlySet<string>;
  groups: ReadonlySet<string>; units: UnitPrefs; onToggleGroup: (value: string) => void; onToggleSubgroup: (id: string) => void;
  setVarsInfo: (open: boolean) => void;
  mode: number; onMode: (mode: number) => void; setPriorityInfo: (open: boolean) => void;
  device: Device; onDevice: (device: Device) => void; setDeviceInfo: (open: boolean) => void;
  multiMessageShown: boolean; twoMessages: boolean; onTwoMessagesChange: (on: boolean) => void;
  deviceSpec: (typeof DEVICES)[number]; copied: boolean; onAction: () => void; onCancelAction: () => void;
  actionDisabled: boolean; actionBusy: boolean; offline: boolean; coordsValid: boolean; setHelp: (open: boolean) => void;
  outcome: Outcome | null; onPaste: () => void; onClearForecast: () => void; collecting: Collecting | null; error: string | null;
}) {
  return (
    <View style={styles.builderPad}>
      {/* No heading: the map is its own label. Edge to edge, since the negative inset cancels
          the builder's horizontal padding, so the map spans the screen rather than sitting
          inside the column. The coordinates sit under it as the map's readout and a way to
          type or paste a point. */}
      <View style={styles.section}>
        <View style={styles.mapFullBleed}>
          <LocationMap
            coord={mapCoord}
            onPick={onPick}
            height={BUILDER_MAP_HEIGHT}
            userCoord={gpsCoords}
            following={following}
            onLocate={onLocate}
            locating={locating}
            onClear={() => onCoordsText('')}
            canClear={coordsField.length > 0}
          />
        </View>
        {SHOW_COORDINATES && (
        <View style={[styles.coordsCard, coordsInvalid && styles.coordsCardInvalid]}>
          <View style={[styles.coordRow, styles.coordRowLast]}>
            <Text style={[styles.coordLabel, styles.coordLabelWide]}>Coordinates</Text>
            {/* Editing pins. The first keystroke arrives with the field's whole text, fix
                included, so nudging the current location's digits works as expected. */}
            <TextInput
              style={[styles.coordInput, coordsInvalid && styles.coordInputInvalid]}
              value={coordsField}
              onChangeText={onCoordsText}
              placeholder="latitude, longitude"
              keyboardType="numbers-and-punctuation"
              autoCapitalize="none"
              autoCorrect={false}
              returnKeyType="done"
            />
            {/* Pasted coordinates are long and the keyboard's delete key clears them one
                character at a time; one tap on the ✕ empties the field. Same action as the
                map's clear button, placed where someone typing will look for it. Always laid
                out and merely hidden when there is nothing to clear: the icon is taller than
                the text line, so adding and removing it would change the row's height. */}
            <TouchableOpacity
              style={[styles.coordClear, coordsField.length === 0 && styles.coordClearHidden]}
              onPress={() => onCoordsText('')}
              disabled={coordsField.length === 0}
              hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}
              accessibilityRole="button"
              accessibilityLabel="Clear coordinates"
              accessibilityElementsHidden={coordsField.length === 0}
            >
              <MaterialCommunityIcons name="close-circle" size={18} color={palette.textTertiary} />
            </TouchableOpacity>
          </View>
        </View>
        )}
      </View>

      <Section label="Weather Model" info={() => setModelInfo(true)}>
        <SegmentedControl
          {...SEGMENT_PROPS}
          values={MODELS.map((m) => m.label)}
          selectedIndex={MODELS.findIndex((m) => m.value === model)}
          onChange={(e) => onModel(MODELS[e.nativeEvent.selectedSegmentIndex].value)}
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
                <Pressable
                  key={row.key}
                  style={({ pressed }) => [
                    styles.varRow, border, pressed && !disabled && styles.varRowPressed,
                  ]}
                  onPress={() => !disabled && onToggleSubgroup(row.id)}
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
                      color={palette.textTertiary}
                    />
                  </View>
                </Pressable>
              );
            }
            // A group is unavailable when the model can't supply any of its variables.
            const disabled = row.group.vars.every((v) => unavail.includes(v));
            const checked = groups.has(row.group.value) && !disabled;
            return (
              <Pressable
                key={row.key}
                style={({ pressed }) => [
                  styles.varRow, row.indent && styles.varRowIndent, border,
                  pressed && !disabled && styles.varRowPressed,
                ]}
                onPress={() => !disabled && onToggleGroup(row.group.value)}
                accessibilityRole="switch"
                accessibilityState={{ checked, disabled }}
              >
                <Text style={[styles.varLabel, disabled && styles.varLabelDim]}>{groupLabel(row.group, units)}</Text>
                {/* The row stays pressable as well: the switch swallows its own touches, so the
                    two never fire together, and the whole row remains the larger target. */}
                <Switch
                  {...SWITCH_PROPS}
                  style={styles.switchAlign}
                  value={checked}
                  disabled={disabled}
                  onValueChange={() => onToggleGroup(row.group.value)}
                  accessibilityElementsHidden
                  importantForAccessibility="no-hide-descendants"
                />
              </Pressable>
            );
          })}
        </View>
      </Section>

      <Section label="Fill Priority" info={() => setPriorityInfo(true)}>
        <SegmentedControl
          {...SEGMENT_PROPS}
          values={PRIORITIES.map((m) => m.label)}
          selectedIndex={PRIORITIES.findIndex((m) => m.value === mode)}
          onChange={(e) => onMode(PRIORITIES[e.nativeEvent.selectedSegmentIndex].value)}
        />
        <Text style={styles.modelHint}>{PRIORITIES.find((m) => m.value === mode)!.hint}</Text>
      </Section>

      {/* The way out. Which device you carry decides how the request travels, so it sits last,
          with the button it drives. */}
      <Section label="Device" info={() => setDeviceInfo(true)}>
        <SegmentedControl
          {...SEGMENT_PROPS}
          values={DEVICES.map((d) => d.label)}
          selectedIndex={DEVICES.findIndex((d) => d.value === device)}
          onChange={(e) => onDevice(DEVICES[e.nativeEvent.selectedSegmentIndex].value)}
        />
        {/* A switch rather than an On/Off segment: this is one setting being turned on, not a
            choice between two things, and it is read far more often than it is changed. */}
        {multiMessageShown && (
          <View style={styles.switchRow}>
            <View style={styles.switchText}>
              <Text style={styles.switchLabel}>Multi-message forecast</Text>
              <Text style={styles.switchHint}>Use multiple messages for more range and detail</Text>
            </View>
            <Switch
              {...SWITCH_PROPS}
              style={styles.switchAlign}
              value={twoMessages}
              onValueChange={onTwoMessagesChange}
              accessibilityLabel="Multi-message forecast"
              accessibilityHint="Use multiple messages for more range and detail"
            />
          </View>
        )}
      </Section>

      <View style={styles.buttons}>
        <ActionButton
          icon={copied ? 'check' : deviceSpec.icon}
          label={copied ? 'Copied' : deviceSpec.action}
          onPress={onAction}
          onCancel={onCancelAction}
          disabled={actionDisabled}
          busy={actionBusy}
          variant={copied ? 'success' : 'primary'}
        />
      </View>

      {/* Says why Get Forecast is greyed out, so it's shown only when that's the button on screen.
          Keyed on `offline` alone, not on fetchDisabled — a button greyed for want of a location is
          a different problem with a different fix. */}
      {device === 'internet' && offline && <Text style={styles.actionNote}>{OFFLINE_MESSAGE}</Text>}
      {/* The location half of that: a pinned point with nothing usable in the field greys every
          device's button, and the input sits a few sections up by the time the button is on
          screen. Both notes can show at once — offline and no location are separate problems,
          each with its own fix. */}
      {!following && !coordsValid && (
        <Text style={styles.actionNote}>{NO_LOCATION_MESSAGE}</Text>
      )}

      <TouchableOpacity
        style={styles.helpLink}
        onPress={() => setHelp(true)}
        activeOpacity={0.7}
        accessibilityRole="button"
      >
        <Text style={styles.helpLinkText}>How do I get a forecast?</Text>
      </TouchableOpacity>

      <View style={styles.sectionEnd} />

      {/* The way back in: pull the encoded reply straight off the clipboard. It follows the send
          step without a heading of its own because that is the flow — the reply this loads is to
          the request the send step just put on its way. The button also carries the last press's outcome for a moment — a
          green check for what it loaded, a red ✕ when the paste wouldn't decode — then goes back
          to offering the paste. There is no clear button: a new paste replaces whatever is held,
          and the one state that needs dropping by hand, a collection, carries its own Clear
          (see CollectingBox). */}
      <View style={styles.pasteArea}>
        <View style={styles.pasteRow}>
          <Pressable
            style={({ pressed }) => [
              styles.pasteBtn,
              outcome && (outcome.failed ? styles.pasteBtnFailed : styles.pasteBtnDone),
              pressed && styles.btnPressed,
            ]}
            onPress={onPaste}
            accessibilityRole="button"
            accessibilityLabel={outcome?.label ?? 'Paste Forecast'}
          >
            <MaterialCommunityIcons
              name={outcome ? (outcome.failed ? 'close' : 'check') : 'content-paste'}
              size={19}
              color={outcome ? (outcome.failed ? palette.danger : palette.success) : palette.onPrimary}
              style={styles.pasteBtnIcon}
            />
            <Text
              style={[
                styles.pasteBtnText,
                outcome && (outcome.failed ? styles.pasteBtnTextFailed : styles.pasteBtnTextDone),
              ]}
              numberOfLines={1}
            >
              {outcome?.label ?? 'Paste Forecast'}
            </Text>
          </Pressable>
        </View>
        {/* Both sit under the button, where what they ask for is another press of it. Only one can
            be showing: a paste is either short of its remaining messages or wrong, never both. */}
        {collecting && <CollectingBox {...collecting} onClear={onClearForecast} />}
        {error && (
          <View style={styles.errorBox}>
            <Text style={styles.errorText}>{error}</Text>
          </View>
        )}
      </View>

    </View>
  );
});

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

// A full-width action button: icon and label, replaced by a spinner and Cancel while the action
// resolves. The variants differ only in fill, so one tint drives the icon and the label together
// — and a disabled button is filled grey, which needs the light tint whatever its variant. Busy
// is the exception: a button that is off resolving its own press is working, not unavailable, so
// it keeps its variant's fill under the spinner — grey there made the GPS re-fix before a copy
// flash as a grey beat in the middle of the press-to-Copied sequence. While busy the button
// stays pressable and the press calls the wait off instead of re-firing the action.
function ActionButton({ icon, label, onPress, onCancel, disabled, busy, variant }: {
  icon: React.ComponentProps<typeof MaterialCommunityIcons>['name'];
  label: string;
  onPress: () => void;
  onCancel: () => void;
  disabled: boolean;
  busy: boolean;
  variant: 'primary' | 'success';
}) {
  const fill = { primary: styles.btnPrimary, success: styles.btnSuccess }[variant];
  const greyed = disabled && !busy;
  const tint = greyed || variant === 'primary' ? palette.onPrimary : palette.success;
  return (
    <Pressable
      style={({ pressed }) => [styles.btn, fill, greyed && styles.btnDisabled, pressed && styles.btnPressed]}
      onPress={busy ? onCancel : onPress}
      disabled={busy ? false : disabled}
      accessibilityRole="button"
      accessibilityLabel={busy ? 'Cancel' : label}
    >
      {busy ? (
        <>
          <ActivityIndicator color={tint} style={styles.btnIcon} />
          <Text style={[styles.btnText, { color: tint }]} numberOfLines={1}>Cancel</Text>
        </>
      ) : (
        <>
          <MaterialCommunityIcons name={icon} size={19} color={tint} style={styles.btnIcon} />
          {/* One line always: the row is a fixed 50pt, so a label that wrapped would be clipped
              rather than grow the button. */}
          <Text style={[styles.btnText, { color: tint }]} numberOfLines={1}>{label}</Text>
        </>
      )}
    </Pressable>
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
      {/* A Modal is its own window, so the provider at the app root is not above it in the native
          tree, and the safe-area view reads zero insets without a provider of its own here. */}
      <SafeAreaProvider>
        {/* No bottom edge: the frame runs to the screen edge so the scroll view fills it,
            and the content padding below clears the home indicator. */}
        <SafeAreaView edges={['top', 'left', 'right']} style={styles.sheet}>
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
      </SafeAreaProvider>
    </Modal>
  );
}

// ── Styles ─────────────────────────────────────────────────────────────────

// The builder's horizontal inset. Named so the map can cancel it and run edge to edge.
const CONTENT_PAD = 16;

const styles = StyleSheet.create({
  scroll: { flex: 1, backgroundColor: palette.page },
  // The orientation-dependent pads (top inset, cutout sides) are applied inline off pageInsets;
  // the bottom pad covers the home-indicator inset the scroll view extends under.
  content: { paddingBottom: 72 },
  // The scrolling title bar: icon and app name left, the Settings gear right.
  titleRow: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    paddingHorizontal: CONTENT_PAD, paddingTop: 20, paddingBottom: 8,
  },
  titleBrand: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  // Closes the title bar the way the section dividers close their sections: a full-width
  // hairline directly under it.
  titleRule: { height: StyleSheet.hairlineWidth, backgroundColor: palette.pageRule },
  // Rounded like the home-screen icon it is, at the setup screen's proportions, sized to the
  // wordmark's cap height plus a little.
  titleIcon: { width: 26, height: 26, borderRadius: 6 },
  // The splash wordmark's blue (see SetupScreen's brand), small.
  titleText: { fontSize: 20, fontWeight: '700', color: palette.brand },
  // No top padding: the map opens the builder flush against the title rule.
  builderPad: { padding: CONTENT_PAD, paddingTop: 0 },

  // Sheet frame, matching HelpScreen's. The safe area carries the status bar inset now that this
  // runs the full height, so the header only needs the same 12pt the app header uses.
  sheet: { flex: 1, backgroundColor: palette.sheet },
  sheetHeader: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    paddingHorizontal: 16, paddingTop: 12, paddingBottom: 12,
    borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: palette.cardRule,
  },
  sheetTitle: { flex: 1, fontSize: 20, fontWeight: '700', color: palette.text },
  sheetDone: { fontSize: 16, fontWeight: '600', color: palette.link, paddingLeft: 12 },
  sheetScroll: { flex: 1 },
  sheetContent: { paddingHorizontal: 16, paddingTop: 16, paddingBottom: 72 },

  // Sheet body copy, shared by all four ⓘ sheets.
  modalBody: { fontSize: 15, color: palette.textBody, lineHeight: 22 },
  modalItem: { fontSize: 15, color: palette.textBody, lineHeight: 22, marginBottom: 10 },
  // A model under its center, set in one step and tucked close enough to read as part of it.
  modalBullet: { fontSize: 15, color: palette.textBody, lineHeight: 22, marginTop: 4, paddingLeft: 12 },
  modalItemIndent: { fontSize: 15, color: palette.textBody, lineHeight: 22, marginTop: 10, paddingLeft: 12 },
  // Entries under a subgroup heading, set in one step further than the top-level ones.
  modalItemNested: { paddingLeft: 24 },
  modalSubhead: { fontSize: 15, fontWeight: '700', color: palette.text, marginTop: 14, paddingLeft: 12 },
  // A subgroup's own paragraph, sitting between its heading and its entries at the heading's indent.
  modalSubdesc: { fontSize: 15, color: palette.textBody, lineHeight: 22, marginTop: 4, paddingLeft: 12 },
  modalBold: { fontWeight: '700', color: palette.text },
  modalNote: { marginTop: 14 },
  modalLink: { color: palette.link, textDecorationLine: 'underline' },

  // The archive's heading, set off from the divider that closes the builder above it.
  savedTitle: { fontSize: 18, fontWeight: '600', color: palette.pageHeading, textAlign: 'center', marginTop: 20, marginBottom: 14 },
  // The rule that closes a section's bottom, bleeding past the page padding to the screen edge.
  sectionEnd: {
    height: StyleSheet.hairlineWidth, backgroundColor: palette.pageRule,
    marginTop: 24, marginHorizontal: -CONTENT_PAD,
  },

  section: { marginBottom: 20 },
  sectionHeader: { flexDirection: 'row', alignItems: 'center', marginBottom: 8 },
  sectionLabel: { fontSize: 12, fontWeight: '600', color: palette.pageLabel, textTransform: 'uppercase', letterSpacing: 0.5 },
  sectionInfo: { fontSize: 14, color: palette.pageLink, marginLeft: 6 },

  varList: { backgroundColor: palette.card, borderRadius: 12, overflow: 'hidden' },
  // Sized to a grouped iOS settings row: 50pt tall with 17pt labels, which the switch fits
  // inside, so a toggle row and a subgroup heading come out the same height. The padding is
  // only what a label needs when it wraps past one line.
  varRow: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    paddingHorizontal: 16, paddingVertical: 6, minHeight: 50,
  },
  // Members of an open subgroup, set in from their heading and off the white of the top-level rows.
  varRowIndent: { paddingLeft: 32, backgroundColor: palette.cardInset },
  varRowBorder: { borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: palette.cardRule },
  // Press feedback for the variable rows, declarative for the same reason as btnPressed: a row
  // re-renders from inside its own press handler (a toggle, a subgroup opening or closing), and a
  // touchable's animated fade can be stranded by that, leaving the row greyed until the next touch.
  varRowPressed: { opacity: 0.6 },
  // Switch composes alignSelf: 'flex-start' into its own iOS style, which on a row means the
  // top rather than the start, and beats the row's alignItems. Every switch needs this back.
  switchAlign: { alignSelf: 'center' },
  varLabel: { fontSize: 17, color: palette.text },
  varLabelDim: { color: palette.textDisabled },
  // The subgroup heading's right-hand side: how many of its rows are on, then the disclosure.
  varRowTrailing: { flexDirection: 'row', alignItems: 'center' },
  varCount: { fontSize: 13, color: palette.textTertiary, marginRight: 6 },

  // The border is always there, transparent until the field is invalid, so flagging a bad entry
  // recolors the card without resizing it.
  coordsCard: { marginTop: 10, backgroundColor: palette.card, borderRadius: 12, overflow: 'hidden', borderWidth: 1, borderColor: 'transparent' },
  coordsCardInvalid: { borderColor: palette.destructive },
  coordRow: { flexDirection: 'row', alignItems: 'baseline', paddingHorizontal: 14, paddingVertical: 12, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: palette.cardRule },
  coordRowLast: { borderBottomWidth: 0 },
  coordLabel: { width: 30, fontSize: 15, fontWeight: '600', color: palette.textSecondary },
  coordLabelWide: { width: 104 },
  coordInput: { flex: 1, fontSize: 15, color: palette.text },
  coordInputInvalid: { color: palette.destructive },
  // The row aligns on the text baseline, which an icon doesn't have; center it on the row instead.
  coordClear: { alignSelf: 'center', marginLeft: 8 },
  coordClearHidden: { opacity: 0 },
  mapFullBleed: { marginHorizontal: -CONTENT_PAD },
  modelHint: { fontSize: 12, color: palette.pageTextTertiary, lineHeight: 17, marginTop: 8 },

  // Full-width action, its icon and label on a single centered row.
  buttons: { marginTop: 4 },
  btn: { flexDirection: 'row', height: 50, borderRadius: 14, alignItems: 'center', justifyContent: 'center' },
  btnPrimary: { backgroundColor: palette.primary },
  btnSuccess: { backgroundColor: palette.successTint, borderWidth: 1, borderColor: palette.success },
  btnDisabled: { backgroundColor: palette.primaryDisabled, borderColor: palette.primaryDisabled },
  // Press feedback for the action and paste buttons. A declarative dim rather than
  // TouchableOpacity: both buttons re-render themselves from inside their own press handler
  // (busy, copied, a paste outcome), and a re-render landing mid-fade could strand the touchable's
  // animated opacity below 1 — the outcome then sat greyed until the next touch. Pressable's
  // pressed flag has no animation state to strand.
  btnPressed: { opacity: 0.4 },
  btnIcon: { marginRight: 8 },
  btnText: { fontSize: 16, fontWeight: '600' },

  actionNote: { fontSize: 13, color: palette.pageNote, lineHeight: 19, textAlign: 'center', marginTop: 10 },
  // A settings row: label left, switch right, the switch's own height setting the row's.
  switchRow: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    gap: 12, marginTop: 16,
  },
  switchText: { flexShrink: 1 },
  switchLabel: { fontSize: 15, color: palette.pageTitle },
  switchHint: { fontSize: 12, color: palette.pageTextTertiary, lineHeight: 17, marginTop: 2 },

  helpLink: { alignSelf: 'center', marginTop: 8, paddingVertical: 6, paddingHorizontal: 12 },
  helpLinkText: { color: palette.pageLink, fontSize: 14, fontWeight: '600' },

  // Set off from the divider above by the space a heading would have taken.
  pasteArea: { marginTop: 24 },
  pasteRow: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  // Same fills as the Copy inReach Message button (ActionButton above), so a confirmed press
  // looks the same in both places.
  pasteBtn: {
    flex: 1,
    flexDirection: 'row',
    height: 50,
    borderRadius: 14,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: palette.primary,
  },
  pasteBtnDone: { backgroundColor: palette.successTint, borderWidth: 1, borderColor: palette.success },
  // The error box's own colours, so the button and the reason under it read as one thing.
  pasteBtnFailed: { backgroundColor: palette.dangerTint, borderWidth: 1, borderColor: palette.danger },
  pasteBtnIcon: { marginRight: 8 },
  pasteBtnText: { color: palette.onPrimary, fontSize: 16, fontWeight: '600' },
  pasteBtnTextDone: { color: palette.success },
  pasteBtnTextFailed: { color: palette.danger },

  errorBox: { marginTop: 10, padding: 12, backgroundColor: palette.dangerTint, borderRadius: 10 },
  errorText: { color: palette.danger, fontSize: 14, lineHeight: 20 },

  // The boxes and Clear on one row, the caption on its own line under the boxes.
  collectArea: { paddingTop: 10, gap: 8 },
  collectRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 10 },
  compareRow: { marginTop: 10, marginHorizontal: 16 },
  segmentRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 6 },
  segment: {
    width: 24, height: 24,
    alignItems: 'center', justifyContent: 'center',
    borderWidth: 1, borderRadius: 6,
  },
  segmentReceived: { backgroundColor: palette.collectTint, borderColor: palette.collectBorder },
  segmentMissing: { backgroundColor: palette.pageChip, borderColor: palette.pageChipBorder, borderStyle: 'dashed' },
  segmentCheck: { fontSize: 13, lineHeight: 16, color: palette.collectCheck, fontWeight: '700' },
  collectCaption: { fontSize: 12, color: palette.pageTextSecondary },
  // The past list's Load button in gray: the same shape at the row's right edge, quieter because
  // it undoes rather than does.
  collectClearBtn: { paddingHorizontal: 14, paddingVertical: 6, borderRadius: 8, backgroundColor: palette.pageButton },
  collectClearText: { color: palette.pageButtonText, fontSize: 13, fontWeight: '600' },

  // The parked map must draw over what scrolls up beneath it once it stops.
  mapFloat: { zIndex: 1 },

  // Forecast meta and the past-forecast list, full-bleed siblings of the meteogram — they carry
  // their own margins.
  // A dashed outline the size of a short meteogram, so the page holds its shape before and after.
  emptyForecast: {
    marginHorizontal: 16, marginBottom: 8, paddingVertical: 28, paddingHorizontal: 16,
    alignItems: 'center', gap: 4,
    borderWidth: 1, borderStyle: 'dashed', borderColor: palette.pageChipBorder, borderRadius: 12,
  },
  emptyTitle: { fontSize: 15, fontWeight: '600', color: palette.pageTextSecondary },
  emptyHint: { fontSize: 13, color: palette.pageTextTertiary, textAlign: 'center' },
  metaRow: {
    margin: 16,
    marginBottom: 8,
    gap: 10,
  },
  metaText: { flexShrink: 1, fontSize: 13, color: palette.pageText, lineHeight: 18, minHeight: 18, textAlign: 'center' },
  variableRow: { flexDirection: 'row', alignItems: 'center', gap: 5 },
  variableLabel: { fontSize: 12, color: palette.pageTextSecondary },

  attribution: { fontSize: 12, color: palette.pageTextTertiary, marginTop: 8, marginHorizontal: 16 },
  attributionLink: { color: palette.pageLink, textDecorationLine: 'underline' },

  pastSection: { marginTop: 8, marginHorizontal: 16 },
  pastGroup: { marginBottom: 8 },
  pastDayText: { fontSize: 13, fontWeight: '600', color: palette.pageTextSecondary, paddingTop: 4, paddingBottom: 6 },
  pastItem: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    paddingVertical: 10, paddingHorizontal: 8, gap: 12,
    borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: palette.pageRuleLight,
  },
  pastItemLoaded: { backgroundColor: palette.selectedRow, borderRadius: 8, borderTopColor: palette.selectedRowBorder },
  pastDetails: { flex: 1, gap: 3 },
  pastMeta: { flexShrink: 1, fontSize: 13, color: palette.pageText, lineHeight: 18 },
  pastTag: {
    fontSize: 11,
    lineHeight: 14,
    fontWeight: '600',
    fontFamily: 'Courier',
    color: palette.pageLink,
    paddingHorizontal: 5,
    paddingVertical: 1,
    borderRadius: 4,
    borderWidth: 1,
    borderColor: palette.pageLink,
    backgroundColor: palette.linkTint,
    overflow: 'hidden',
  },
  pastBtns: { flexDirection: 'row', gap: 8 },
  pastLoadBtn: { paddingHorizontal: 14, paddingVertical: 6, borderRadius: 8, backgroundColor: palette.primary },
  pastLoadBtnDisabled: { backgroundColor: palette.primaryDisabled },
  pastLoadText: { color: palette.onPrimary, fontSize: 13, fontWeight: '600' },
});
