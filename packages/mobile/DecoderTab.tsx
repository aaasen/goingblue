import { useState, useEffect, useRef, useCallback } from 'react';
import {
  StyleSheet, Text, View, TextInput, TouchableOpacity, ScrollView,
} from 'react-native';
import * as Clipboard from 'expo-clipboard';
import {
  VARS_BIT, startDatetime, MODE_NAMES, DEFAULT_MODE, type ForecastMessage,
} from '@weather/protocol';
import { decodeAny, loadStore, attachResponse, prunePastForecasts, type Slot } from './cache';
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

function normalizedForecastData(encoded: string): string {
  return encoded.replace(/\s/g, '').replace(/^fw:/i, '');
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
  { vars: ['w500', 'w600', 'w700'], symbol: '💨', label: 'High altitude winds' },
  { vars: ['freeze'], symbol: '🌡️', label: 'Freezing level' },
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

// ── DecoderTab ─────────────────────────────────────────────────────────────

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
  const [cache, setCache] = useState<Slot[]>([]);
  // When true, the next decode came from loading a cached entry — don't re-attach it.
  const suppressNextCache = useRef(false);

  useEffect(() => {
    prunePastForecasts(token).then(setCache);
  }, [token]);

  useEffect(() => {
    let cancelled = false;
    if (!forecastData.trim()) {
      setDecoded(null);
      setError(null);
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
        if (suppressNextCache.current) {
          suppressNextCache.current = false;
        } else {
          attachResponse(token, msg.code, forecastData).then((slots) => { if (!cancelled) setCache(slots); });
        }
      } catch (e) {
        suppressNextCache.current = false;
        setDecoded(null);
        const msg = String(e);
        if (msg.includes('Unsupported protocol version')) {
          // An old saved forecast from before an app update: past forecasts are a short-lived
          // convenience buffer, and support for decoding retired protocol versions is dropped
          // deliberately (VERSIONING.md), so this is expiry, not an error.
          setError('This forecast was saved by an older version of the app and can no longer be displayed. Request a new forecast.');
        } else if (msg.includes('Version mismatch')) {
          const match = msg.match(/encoded v(\d+)/);
          const encoded = match ? match[1] : '?';
          setError(`Version mismatch: this message uses protocol v${encoded}, which this app can't decode. Update the app or request a new forecast.`);
        } else if (msg.includes('Unknown forecast code')) {
          setError("This forecast doesn't match a request from this device — it may have been sent elsewhere or cycled out of history. Request a new forecast.");
        } else {
          setError('Could not decode forecast — paste the encoded reply from your inReach.');
        }
      }
    })();
    return () => { cancelled = true; };
  }, [forecastData, token]);

  const pasteFromClipboard = useCallback(async () => {
    try {
      const text = await Clipboard.getStringAsync();
      if (text.trim()) onForecastDataChange(text.trim());
    } catch {
      setError('Could not read the clipboard.');
    }
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
      {/* Primary action: pull the encoded reply straight off the clipboard. */}
      <View style={styles.actionArea}>
        <TouchableOpacity style={styles.pasteBtn} onPress={pasteFromClipboard} accessibilityRole="button">
          <Text style={styles.pasteBtnText}>Paste Forecast</Text>
        </TouchableOpacity>
      </View>

      {/* Input area (scrolls away with the rest of the page rather than staying pinned).
          Single-line: the encoded message is one long token, so it scrolls sideways rather
          than wrapping into a growing block. */}
      <View style={styles.inputArea}>
        <View style={styles.inputField}>
          <TextInput
            style={styles.input}
            value={forecastData}
            onChangeText={onForecastDataChange}
            placeholder="Paste forecast here"
            placeholderTextColor="#aeaeb2"
            autoCapitalize="none"
            autoCorrect={false}
            spellCheck={false}
            numberOfLines={1}
          />
          {forecastData.length > 0 && (
            <TouchableOpacity
              style={styles.clearBtn}
              onPress={() => onForecastDataChange('')}
              hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
            >
              <Text style={styles.clearBtnText}>✕</Text>
            </TouchableOpacity>
          )}
        </View>
      </View>

      {error && (
        <View style={styles.errorBox}>
          <Text style={styles.errorText}>{error}</Text>
        </View>
      )}

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
              Only mounted while this tab is visible: a react-native-maps surface left mounted under a
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
        </>
      )}

      {!decoded && !error && (
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
  inputArea: {
    backgroundColor: '#fff',
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: '#d1d1d6',
    paddingHorizontal: 16,
    paddingTop: 4,
    paddingBottom: 14,
  },
  inputField: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: '#f2f2f7',
    borderWidth: 1,
    borderColor: '#d1d1d6',
    borderRadius: 10,
    paddingHorizontal: 12,
    height: 44,
  },
  input: {
    flex: 1,
    fontFamily: 'Courier',
    fontSize: 14,
    color: '#1c1c1e',
    padding: 0,
  },
  actionArea: {
    backgroundColor: '#fff',
    paddingHorizontal: 16,
    paddingTop: 14,
    paddingBottom: 10,
  },
  pasteBtn: {
    height: 50,
    borderRadius: 14,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: '#2a6bb5',
  },
  pasteBtnText: { color: '#fff', fontSize: 16, fontWeight: '600' },
  clearBtn: {
    marginLeft: 8,
    width: 20,
    height: 20,
    borderRadius: 10,
    backgroundColor: '#aeaeb2',
    alignItems: 'center',
    justifyContent: 'center',
  },
  clearBtnText: { color: '#fff', fontSize: 11, fontWeight: '700', lineHeight: 13 },

  errorBox: { margin: 16, padding: 12, backgroundColor: '#fde8e8', borderRadius: 10 },
  errorText: { color: '#c03030', fontSize: 14, lineHeight: 20 },

  metaRow: {
    margin: 16,
    marginBottom: 8,
    gap: 10,
  },
  metaText: { flexShrink: 1, fontSize: 13, color: '#3a3a3c', lineHeight: 18 },
  variableRow: { flexDirection: 'row', alignItems: 'center', gap: 5 },
  variableLabel: { fontSize: 12, color: '#636366' },

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
