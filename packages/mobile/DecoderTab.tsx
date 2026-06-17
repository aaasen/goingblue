import { useState, useEffect, useRef, useCallback } from 'react';
import {
  StyleSheet, Text, View, TextInput, TouchableOpacity, ScrollView,
} from 'react-native';
import {
  RESOLUTION_HOURS, modelsFromMask, startDatetime, type ForecastMessage,
} from '@weather/protocol';
import { decodeAny, loadCache, addToCache, deleteFromCache, type CacheEntry } from './cache';
import type { Units } from './settings';
import LocationMap from './LocationMap';
import Meteogram from './Meteogram';

// ── Meta labels ────────────────────────────────────────────────────────────

function latLonLabel(msg: ForecastMessage): string {
  const latStr = `${Math.abs(msg.lat).toFixed(2)}°${msg.lat >= 0 ? 'N' : 'S'}`;
  const lonStr = `${Math.abs(msg.lon).toFixed(2)}°${msg.lon >= 0 ? 'E' : 'W'}`;
  return `${latStr} ${lonStr}`;
}

/** Span label from the actual period count: "7d daily" for daily, "46×1h" for sub-daily. */
function spanLabel(msg: ForecastMessage): string {
  const resHours = RESOLUTION_HOURS[msg.resolution] ?? 24;
  const n = msg.periods[0]?.length ?? 0;
  return resHours >= 24 ? `${n}d daily` : `${n}×${resHours}h`;
}

function metaLabel(msg: ForecastMessage, units: Units): string {
  const models = modelsFromMask(msg.models_mask);
  const elevStr = msg.elevation > 0
    ? units === 'imperial'
      ? ` · ${Math.round(msg.elevation * 3.28084).toLocaleString()}ft`
      : ` · ${Math.round(msg.elevation).toLocaleString()}m`
    : '';
  return `${latLonLabel(msg)}${elevStr} · ${spanLabel(msg)} · ${models.join(' + ')}`;
}

const DAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

/** Compact label for a cached forecast (location · start · NNd res · models). */
function cacheMetaLabel(encoded: string): string {
  try {
    const msg = decodeAny(encoded);
    const models = modelsFromMask(msg.models_mask).join(' + ');
    const resHours = RESOLUTION_HOURS[msg.resolution] ?? 24;
    const start = startDatetime(msg);
    const startStr = resHours >= 24
      ? `${DAY_NAMES[start.getDay()]} ${start.getMonth() + 1}/${start.getDate()}`
      : `${DAY_NAMES[start.getDay()]} ${start.getMonth() + 1}/${start.getDate()} ${start.getHours()}h`;
    return `${latLonLabel(msg)} · ${startStr} · ${spanLabel(msg)} · ${models}`;
  } catch {
    return 'Unknown';
  }
}

// ── DecoderTab ─────────────────────────────────────────────────────────────

interface Props {
  forecastData: string;
  onForecastDataChange: (v: string) => void;
  units: Units;
}

