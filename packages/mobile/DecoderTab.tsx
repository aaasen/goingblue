import { useState, useEffect, useRef, useCallback } from 'react';
import {
  StyleSheet, Text, View, TouchableOpacity, ScrollView, Linking,
} from 'react-native';
import * as Clipboard from 'expo-clipboard';
import MaterialCommunityIcons from '@expo/vector-icons/MaterialCommunityIcons';
import {
  VARS_BIT, WIND_LEVELS_HPA, startDatetime, MODE_NAMES, DEFAULT_MODE, type ForecastMessage,
} from '@weather/protocol';
import {
  chunksCollected, decodeAny, loadStore, attachResponse, mergeReply, normalizeReply,
  prunePastForecasts, replyParts, type Slot,
} from './cache';
import type { TimeFormat, Units } from './settings';
import LocationMap from './LocationMap';
import Meteogram from './Meteogram';
import { modelLabelsFromMask, modelIconsFromMask } from './models';

// ── Meta labels ────────────────────────────────────────────────────────────

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
// labelled the same way as the Builder tab's priority selector.
function priorityLabel(msg: ForecastMessage): string {
  return MODE_NAMES[msg.mode] ?? MODE_NAMES[DEFAULT_MODE];
}

/**
 * The forecast point's elevation, in the user's units. Empty at sea level, which
 * is also what the wire format reports when it has no elevation to carry.
 */
function elevationLabel(msg: ForecastMessage, units: Units): string {
  if (msg.elevation <= 0) return '';
  return units === 'imperial'
    ? `${Math.round(msg.elevation * 3.28084).toLocaleString()}ft`
    : `${Math.round(msg.elevation).toLocaleString()}m`;
}

function metaLabel(msg: ForecastMessage, units: Units): string {
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
function cacheMetaLabel(slot: Slot, token: string, units: Units, detailed = false): string {
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

// ── DecoderTab ─────────────────────────────────────────────────────────────

// What the paste button says after a press, and whether it says it in green or red. The same
// dwell as the builder's Copy inReach Message confirmation.
interface Outcome {
  label: string;
  failed: boolean;
}
const OUTCOME_MS = 2000;
const FAILED_LABEL = 'Error loading forecast';

interface Props {
  token: string;
  forecastData: string;
  onForecastDataChange: (v: string) => void;
  units: Units;
  timeFormat: TimeFormat;
  active: boolean;
}

export default function DecoderTab({ token, forecastData, onForecastDataChange, units, timeFormat, active }: Props) {
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
      return;
    }
    (async () => {
      // The store maps the message code → request context; load it before the (sync) decode.
      await loadStore(token);
      if (cancelled) return;
      try {
        const msg = decodeAny(forecastData, token);
        setDecoded(msg);
        setError(null);
        setCollecting(null);
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
          // text field this tab no longer has — a paste like that is just an invalid forecast.
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
      }
    })();
    return () => { cancelled = true; };
  }, [forecastData, token, flash]);

  // A reply that arrived as two messages is pasted as two messages, so a paste folds into what
  // is already here when — and only when — it is another part of the same reply (see mergeReply).
  //
  // The button then reports what the press actually did, the way the builder's Copy inReach Message button
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
  // message would be stuck in one, on a tab with no text field to edit.
  const clearForecast = useCallback(() => {
    if (outcomeTimer.current) clearTimeout(outcomeTimer.current);
    setOutcome(null);
    onForecastDataChange('');
  }, [onForecastDataChange]);

  const loadPast = useCallback((encoded: string) => {
    suppressNextCache.current = true;
    onForecastDataChange(encoded);
  }, [onForecastDataChange]);

  const pastGroups = groupPastForecasts(cache, token);
  const loadedSlot = cache.find((slot) =>
    normalizedForecastData(slot.encoded!) === normalizedForecastData(forecastData),
  );
  const decodedVariableIcons = decoded ? variableIconsForMask(decoded.vars_mask) : [];

  const pastSection = (
    <View style={styles.pastSection}>
      <Text style={styles.pastHeaderText}>Past forecasts</Text>
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
    <ScrollView
      style={{ flex: 1, backgroundColor: '#f2f2f7' }}
      contentContainerStyle={{ paddingBottom: 72 }}
      keyboardShouldPersistTaps="handled"
    >
      {/* Primary action: pull the encoded reply straight off the clipboard. The button also carries
          the last press's outcome for a moment — a green check for what it loaded, a red ✕ when
          the paste wouldn't decode — then goes back to offering the paste. Clear sits beside it
          rather than appearing with a state, because the state it is most needed in — a collection
          that will never decode — is the one where a reader has least reason to expect it. */}
      <View style={styles.actionArea}>
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

      {decoded && (
        <>
          {/* Meta */}
          <View style={styles.metaRow}>
            <Text style={styles.metaText} numberOfLines={3}>
              {loadedSlot ? cacheMetaLabel(loadedSlot, token, units, true) : metaLabel(decoded, units)}
            </Text>
            {decodedVariableIcons.length > 0 && (
              <View style={styles.variableRow}>
                <Text style={styles.variableLabel}>Variables:</Text>
                {decodedVariableIcons.map((icon) => (
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

          {/* Forecast location. Keyed on the coordinate so loading a new forecast recenters the map.
              Only mounted while this tab is visible: a native map surface left mounted under a
              `display: none` tab makes the builder tab's map drop its marker, so we unmount it here. */}
          <View>
            {active && (
              <LocationMap
                key={`${decoded.lat},${decoded.lon}`}
                coord={{ lat: decoded.lat, lon: decoded.lon }}
                height={160}
                flush
              />
            )}
          </View>

          {/* Forecast meteogram */}
          {/* `active` is not for hiding anything — the meteogram's canvases lose their drawables
              while this tab is hidden, so they need to know when to come back. */}
          <Meteogram msg={decoded} units={units} timeFormat={timeFormat} active={active} />

          {/* Open-Meteo's data is CC BY 4.0, which asks for credit where the data is shown —
              the Settings footer alone doesn't satisfy that. Same wording as there. */}
          <Text style={styles.attribution}>
            Weather data provided by{' '}
            <Text style={styles.attributionLink} onPress={() => Linking.openURL('https://open-meteo.com/')}>
              Open-Meteo
            </Text>.
          </Text>
        </>
      )}

      {!decoded && !error && !collecting && (
        <View style={styles.emptyState}>
          <Text style={styles.emptyTitle}>No forecast loaded</Text>
        </View>
      )}

      {pastSection}
    </ScrollView>
  );
}

// ── Styles ─────────────────────────────────────────────────────────────────

const styles = StyleSheet.create({
  actionArea: {
    backgroundColor: '#fff',
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: '#d1d1d6',
    paddingHorizontal: 16,
    paddingTop: 14,
    paddingBottom: 14,
  },
  pasteRow: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  // Same fills as the builder's Copy inReach Message button (BuilderTab's ActionButton), so a confirmed
  // press looks the same on both tabs. It takes the row's spare width, leaving Clear square —
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

  emptyState: { alignItems: 'center', justifyContent: 'center', padding: 40 },
  emptyTitle: { fontSize: 18, fontWeight: '600', color: '#3a3a3c', textAlign: 'center' },

  pastSection: { marginTop: 8, marginHorizontal: 16 },
  pastHeaderText: { fontSize: 12, fontWeight: '700', color: '#8e8e93', textTransform: 'uppercase', letterSpacing: 0.5, paddingVertical: 12 },
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
