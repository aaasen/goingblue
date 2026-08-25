import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator, Alert, Animated, Image, Linking, Modal, Platform, SafeAreaView, ScrollView,
  StyleSheet, Switch, Text, TextInput, TouchableOpacity, View, useWindowDimensions,
} from 'react-native';
import * as Clipboard from 'expo-clipboard';
import * as Location from 'expo-location';
import * as Network from 'expo-network';
import { pageInsets } from './insets';
import MaterialCommunityIcons from '@expo/vector-icons/MaterialCommunityIcons';
import SegmentedControl from '@react-native-segmented-control/segmented-control';
import {
  VARS_BIT, V3_VERSION,
  ALWAYS_VARS_MASK, CONFIGURABLE_VAR_GROUPS, MODEL_BIT,
  WIND_LEVELS_HPA,
  MODE_DETAIL, MODE_AUTO, MODE_RANGE, MODE_NAMES, DEFAULT_MODE,
  predictCenter, estimatedLastFullRunMs, FILL_SLOTS, multiMessageOffered, startDatetime,
  type RequestContext, type Center, type ForecastMessage,
} from '@weather/protocol';
import { API_BASE } from './account';
import { type AqiScale, type TimeFormat, type UnitPrefs } from './settings';
import { ladderLabel } from './cloudBand';
import { deviceOffsetHours, offsetHoursAt } from './timezone';
import {
  allocCode, attachResponse, chunksCollected, decodeAny, loadStore, mergeReply, normalizeReply,
  prunePastForecasts, replyParts, type Slot,
} from './cache';
import LocationMap from './LocationMap';
import Meteogram, { PINNED_STACK_H } from './Meteogram';
import HelpScreen from './HelpScreen';
import { MODELS, modelIconsFromMask, modelLabelsFromMask } from './models';
import { DEVICES, deviceCode, type Device } from './devices';
import { parseLatLon } from './coords';

// The whole flow on one screen, in the order the steps happen: build a request at the top, send
// it with the device's button, paste the reply in under that, and read the decoded forecast
// below, with past forecasts at the bottom. What used to be the Builder and Decoder tabs.

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