export default function DecoderTab({ forecastData, onForecastDataChange, units }: Props) {
  const [decoded, setDecoded] = useState<ForecastMessage | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [cache, setCache] = useState<CacheEntry[]>([]);
  // When true, the next decode came from loading a cached entry — don't re-cache it.
  const suppressNextCache = useRef(false);

  useEffect(() => {
    loadCache().then(setCache);
  }, []);

  useEffect(() => {
    if (!forecastData.trim()) {
      setDecoded(null);
      setError(null);
      suppressNextCache.current = false;
      return;
    }
    try {
      const msg = decodeAny(forecastData);
      setDecoded(msg);
      setError(null);
      if (suppressNextCache.current) {
        suppressNextCache.current = false;
      } else {
        addToCache(forecastData).then(setCache);
      }
    } catch (e) {
      suppressNextCache.current = false;
      setDecoded(null);
      const msg = String(e);
      if (msg.includes('Version mismatch')) {
        const match = msg.match(/encoded v(\d+)/);
        const encoded = match ? match[1] : '?';
        setError(`Version mismatch: this message uses protocol v${encoded}, which this app can't decode. Update the app or request a new forecast.`);
      } else {
        setError('Could not decode forecast — paste the encoded reply from your inReach.');
      }
    }
  }, [forecastData]);

  const loadPast = useCallback((encoded: string) => {
    suppressNextCache.current = true;
    onForecastDataChange(encoded);
  }, [onForecastDataChange]);

  const deletePast = useCallback((encoded: string) => {
    deleteFromCache(encoded).then(setCache);
  }, []);

  const pastSection = (
    <View style={styles.pastSection}>
      <Text style={styles.pastHeaderText}>Past forecasts</Text>
      {cache.length === 0 ? (
        <Text style={styles.pastEmpty}>No past forecasts.</Text>
      ) : (
        cache.map((entry) => (
          <View key={entry.encoded} style={styles.pastItem}>
            <Text style={styles.pastMeta} numberOfLines={2}>{cacheMetaLabel(entry.encoded)}</Text>
            <View style={styles.pastBtns}>
              <TouchableOpacity style={styles.pastLoadBtn} onPress={() => loadPast(entry.encoded)}>
                <Text style={styles.pastLoadText}>Load</Text>
              </TouchableOpacity>
              <TouchableOpacity style={styles.pastDeleteBtn} onPress={() => deletePast(entry.encoded)}>
                <Text style={styles.pastDeleteText}>Delete</Text>
              </TouchableOpacity>
            </View>
          </View>
        ))
      )}
    </View>
  );

  return (
    <ScrollView
      style={{ flex: 1, backgroundColor: '#f2f2f7' }}
      contentContainerStyle={{ paddingBottom: 48 }}
      keyboardShouldPersistTaps="handled"
    >
      {/* Input area (scrolls away with the rest of the page rather than staying pinned) */}
      <Text style={styles.inputPrompt}>Paste the forecast response from your inReach here</Text>
      <View style={styles.inputArea}>
        <TextInput
          style={styles.input}
          value={forecastData}
          onChangeText={onForecastDataChange}
          placeholder="Paste encoded forecast here…"
          placeholderTextColor="#aeaeb2"
          autoCapitalize="none"
          autoCorrect={false}
          multiline
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

      {error && (
        <View style={styles.errorBox}>
          <Text style={styles.errorText}>{error}</Text>
        </View>
      )}

      {decoded && (
        <>
          {/* Meta */}
          <View style={styles.metaRow}>
            <Text style={styles.metaText} numberOfLines={3}>{metaLabel(decoded, units)}</Text>
          </View>

          {/* Forecast location. Keyed on the coordinate so loading a new forecast recenters the map. */}
          <View style={styles.mapRow}>
            <LocationMap
              key={`${decoded.lat},${decoded.lon}`}
              coord={{ lat: decoded.lat, lon: decoded.lon }}
              height={160}
            />
          </View>

          {/* Forecast meteogram */}
          <Meteogram msg={decoded} units={units} />
        </>
      )}

      {!decoded && !error && (
        <View style={styles.emptyState}>
          <Text style={styles.emptyTitle}>No forecast loaded</Text>
          <Text style={styles.emptyBody}>
            Fetch a forecast from the Builder tab, or paste an encoded reply received via Garmin inReach.
          </Text>
        </View>
      )}

      {pastSection}
    </ScrollView>
  );
}

// ── Styles ─────────────────────────────────────────────────────────────────

const styles = StyleSheet.create({
  inputPrompt: {
    backgroundColor: '#fff',
    paddingHorizontal: 14,
    paddingTop: 12,
    paddingBottom: 4,
    fontSize: 13,
    fontWeight: '600',
    color: '#6e6e73',
  },
  inputArea: {
    backgroundColor: '#fff',
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: '#d1d1d6',
    flexDirection: 'row',
    alignItems: 'flex-start',
    paddingHorizontal: 14,
    paddingBottom: 10,
    minHeight: 54,
  },
  input: {
    flex: 1,
    fontFamily: 'Courier',
    fontSize: 13,
    color: '#1c1c1e',
    lineHeight: 20,
    maxHeight: 120,
  },
  clearBtn: {
    marginLeft: 8,
    marginTop: 2,
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
  metaText: { fontSize: 13, color: '#3a3a3c', lineHeight: 18 },

  mapRow: { marginHorizontal: 16, marginBottom: 8 },

  emptyState: { alignItems: 'center', justifyContent: 'center', padding: 40 },
  emptyTitle: { fontSize: 18, fontWeight: '600', color: '#3a3a3c', marginBottom: 10, textAlign: 'center' },
  emptyBody: { fontSize: 14, color: '#8e8e93', lineHeight: 21, textAlign: 'center' },

  pastSection: { marginTop: 8, marginHorizontal: 16 },
  pastHeaderText: { fontSize: 12, fontWeight: '700', color: '#8e8e93', textTransform: 'uppercase', letterSpacing: 0.5, paddingVertical: 12 },
  pastEmpty: { fontSize: 13, color: '#aeaeb2', fontFamily: 'Courier', paddingVertical: 12 },
  pastItem: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    paddingVertical: 10, gap: 12,
    borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: '#e5e5ea',
  },
  pastMeta: { flex: 1, fontSize: 13, color: '#3a3a3c', lineHeight: 18 },
  pastBtns: { flexDirection: 'row', gap: 8 },
  pastLoadBtn: { paddingHorizontal: 14, paddingVertical: 6, borderRadius: 8, backgroundColor: '#2a6bb5' },
  pastLoadText: { color: '#fff', fontSize: 13, fontWeight: '600' },
  pastDeleteBtn: { paddingHorizontal: 14, paddingVertical: 6, borderRadius: 8, backgroundColor: '#fff', borderWidth: 1, borderColor: '#d1d1d6' },
  pastDeleteText: { color: '#8e8e93', fontSize: 13, fontWeight: '600' },
});