// A fix taken when the app was opened can be hours old by the time a request goes out, and a
// forecast for where the phone used to be reads exactly like the right one. Sends re-fix beyond
// this age; under it, a burst of copies and sends stays instant.
const GPS_FIX_MAX_AGE_MS = 60_000;

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
  { name: 'inReach', desc: 'Copies the message so that it can be pasted into the Garmin Earthmate or Messenger app and sent over inReach.' },
  { name: 'ZOLEO', desc: 'Copies the message so that it can be pasted into the ZOLEO app and sent over satellite.' },
  { name: 'iPhone', desc: 'Sends the forecast over a text message, and asks for the reply in a form that fits a single message over satellite. Choose this on an iPhone that can text without cell service.' },
];

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
// protocol variables together (e.g. "Clouds" covers the pressure-level band, not total cover).
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
    desc: 'Cloud cover at 8 different levels of the atmosphere.',
  },
  // One row per pressure level, highest first. The label is the level's rung on the cloud
  // band's altitude ladder (ladderLabel — the same rough band the meteogram's rail names), the
  // pressure after it for the reader who thinks in hectopascals; the rung is written in the
  // reader's unit at render time (windLevelLabel). Every ticked level is carried — a reader on a
  // summit who ticks 925 hPa gets model air under the terrain, which is theirs to leave out.
  ...WIND_LEVELS_HPA.map((hpa, li): VarGroup => ({
    value: `w${hpa}`, windLevel: li, label: `${hpa} hPa`, vars: [`w${hpa}`],
    subgroup: WIND_SUBGROUP,
    desc: `Wind speed and direction at the ${hpa} hPa pressure level.`,
  })),
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
    desc: 'Index of the worst pollutant out of PM2.5, PM10, ozone, NO₂, and SO₂.',
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
    desc: 'Index of the worst pollutant out of PM2.5, PM10, ozone, NO₂, and SO₂.',
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
// so the server can attribute the request to the user. `k:` is the message code the slim response
// echoes so the client can recover the request context (see cache.ts).
function buildMsg(token: string, coords: { lat: number; lon: number } | null, mode: number, model: string, variableCodes: string[], windLevels: number[], device: Device, messages: number, code: number, startEpochHour: number): string {
  const parts: string[] = [`v${V3_VERSION}`];
  if (coords) parts.push(`${coords.lat.toFixed(4)},${coords.lon.toFixed(4)}`);
  parts.push(`p:${PRIORITIES.find((m) => m.value === mode)!.token}`);
  parts.push(`z:${requestOffsetHours(coords, startEpochHour)}`);
  parts.push(`m:${model}`);
  if (variableCodes.length) parts.push(`v:${variableCodes.join('')}`);
  // Pressure-level wind: the ladder indices of the selected levels (`w:234` = 500/600/700 hPa).
  if (windLevels.length) parts.push(`w:${windLevels.join('')}`);
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

// ── Reading the reply ──────────────────────────────────────────────────────

function latLonLabel(msg: ForecastMessage): string {
  const latStr = `${Math.abs(msg.lat).toFixed(2)}°${msg.lat >= 0 ? 'N' : 'S'}`;
  const lonStr = `${Math.abs(msg.lon).toFixed(2)}°${msg.lon >= 0 ? 'E' : 'W'}`;
  return `${latStr} ${lonStr}`;
}

function hoursLabel(h: number): string {
  return `${h}h`;
}

/**
 * The resolution(s) a message carries: uniform ("12h", "3h") or, for a mixed
 * layout, the finest–coarsest range ("1h–12h").
 */
function resolutionLabel(msg: ForecastMessage): string {
  const finest = Math.min(...msg.periodHours);
  const coarsest = Math.max(...msg.periodHours);
  if (finest === coarsest) return hoursLabel(finest);
  return `${hoursLabel(finest)}–${hoursLabel(coarsest)}`;
}

/** Span label: days covered plus the resolution(s), e.g. "7d 12h" or "10d 6h–12h". */
function spanLabel(msg: ForecastMessage): string {
  return `${msg.days}d ${resolutionLabel(msg)}`;
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

function metaLabel(msg: ForecastMessage, units: UnitPrefs): string {
  const models = modelLabelsFromMask(msg.models_mask);
  const elev = elevationLabel(msg, units);
  const elevStr = elev ? ` · ${elev}` : '';
  return `${latLonLabel(msg)}${elevStr} · ${spanLabel(msg)} · ${models.join(' + ')}`;
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

/**
 * Cached-forecast label (request time · models · priority · location). `detailed`
 * is for the loaded forecast's own meta row, which has the width for the request
 * date and the forecast point's elevation; the past-forecast list stays compact.
 */
function cacheMetaLabel(slot: Slot, token: string, units: UnitPrefs, detailed = false): string {
  try {
    const msg = decodeAny(slot.encoded!, token);
    const models = modelIconsFromMask(msg.models_mask).join(' ');
    const requested = detailed
      ? requestDateTimeLabel(slot.requestedAt)
      : requestTimeLabel(slot.requestedAt);
    const elev = detailed ? elevationLabel(msg, units) : '';
    const elevStr = elev ? ` · ${elev}` : '';
    return `${requested} · ${models} · ${priorityLabel(msg)} · ${latLonLabel(msg)}${elevStr}`;
  } catch {
    return 'Unknown';
  }
}

const OPTIONAL_VARIABLE_ICONS = [
  { vars: ['cch', 'ccm', 'ccl'], symbol: '☁️', label: 'Detailed clouds' },
  { vars: WIND_LEVELS_HPA.map((l) => `w${l}`), symbol: '💨', label: 'Pressure-level winds' },
  { vars: ['freeze'], symbol: '🌡️', label: 'Freezing level' },
  // One icon for the whole air-quality block: which index a request picked is the meteogram's
  // business, and five near-identical chips on a cache row would say less than one.
  { vars: ['aqi', 'aq_pm25', 'aq_o3', 'aq_pm10', 'aq_no2', 'aq_so2',
           'aqi_eu', 'aqi_eu_pm25', 'aqi_eu_o3', 'aqi_eu_pm10', 'aqi_eu_no2', 'aqi_eu_so2'],
    symbol: '🌫️', label: 'Air quality' },
];

function variableIconsForMask(mask: number) {
  return OPTIONAL_VARIABLE_ICONS.filter(({ vars }) =>
    vars.some((variable) => mask & (1 << VARS_BIT[variable])),
  );
}

function cacheVariableIcons(slot: Slot, token: string) {
  try { return variableIconsForMask(decodeAny(slot.encoded!, token).vars_mask); }
  catch { return []; }
}

interface PastForecastGroup {
  day: number;
  slots: Slot[];
}

/** Group forecasts by their local start day while preserving newest-first order. */
function groupPastForecasts(slots: Slot[], token: string): PastForecastGroup[] {
  const groups: PastForecastGroup[] = [];
  for (const slot of slots) {
    let start = new Date(slot.savedAt ?? slot.requestedAt);
    try { start = startDatetime(decodeAny(slot.encoded!, token)); } catch { /* use saved/request time */ }
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
function CollectingBox({ total, have }: Collecting) {
  const boxes = total > 0
    ? Array.from({ length: total }, (_, i) => have.includes(i + 1))
    : [...have.map(() => true), false];
  const boxLabel = (index: number, received: boolean): string => {
    if (total > 0) return `Message ${index} of ${total} ${received ? 'received' : 'missing'}`;
    return received ? `Message ${index} received` : 'Next message not yet pasted';
  };
  return (
    <View style={styles.collectArea}>
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
  const [locationMode, setLocationMode] = useState<LocationMode>('current');
  const [gpsCoords, setGpsCoords] = useState<{ lat: number; lon: number } | null>(null);
  // When the fix in gpsCoords was taken (ms epoch, 0 = never). The OS's own timestamp, not ours:
  // getCurrentPositionAsync may hand back a cached fix, and its age is the fix's, not the call's.
  const gpsFixedAt = useRef(0);
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
  // When true, the next decode came from loading a cached entry — don't re-attach it.
  const suppressNextCache = useRef(false);

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
  const metaY = useRef<number | null>(null);
  const pendingScroll = useRef(false);
  // The forecast map's frame in the scroll content, measured on layout, and where the forecast
  // display ends (the attribution line's top — the meteogram's immediate follower). Together
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
  // rows and the attribution, so it stretches forecastEnd without moving Meteogram's own clamp
  // end — left in, the map would stay parked over the panel for that extra stretch of scroll
  // after the strip and plate had ridden off, leaving a map slice under the status bar.
  const [detailH, setDetailH] = useState(0);
  const mapPark = useMemo(() => {
    if (mapFrame == null || forecastEnd == null) return null;
    const parkY = mapFrame.y + mapFrame.h - topInset;
    // How far the park carries: the forecast's height below the map, less the docked stack that
    // rides off beneath it. forecastEnd (the attribution's top) minus the detail panel and the
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
  const variableCodes = activeGroups.flatMap((g) => (g.code != null ? [g.code] : []));
  const windLevels = activeGroups.flatMap((g) => (g.windLevel != null ? [g.windLevel] : []));
  const varsMask = configurableVars.reduce(
    (mask, v) => mask | (1 << (VARS_BIT[v] ?? -1)),
    ALWAYS_VARS_MASK,
  );
  const modeName = PRIORITIES.find((m) => m.value === mode)!.label;

  // Whether the multi-message switch is on offer at all, and so how many messages the reply may
  // use. The route decides whether a second message is possible, the selection whether it is
  // worth asking about (multiMessageOffered states the rule per route); a switch left on from an
  // earlier selection counts only while it is showing, so narrowing the variables back down
  // returns to one message without the reader having to find and turn it off.
  const multiMessageShown = multiMessageOffered(deviceCode(device), variableCodes, windLevels);
  const messages = multiMessageShown && twoMessages ? 2 : DEFAULT_MESSAGES;

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
      gpsFixedAt.current = pos.timestamp;
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

  // Fill in the current location when the app opens, so the model subtext has coordinates to
  // attribute before the user touches anything. Only when access has already been granted: an
  // unprompted permission dialog on open asks for something the user hasn't tried to do yet, and
  // the send buttons still raise the prompt at the moment it's actually needed. The attempt is
  // silent and doesn't set `locating` either — nothing waits on it, so a background convenience
  // shouldn't spin the buttons or raise an alert about a fix nobody asked for.
  useEffect(() => {
    (async () => {
      const { granted } = await Location.getForegroundPermissionsAsync();
      if (granted) await fetchPosition();
    })();
  }, []);

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
    // A stale fix takes the same on-demand path as a missing one: a send is the moment the
    // location has to be right, and refreshing through requestCurrentLocation means a failed
    // re-fix aborts with the same alert instead of quietly sending where the phone used to be.
    if (locationMode === 'current'
      && (!coordsValid || Date.now() - gpsFixedAt.current > GPS_FIX_MAX_AGE_MS)) {
      coords = await requestCurrentLocation();
    }
    if (coords == null || !isFinite(coords.lat) || !isFinite(coords.lon)) return null;
    const startHour = alignedStartEpochHour();
    const code = await allocCode(token, buildContext(coords, mode, model, varsMask, startHour, device), `${modeName} · ${model.toUpperCase()}`);
    return buildMsg(token, coords, mode, model, variableCodes, windLevels, device, messages, code, startHour);
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
    (async () => {
      try {
        // The store maps the message code → request context; load it before the (sync) decode.
        await loadStore(token);
        if (cancelled) return;
        const msg = decodeAny(forecastData, token);
        setDecoded(msg);
        setError(null);
        setCollecting(null);
        // A decode of new text is the moment the forecast should come on screen, whichever way
        // the text arrived — a fetch reply, a completed paste, a cached entry loaded back.
        pendingScroll.current = true;
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
      if (!text.trim()) return;
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
  // a tap away in Past forecasts — but a half-collected reply is, which is the point: it is the
  // way out of a collection that can never decode, and without it a reader who pasted the wrong
  // message would be stuck in one, with no text field to edit.
  const clearForecast = useCallback(() => {
    if (outcomeTimer.current) clearTimeout(outcomeTimer.current);
    setOutcome(null);
    onForecastDataChange('');
  }, [onForecastDataChange]);

  const loadPast = useCallback((encoded: string) => {
    suppressNextCache.current = true;
    onForecastDataChange(encoded);
  }, [onForecastDataChange]);

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

  const pastGroups = groupPastForecasts(cache, token);
  const loadedSlot = cache.find((slot) =>
    normalizedForecastData(slot.encoded!) === normalizedForecastData(forecastData),
  );

  const pastSection = (
    <View style={styles.pastSection}>
      <View style={styles.sectionEnd} />
      <StepHeader title="Past forecasts" gap />
      {cache.length === 0 ? (
        <Text style={styles.pastEmpty}>No past forecasts.</Text>
      ) : (
        pastGroups.map((group) => (
          <View key={group.day} style={styles.pastGroup}>
            <Text style={styles.pastDayText}>{dayLabel(group.day)}</Text>
            {group.slots.map((slot) => {
              const isLoaded = normalizedForecastData(forecastData)
                === normalizedForecastData(slot.encoded!);
              const variableIcons = cacheVariableIcons(slot, token);
              return (
                <View
                  key={slot.code}
                  style={[styles.pastItem, isLoaded && styles.pastItemLoaded]}
                >
                  <View style={styles.pastDetails}>
                    <Text style={styles.pastMeta} numberOfLines={2}>{cacheMetaLabel(slot, token, units)}</Text>
                    {variableIcons.length > 0 && (
                      <View style={styles.variableRow}>
                        <Text style={styles.variableLabel}>Variables:</Text>
                        {variableIcons.map((icon) => (
                          <Text
                            key={icon.label}
                            style={styles.pastIcon}
                            accessibilityLabel={icon.label}
                          >
                            {icon.symbol}
                          </Text>
                        ))}
                      </View>
                    )}
                  </View>
                  <View style={styles.pastBtns}>
                    <TouchableOpacity
                      style={[styles.pastLoadBtn, isLoaded && styles.pastLoadBtnDisabled]}
                      onPress={() => loadPast(slot.encoded!)}
                      disabled={isLoaded}
                    >
                      <Text style={styles.pastLoadText}>Load</Text>
                    </TouchableOpacity>
                  </View>
                </View>
              );
            })}
          </View>
        ))
      )}
    </View>
  );

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
          <MaterialCommunityIcons name="cog-outline" size={24} color="#6e6e73" />
        </TouchableOpacity>
      </View>
      <View style={styles.titleRule} />

      {/* The builder carries the scroll content's side padding itself: the forecast pieces below
          it run full-bleed, and the meteogram's pinned headers measure their offset against the
          scroll content, which they can only do as its direct children. */}
      <View style={styles.builderPad}>
        <StepHeader title="Build a forecast request" />
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
                  {/* Pasted coordinates are long and the keyboard's delete key clears them one
                      character at a time; one tap on the ✕ empties the field. Only drawn when
                      there is something to clear, so an empty field shows no control. */}
                  {customCoords.length > 0 && (
                    <TouchableOpacity
                      style={styles.coordClear}
                      onPress={() => setCustomCoords('')}
                      hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}
                      accessibilityRole="button"
                      accessibilityLabel="Clear coordinates"
                    >
                      <MaterialCommunityIcons name="close-circle" size={18} color="#8e8e93" />
                    </TouchableOpacity>
                  )}
                </View>
              </View>
              <Text style={styles.mapHint}>Tap the map to set a location</Text>
              {/* Edge to edge: the negative inset cancels the builder's horizontal padding,
                  so the map spans the screen rather than sitting inside the section's column. */}
              <View style={styles.mapFullBleed}>
                <LocationMap
                  coord={coordsValid ? resolvedCoords : null}
                  onPick={(c) => setCustomCoords(`${c.lat.toFixed(5)}, ${c.lon.toFixed(5)}`)}
                />
              </View>
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
                  <Text style={[styles.varLabel, disabled && styles.varLabelDim]}>{groupLabel(row.group, units)}</Text>
                  <Text style={[styles.varCheck, !checked && styles.varCheckHidden]}>✓</Text>
                </TouchableOpacity>
              );
            })}
          </View>
        </Section>

        <View style={styles.sectionEnd} />

        <StepHeader title="Send the request" gap />

        {/* The way out. Which device you carry decides how the request travels, so it sits with
            the button it drives rather than up with the forecast's own options. */}
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
          {/* A switch rather than an On/Off segment: this is one setting being turned on, not a
              choice between two things, and it is read far more often than it is changed. */}
          {multiMessageShown && (
            <View style={styles.switchRow}>
              <View style={styles.switchText}>
                <Text style={styles.switchLabel}>Multi-message forecast</Text>
                <Text style={styles.switchHint}>Use multiple messages for more range and detail</Text>
              </View>
              <Switch
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

        <View style={styles.sectionEnd} />

        <StepHeader title="View the forecast" gap />

        {/* The way back in: pull the encoded reply straight off the clipboard. It opens the view
            step because that is the flow — the reply this loads is to the request the send step
            just put on its way. The button also carries the last press's outcome for a moment — a
            green check for what it loaded, a red ✕ when the paste wouldn't decode — then goes back
            to offering the paste. Clear sits beside it rather than appearing with a state, because
            the state it is most needed in — a collection that will never decode — is the one where
            a reader has least reason to expect it. */}
        <View>
          <View style={styles.pasteRow}>
            <TouchableOpacity
              style={[
                styles.pasteBtn,
                outcome && (outcome.failed ? styles.pasteBtnFailed : styles.pasteBtnDone),
              ]}
              onPress={pasteFromClipboard}
              accessibilityRole="button"
              accessibilityLabel={outcome?.label ?? 'Paste Forecast'}
            >
              {outcome && (
                <MaterialCommunityIcons
                  name={outcome.failed ? 'close' : 'check'}
                  size={19}
                  color={outcome.failed ? '#c03030' : '#2a8f5a'}
                  style={styles.pasteBtnIcon}
                />
              )}
              <Text
                style={[
                  styles.pasteBtnText,
                  outcome && (outcome.failed ? styles.pasteBtnTextFailed : styles.pasteBtnTextDone),
                ]}
                numberOfLines={1}
              >
                {outcome?.label ?? 'Paste Forecast'}
              </Text>
            </TouchableOpacity>
            <TouchableOpacity
              style={styles.clearBtn}
              onPress={clearForecast}
              accessibilityRole="button"
              accessibilityLabel="Clear forecast"
            >
              <MaterialCommunityIcons name="close" size={22} color="#636366" />
            </TouchableOpacity>
          </View>
          {/* Both sit under the button, where what they ask for is another press of it. Only one can
              be showing: a paste is either short of its remaining messages or wrong, never both. */}
          {collecting && <CollectingBox {...collecting} />}
          {error && (
            <View style={styles.errorBox}>
              <Text style={styles.errorText}>{error}</Text>
            </View>
          )}
        </View>

      </View>

      {decoded && (
        <>
          {/* Meta. Its layout position is the scroll target that brings a fresh decode on screen. */}
          <View
            style={styles.metaRow}
            onLayout={(e) => { metaY.current = e.nativeEvent.layout.y; scrollToForecast(); }}
          >
            <Text style={styles.metaText} numberOfLines={3}>
              {loadedSlot ? cacheMetaLabel(loadedSlot, token, units, true) : metaLabel(decoded, units)}
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
              key={`${decoded.lat},${decoded.lon}`}
              coord={{ lat: decoded.lat, lon: decoded.lon }}
              height={200}
            />
          </Animated.View>

          {/* Forecast meteogram. Nothing hides this screen any more, so it is always active — the
              prop still exists for the repaint-after-hide machinery it drives inside. */}
          <Meteogram msg={decoded} units={units} timeFormat={timeFormat} active scrollY={scrollY} onDetailHeight={setDetailH} />

          {/* Open-Meteo's data is CC BY 4.0, which asks for credit where the data is shown —
              the Settings footer alone doesn't satisfy that. Same wording as there. */}
          <Text
            style={styles.attribution}
            onLayout={(e) => {
              const { y } = e.nativeEvent.layout;
              setForecastEnd((prev) => (prev === y ? prev : y));
            }}
          >
            Weather data provided by{' '}
            <Text style={styles.attributionLink} onPress={() => Linking.openURL('https://open-meteo.com/')}>
              Open-Meteo
            </Text>.
          </Text>
        </>
      )}

      {pastSection}

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

// The flow's milestone headings — the same steps the getting-started sheet teaches, drawn on
// the page itself so it reads as the loop it is, with the archive at the end. A dotted leader
// runs from the end of the text to the row's edge at baseline height — the underline picks up
// where the words stop — paired with the solid rule that closes each section's bottom. The
// leader is an all-side dotted border clipped to its top edge: iOS draws borderStyle only when
// the border is uniform, so a bare borderBottom would come out solid.
function StepHeader({ title, gap }: { title: string; gap?: boolean }) {
  return (
    <View style={[styles.stepHeader, gap && styles.stepHeaderGap]}>
      <Text style={styles.stepTitle}>{title}</Text>
      <View style={styles.stepRule}>
        <View style={styles.stepRuleDots} />
      </View>
    </View>
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

// ── Styles ─────────────────────────────────────────────────────────────────

// The builder's horizontal inset. Named so the map can cancel it and run edge to edge.
const CONTENT_PAD = 16;

const styles = StyleSheet.create({
  scroll: { flex: 1, backgroundColor: '#f2f2f7' },
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
  titleRule: { height: StyleSheet.hairlineWidth, backgroundColor: '#d1d1d6' },
  // Rounded like the home-screen icon it is, at the setup screen's proportions, sized to the
  // wordmark's cap height plus a little.
  titleIcon: { width: 26, height: 26, borderRadius: 6 },
  // The splash wordmark's blue (see SetupScreen's brand), small.
  titleText: { fontSize: 20, fontWeight: '700', color: '#2a6bb5' },
  builderPad: { padding: CONTENT_PAD },

  // Sheet frame, matching HelpScreen's. The safe area carries the status bar inset now that this
  // runs the full height, so the header only needs the same 12pt the app header uses.
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

  // A milestone heading with a dotted leader to the row's edge. `stepHeaderGap` separates it
  // from the divider that closes the section above; the first one needs none.
  stepHeader: { flexDirection: 'row', alignItems: 'flex-end', marginBottom: 14 },
  stepHeaderGap: { marginTop: 20 },
  stepTitle: { fontSize: 18, fontWeight: '600', color: '#6e6e73' },
  // The leader: a 2px window over a uniformly dotted border, taking the row's spare width and
  // riding 4px above the text's bottom edge — baseline height for an 18pt face.
  stepRule: { flex: 1, height: 2, overflow: 'hidden', marginBottom: 4, marginLeft: 6 },
  stepRuleDots: { height: 4, borderWidth: 2, borderColor: '#d1d1d6', borderStyle: 'dotted' },
  // The rule that closes a section's bottom, bleeding past the page padding to the screen edge.
  sectionEnd: {
    height: StyleSheet.hairlineWidth, backgroundColor: '#d1d1d6',
    marginTop: 24, marginHorizontal: -CONTENT_PAD,
  },

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
  // The row aligns on the text baseline, which an icon doesn't have; centre it on the row instead.
  coordClear: { alignSelf: 'center', marginLeft: 8 },
  mapHint: { fontSize: 12, color: '#8e8e93', marginTop: 10 },
  mapFullBleed: { marginTop: 10, marginHorizontal: -CONTENT_PAD },
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
  // A settings row: label left, switch right, the switch's own height setting the row's.
  switchRow: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    gap: 12, marginTop: 16,
  },
  switchText: { flexShrink: 1 },
  switchLabel: { fontSize: 15, color: '#1c1c1e' },
  switchHint: { fontSize: 12, color: '#8e8e93', lineHeight: 17, marginTop: 2 },

  helpLink: { alignSelf: 'center', marginTop: 8, paddingVertical: 6, paddingHorizontal: 12 },
  helpLinkText: { color: '#2a6bb5', fontSize: 14, fontWeight: '600' },

  pasteRow: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  // Same fills as the Copy inReach Message button (ActionButton above), so a confirmed press
  // looks the same in both places. It takes the row's spare width, leaving Clear square —
  // which is what keeps the outcome labels short enough not to truncate at one line.
  pasteBtn: {
    flex: 1,
    flexDirection: 'row',
    height: 50,
    borderRadius: 14,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: '#2a6bb5',
  },
  // Quiet beside the paste button: it is always available but rarely the thing to press.
  clearBtn: {
    width: 50,
    height: 50,
    borderRadius: 14,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: '#f2f2f7',
    borderWidth: 1,
    borderColor: '#d1d1d6',
  },
  pasteBtnDone: { backgroundColor: '#e8f5ec', borderWidth: 1, borderColor: '#2a8f5a' },
  // The error box's own colours, so the button and the reason under it read as one thing.
  pasteBtnFailed: { backgroundColor: '#fde8e8', borderWidth: 1, borderColor: '#c03030' },
  pasteBtnIcon: { marginRight: 8 },
  pasteBtnText: { color: '#fff', fontSize: 16, fontWeight: '600' },
  pasteBtnTextDone: { color: '#2a8f5a' },
  pasteBtnTextFailed: { color: '#c03030' },

  errorBox: { marginTop: 10, padding: 12, backgroundColor: '#fde8e8', borderRadius: 10 },
  errorText: { color: '#c03030', fontSize: 14, lineHeight: 20 },

  collectArea: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    paddingTop: 10, gap: 10,
  },
  segmentRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 6 },
  segment: {
    width: 24, height: 24,
    alignItems: 'center', justifyContent: 'center',
    borderWidth: 1, borderRadius: 6,
  },
  segmentReceived: { backgroundColor: '#e8f6ec', borderColor: '#34a853' },
  segmentMissing: { backgroundColor: '#f2f2f7', borderColor: '#d1d1d6', borderStyle: 'dashed' },
  segmentCheck: { fontSize: 13, lineHeight: 16, color: '#2e8b48', fontWeight: '700' },
  collectCaption: { flexShrink: 1, fontSize: 12, color: '#636366', textAlign: 'right' },

  // The parked map must draw over what scrolls up beneath it once it stops.
  mapFloat: { zIndex: 1 },

  // Forecast meta and the past-forecast list, full-bleed siblings of the meteogram — they carry
  // their own margins.
  metaRow: {
    margin: 16,
    marginBottom: 8,
    gap: 10,
  },
  metaText: { flexShrink: 1, fontSize: 13, color: '#3a3a3c', lineHeight: 18 },
  variableRow: { flexDirection: 'row', alignItems: 'center', gap: 5 },
  variableLabel: { fontSize: 12, color: '#636366' },

  attribution: { fontSize: 12, color: '#8e8e93', marginTop: 8, marginHorizontal: 16 },
  attributionLink: { color: '#2a6bb5', textDecorationLine: 'underline' },

  pastSection: { marginTop: 8, marginHorizontal: 16 },
  pastEmpty: { fontSize: 13, color: '#aeaeb2', fontFamily: 'Courier', paddingVertical: 12 },
  pastGroup: { marginBottom: 8 },
  pastDayText: { fontSize: 13, fontWeight: '600', color: '#636366', paddingTop: 4, paddingBottom: 6 },
  pastItem: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    paddingVertical: 10, paddingHorizontal: 8, gap: 12,
    borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: '#e5e5ea',
  },
  pastItemLoaded: { backgroundColor: '#e8f1fb', borderRadius: 8, borderTopColor: '#c7dff5' },
  pastDetails: { flex: 1, gap: 3 },
  pastMeta: { flexShrink: 1, fontSize: 13, color: '#3a3a3c', lineHeight: 18 },
  pastIcon: { fontSize: 15, lineHeight: 19 },
  pastBtns: { flexDirection: 'row', gap: 8 },
  pastLoadBtn: { paddingHorizontal: 14, paddingVertical: 6, borderRadius: 8, backgroundColor: '#2a6bb5' },
  pastLoadBtnDisabled: { backgroundColor: '#aeaeb2' },
  pastLoadText: { color: '#fff', fontSize: 13, fontWeight: '600' },
});
