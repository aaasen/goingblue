import { useState, useEffect, useRef, useCallback } from 'react';
import {
  StyleSheet, Text, View, TextInput, TouchableOpacity,
  ScrollView,
} from 'react-native';
import {
  CARDINALS, RESOLUTION_HOURS, RESOLUTION_LABEL, modelsFromMask, startDatetime,
  type ForecastMessage, type Period,
} from '@weather/protocol';
import { decodeAny, loadCache, addToCache, deleteFromCache, type CacheEntry } from './cache';

// ── Types ──────────────────────────────────────────────────────────────────

type Units = 'imperial' | 'metric';

// ── Layout constants ───────────────────────────────────────────────────────

const LABEL_W = 78;
const CELL_W = 72;

const ROW_H = {
  DATE: 52,
  MODEL: 30,
  SECTION: 24,
  ICON: 66,
  DATA: 42,
  SEP: 10,
} as const;

// ── Weather data ───────────────────────────────────────────────────────────

const WMO: Record<number, [string, string]> = {
  0:  ['Clear',        '☀️'],
  1:  ['Clear',        '🌤️'],
  2:  ['P. Cloudy',   '⛅'],
  3:  ['Overcast',     '☁️'],
  45: ['Fog',          '🌫️'],
  48: ['Rime fog',     '🌫️'],
  51: ['Lt drizzle',  '🌦️'],
  53: ['Drizzle',      '🌦️'],
  55: ['Drizzle',      '🌦️'],
  56: ['Frz drizzle', '🌨️'],
  57: ['Frz drizzle', '🌨️'],
  61: ['Lt rain',     '🌧️'],
  63: ['Rain',         '🌧️'],
  65: ['Hvy rain',    '🌧️'],
  66: ['Frz rain',    '🌨️'],
  67: ['Frz rain',    '🌨️'],
  71: ['Lt snow',     '❄️'],
  73: ['Snow',         '❄️'],
  75: ['Hvy snow',    '❄️'],
  77: ['Snowgrains',  '🌨️'],
  80: ['Showers',      '🌧️'],
  81: ['Showers',      '🌧️'],
  82: ['Hvy showers', '🌧️'],
  85: ['Snow showers','🌨️'],
  86: ['Snow showers','🌨️'],
  95: ['Thunder',      '⛈️'],
  96: ['Thunder+hail', '⛈️'],
  99: ['Thunder+hail', '⛈️'],
};

const ARROWS: Record<string, string> = {
  N: '↓', NE: '↙', E: '←', SE: '↖',
  S: '↑', SW: '↗', W: '→', NW: '↘',
};

// [mph upper bound, bg, fg]
const BEAUFORT: [number, string, string][] = [
  [1,        '#7e97a0', '#fff'],
  [4,        '#7e97a0', '#fff'],
  [8,        '#82c8ec', '#1a1a1a'],
  [13,       '#3a9ecc', '#fff'],
  [19,       '#3a9e88', '#fff'],
  [25,       '#4a9e30', '#fff'],
  [32,       '#d47810', '#fff'],
  [39,       '#9e2818', '#fff'],
  [47,       '#dd0028', '#fff'],
  [55,       '#8800aa', '#fff'],
  [64,       '#5030b0', '#fff'],
  [73,       '#006888', '#fff'],
  [Infinity, '#00cc44', '#fff'],
];

const MODEL_COLORS: Record<string, string> = {
  'ECMWF IFS HRES':  '#2a6bb5',
  'GFS':             '#2a8f5a',
  'ICON':            '#c06010',
  'ECMWF IFS 0.25':  '#7040b0',
};

// ── Formatting ─────────────────────────────────────────────────────────────

function beaufortStyle(kph: number): { bg: string; fg: string } {
  const mph = kph / 1.60934;
  const [, bg, fg] = BEAUFORT.find(([lim]) => mph < lim)!;
  return { bg, fg };
}

function fmtTemp(c: number | undefined, units: Units): string {
  if (c == null) return '—';
  return units === 'imperial' ? `${Math.round(c * 9 / 5 + 32)}°F` : `${Math.round(c)}°C`;
}

function fmtSnow(cm: number | undefined, units: Units): string {
  if (cm == null || cm === 0) return '—';
  if (units === 'imperial') {
    const inches = Math.round(cm / 2.54);
    return inches ? `${inches}"` : '—';
  }
  return `${Math.round(cm)}cm`;
}

function fmtFreeze(m: number | undefined, units: Units): string {
  if (m == null) return '—';
  if (units === 'imperial') {
    const ft = Math.round(m * 3.28084 / 500) * 500;
    return `${ft.toLocaleString()}ft`;
  }
  return `${Math.round(m / 100) * 100}m`;
}

function fmtWind(kph: number | undefined, units: Units): string {
  if (kph == null) return '—';
  return units === 'imperial' ? `${Math.round(kph / 1.60934)}mph` : `${Math.round(kph)}kph`;
}

function precipColor(pct: number): string {
  if (pct >= 60) return '#c04040';
  if (pct >= 30) return '#c08020';
  return '#4080c8';
}

function periodLabel(date: Date, timeStep: number): string {
  const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  if (timeStep >= 24) return `${DAYS[date.getDay()]}\n${date.getMonth() + 1}/${date.getDate()}`;
  if (timeStep === 1) return `${String(date.getHours()).padStart(2, '0')}:00`;
  return `${DAYS[date.getDay()]}\n${date.getHours()}h`;
}

// ── Row model ──────────────────────────────────────────────────────────────

interface ModelBlock {
  modelName: string;
  modelColor: string;
  rows: DataRow[];
  periods: Period[];
}

interface DataRow {
  label: string;
  sublabel?: string;
  height: number;
  kind: 'icon' | 'precip' | 'temp-max' | 'temp-min' | 'snow' | 'freeze'
       | 'wind-sfc' | 'cloud-total' | 'cloud-high' | 'cloud-mid' | 'cloud-low'
       | 'wind-500' | 'wind-600' | 'wind-700' | 'section';
}

function buildBlocks(msg: ForecastMessage, models: string[]): ModelBlock[] {
  return msg.periods.map((periods, mi) => {
    const modelName = models[mi] ?? `Model ${mi + 1}`;
    const modelColor = MODEL_COLORS[modelName] ?? '#666';
    const rows: DataRow[] = [];

    const has = (fn: (p: Period) => unknown) => periods.some((p) => fn(p) != null);

    rows.push({ label: '', height: ROW_H.ICON, kind: 'icon' });

    const hasSurface =
      has((p) => p.precip) || has((p) => p.temp_c) || has((p) => p.temp_min_c) ||
      has((p) => p.snow_cm) || has((p) => p.freeze_m) || has((p) => p.wind_sfc_kph);

    if (hasSurface) {
      rows.push({ label: 'Surface', height: ROW_H.SECTION, kind: 'section' });
      if (has((p) => p.precip))     rows.push({ label: 'Precip',   height: ROW_H.DATA, kind: 'precip' });
      if (has((p) => p.temp_c))     rows.push({ label: 'Max temp', height: ROW_H.DATA, kind: 'temp-max' });
      if (has((p) => p.temp_min_c)) rows.push({ label: 'Min temp', height: ROW_H.DATA, kind: 'temp-min' });
      if (has((p) => p.snow_cm))    rows.push({ label: 'Snow',     height: ROW_H.DATA, kind: 'snow' });
      if (has((p) => p.freeze_m))   rows.push({ label: 'Freeze',   height: ROW_H.DATA, kind: 'freeze' });
      if (has((p) => p.wind_sfc_kph)) rows.push({ label: 'Wind',  height: ROW_H.DATA, kind: 'wind-sfc' });
    }

    const hasCloud =
      has((p) => p.cloud_total) || has((p) => p.cloud_high) ||
      has((p) => p.cloud_mid)   || has((p) => p.cloud_low);

    if (hasCloud) {
      rows.push({ label: 'Cloud', height: ROW_H.SECTION, kind: 'section' });
      if (has((p) => p.cloud_total)) rows.push({ label: 'Total', height: ROW_H.DATA, kind: 'cloud-total' });
      if (has((p) => p.cloud_high))  rows.push({ label: 'High',  height: ROW_H.DATA, kind: 'cloud-high' });
      if (has((p) => p.cloud_mid))   rows.push({ label: 'Mid',   height: ROW_H.DATA, kind: 'cloud-mid' });
      if (has((p) => p.cloud_low))   rows.push({ label: 'Low',   height: ROW_H.DATA, kind: 'cloud-low' });
    }

    const hasUpper =
      has((p) => p.wind_500_kph) || has((p) => p.wind_600_kph) || has((p) => p.wind_700_kph);

    if (hasUpper) {
      rows.push({ label: 'Pressure', height: ROW_H.SECTION, kind: 'section' });
      if (has((p) => p.wind_500_kph)) rows.push({ label: '500mb', sublabel: '~18k ft / 5.5k m', height: ROW_H.DATA, kind: 'wind-500' });
      if (has((p) => p.wind_600_kph)) rows.push({ label: '600mb', sublabel: '~14k ft / 4.2k m', height: ROW_H.DATA, kind: 'wind-600' });
      if (has((p) => p.wind_700_kph)) rows.push({ label: '700mb', sublabel: '~10k ft / 3k m',   height: ROW_H.DATA, kind: 'wind-700' });
    }

    return { modelName, modelColor, rows, periods };
  });
}

// ── Cell renderers ─────────────────────────────────────────────────────────

function IconCell({ period, height }: { period: Period; height: number }) {
  const [label, emoji] = WMO[period.weathercode] ?? ['Unknown', '❓'];
  return (
    <View style={[ftStyles.cell, { height, width: CELL_W, alignItems: 'center', justifyContent: 'center' }]}>
      <Text style={ftStyles.wmoEmoji}>{emoji}</Text>
      <Text style={ftStyles.wmoLabel} numberOfLines={2}>{label}</Text>
    </View>
  );
}

function PrecipCell({ period, height }: { period: Period; height: number }) {
  const pct = period.precip;
  if (pct == null) return <NilCell height={height} />;
  const color = precipColor(pct);
  return (
    <View style={[ftStyles.cell, { height, width: CELL_W, alignItems: 'center', justifyContent: 'center' }]}>
      <Text style={[ftStyles.precipPct, { color }]}>{pct}%</Text>
      <View style={ftStyles.precipTrack}>
        <View style={[ftStyles.precipFill, { width: `${pct}%` as any, backgroundColor: color }]} />
      </View>
    </View>
  );
}

function TextCell({ value, height }: { value: string; height: number }) {
  return (
    <View style={[ftStyles.cell, { height, width: CELL_W, alignItems: 'center', justifyContent: 'center' }]}>
      <Text style={ftStyles.dataText}>{value}</Text>
    </View>
  );
}

function WindCell({ kph, dirIdx, height, units }: { kph: number | undefined; dirIdx: number | undefined; height: number; units: Units }) {
  if (kph == null) return <NilCell height={height} />;
  const { bg, fg } = beaufortStyle(kph);
  const dir = dirIdx != null ? (CARDINALS[dirIdx] ?? 'N') : 'N';
  const arrow = ARROWS[dir] ?? '';
  return (
    <View style={[ftStyles.cell, { height, width: CELL_W, backgroundColor: bg, alignItems: 'center', justifyContent: 'center' }]}>
      <Text style={[ftStyles.windSpeed, { color: fg }]}>{fmtWind(kph, units)}</Text>
      <Text style={[ftStyles.windDir, { color: fg }]}>{dir} {arrow}</Text>
    </View>
  );
}

function CloudCell({ pct, height }: { pct: number | undefined; height: number }) {
  if (pct == null) return <NilCell height={height} />;
  const alpha = (pct / 100).toFixed(2);
  return (
    <View style={[ftStyles.cell, { height, width: CELL_W, backgroundColor: `rgba(130,130,130,${alpha})`, alignItems: 'center', justifyContent: 'center' }]}>
      <Text style={ftStyles.cloudPct}>{pct}%</Text>
    </View>
  );
}

function NilCell({ height }: { height: number }) {
  return (
    <View style={[ftStyles.cell, { height, width: CELL_W, alignItems: 'center', justifyContent: 'center' }]}>
      <Text style={ftStyles.nil}>—</Text>
    </View>
  );
}

function SectionBandCell({ height }: { height: number }) {
  return <View style={[ftStyles.cell, { height, width: CELL_W, backgroundColor: '#e8eaf0' }]} />;
}

function renderCell(row: DataRow, period: Period, units: Units) {
  const { kind, height } = row;
  switch (kind) {
    case 'icon':   return <IconCell   period={period} height={height} />;
    case 'precip': return <PrecipCell period={period} height={height} />;
    case 'temp-max': return <TextCell value={fmtTemp(period.temp_c,     units)} height={height} />;
    case 'temp-min': return <TextCell value={fmtTemp(period.temp_min_c, units)} height={height} />;
    case 'snow':     return <TextCell value={fmtSnow(period.snow_cm,    units)} height={height} />;
    case 'freeze':   return <TextCell value={fmtFreeze(period.freeze_m, units)} height={height} />;
    case 'wind-sfc': return <WindCell kph={period.wind_sfc_kph} dirIdx={period.wind_sfc_dir} height={height} units={units} />;
    case 'cloud-total': return <CloudCell pct={period.cloud_total} height={height} />;
    case 'cloud-high':  return <CloudCell pct={period.cloud_high}  height={height} />;
    case 'cloud-mid':   return <CloudCell pct={period.cloud_mid}   height={height} />;
    case 'cloud-low':   return <CloudCell pct={period.cloud_low}   height={height} />;
    case 'wind-500': return <WindCell kph={period.wind_500_kph} dirIdx={period.wind_500_dir} height={height} units={units} />;
    case 'wind-600': return <WindCell kph={period.wind_600_kph} dirIdx={period.wind_600_dir} height={height} units={units} />;
    case 'wind-700': return <WindCell kph={period.wind_700_kph} dirIdx={period.wind_700_dir} height={height} units={units} />;
    case 'section':  return <SectionBandCell height={height} />;
    default:         return <NilCell height={height} />;
  }
}

// ── Forecast table ─────────────────────────────────────────────────────────

function ForecastTable({ msg, units }: { msg: ForecastMessage; units: Units }) {
  const models = modelsFromMask(msg.models_mask);
  const blocks = buildBlocks(msg, models);
  const resHours = RESOLUTION_HOURS[msg.resolution] ?? 24;
  const start = startDatetime(msg);
  const stepMs = resHours * 3600000;
  const nPeriods = blocks[0]?.periods.length ?? 0;
  const dates = Array.from({ length: nPeriods }, (_, i) => new Date(start.getTime() + i * stepMs));

  return (
    <View style={ftStyles.container}>
      {blocks.map((block, bi) => (
        <View key={bi} style={ftStyles.modelBlock}>
          {/* Model header (full width, only shown when multiple models) */}
          {blocks.length > 1 && (
            <View style={[ftStyles.modelHeader, { backgroundColor: block.modelColor }]}>
              <Text style={ftStyles.modelHeaderText}>{block.modelName}</Text>
            </View>
          )}

          {/* Sticky label column + scrollable data */}
          <View style={ftStyles.tableRow}>
            {/* Fixed label column */}
            <View style={{ width: LABEL_W }}>
              {/* Spacer for date header */}
              <View style={{ height: ROW_H.DATE }} />

              {block.rows.map((row, ri) => {
                if (row.kind === 'section') {
                  return (
                    <View key={ri} style={[ftStyles.labelCell, { height: row.height, backgroundColor: '#e8eaf0' }]}>
                      <Text style={ftStyles.sectionLabelText}>{row.label}</Text>
                    </View>
                  );
                }
                return (
                  <View key={ri} style={[ftStyles.labelCell, { height: row.height }]}>
                    <Text style={ftStyles.labelText} numberOfLines={1}>{row.label}</Text>
                    {row.sublabel != null && (
                      <Text style={ftStyles.sublabelText} numberOfLines={1}>{row.sublabel}</Text>
                    )}
                  </View>
                );
              })}
            </View>

            {/* Scrollable data section */}
            <ScrollView horizontal bounces={false} showsHorizontalScrollIndicator={bi === blocks.length - 1}>
              <View>
                {/* Date header */}
                <View style={{ flexDirection: 'row', height: ROW_H.DATE, backgroundColor: '#fff', borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: '#d1d1d6' }}>
                  {dates.map((d, i) => (
                    <View key={i} style={{ width: CELL_W, alignItems: 'center', justifyContent: 'center' }}>
                      <Text style={ftStyles.dateText}>{periodLabel(d, resHours)}</Text>
                    </View>
                  ))}
                </View>

                {/* Data rows */}
                {block.rows.map((row, ri) => (
                  <View key={ri} style={{ flexDirection: 'row', height: row.height, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: '#e5e5ea' }}>
                    {block.periods.map((period, pi) => (
                      <View key={pi}>
                        {renderCell(row, period, units)}
                      </View>
                    ))}
                  </View>
                ))}
              </View>
            </ScrollView>
          </View>

          {/* Separator between models */}
          {bi < blocks.length - 1 && <View style={{ height: ROW_H.SEP, backgroundColor: '#f2f2f7' }} />}
        </View>
      ))}
    </View>
  );
}

// ── DecoderTab ─────────────────────────────────────────────────────────────

function latLonLabel(msg: ForecastMessage): string {
  const latStr = `${Math.abs(msg.lat).toFixed(2)}°${msg.lat >= 0 ? 'N' : 'S'}`;
  const lonStr = `${Math.abs(msg.lon).toFixed(2)}°${msg.lon >= 0 ? 'E' : 'W'}`;
  return `${latStr} ${lonStr}`;
}

function metaLabel(msg: ForecastMessage, units: Units): string {
  const models = modelsFromMask(msg.models_mask);
  const resHours = RESOLUTION_HOURS[msg.resolution] ?? 24;
  const resLabel = resHours >= 24 ? 'daily' : `${resHours}h`;
  const elevStr = msg.elevation > 0
    ? units === 'imperial'
      ? ` · ${Math.round(msg.elevation * 3.28084).toLocaleString()}ft`
      : ` · ${Math.round(msg.elevation).toLocaleString()}m`
    : '';
  return `${latLonLabel(msg)}${elevStr} · ${msg.days}d ${resLabel} · ${models.join(' + ')}`;
}

const DAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

/** Compact label for a cached forecast (location · start · NNd res · models). */
function cacheMetaLabel(encoded: string): string {
  try {
    const msg = decodeAny(encoded);
    const models = modelsFromMask(msg.models_mask).join(' + ');
    const resLabel = RESOLUTION_LABEL[msg.resolution] ?? '?';
    const resHours = RESOLUTION_HOURS[msg.resolution] ?? 24;
    const start = startDatetime(msg);
    const startStr = resHours >= 24
      ? `${DAY_NAMES[start.getDay()]} ${start.getMonth() + 1}/${start.getDate()}`
      : `${DAY_NAMES[start.getDay()]} ${start.getMonth() + 1}/${start.getDate()} ${start.getHours()}h`;
    return `${latLonLabel(msg)} · ${startStr} · ${msg.days}d ${resLabel} · ${models}`;
  } catch {
    return 'Unknown';
  }
}

interface Props {
  forecastData: string;
  onForecastDataChange: (v: string) => void;
}

export default function DecoderTab({ forecastData, onForecastDataChange }: Props) {
  const [units, setUnits] = useState<Units>('imperial');
  const [decoded, setDecoded] = useState<ForecastMessage | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [cache, setCache] = useState<CacheEntry[]>([]);
  const [showPast, setShowPast] = useState(false);
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
    setShowPast(false);
  }, [onForecastDataChange]);

  const deletePast = useCallback((encoded: string) => {
    deleteFromCache(encoded).then(setCache);
  }, []);

  const pastSection = (
    <View style={styles.pastSection}>
      <TouchableOpacity
        style={styles.pastHeader}
        onPress={() => setShowPast((s) => !s)}
        activeOpacity={0.6}
      >
        <Text style={styles.pastHeaderText}>Past forecasts</Text>
        <Text style={styles.pastChevron}>{showPast ? '▼' : '▶'}</Text>
      </TouchableOpacity>
      {showPast && (
        cache.length === 0 ? (
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
        )
      )}
    </View>
  );

  return (
    <View style={{ flex: 1, backgroundColor: '#f2f2f7' }}>
      {/* Input area */}
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

      <ScrollView style={{ flex: 1 }} contentContainerStyle={{ paddingBottom: 48 }}>
        {error && (
          <View style={styles.errorBox}>
            <Text style={styles.errorText}>{error}</Text>
          </View>
        )}

        {decoded && (
          <>
            {/* Meta + controls */}
            <View style={styles.metaRow}>
              <Text style={styles.metaText} numberOfLines={3}>{metaLabel(decoded, units)}</Text>
              <View style={styles.unitsToggle}>
                <TouchableOpacity
                  style={[styles.unitBtn, units === 'imperial' && styles.unitBtnActive]}
                  onPress={() => setUnits('imperial')}
                >
                  <Text style={[styles.unitBtnText, units === 'imperial' && styles.unitBtnTextActive]}>Imperial</Text>
                </TouchableOpacity>
                <TouchableOpacity
                  style={[styles.unitBtn, units === 'metric' && styles.unitBtnActive]}
                  onPress={() => setUnits('metric')}
                >
                  <Text style={[styles.unitBtnText, units === 'metric' && styles.unitBtnTextActive]}>Metric</Text>
                </TouchableOpacity>
              </View>
            </View>

            {/* Forecast table */}
            <ForecastTable msg={decoded} units={units} />
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
    </View>
  );
}

// ── Styles ─────────────────────────────────────────────────────────────────

const styles = StyleSheet.create({
  inputArea: {
    backgroundColor: '#fff',
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: '#d1d1d6',
    flexDirection: 'row',
    alignItems: 'flex-start',
    paddingHorizontal: 14,
    paddingVertical: 10,
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
  unitsToggle: { flexDirection: 'row', alignSelf: 'flex-start', backgroundColor: '#e5e5ea', borderRadius: 8, padding: 2 },
  unitBtn: { paddingHorizontal: 14, paddingVertical: 5, borderRadius: 6 },
  unitBtnActive: { backgroundColor: '#fff' },
  unitBtnText: { fontSize: 13, color: '#6e6e73', fontWeight: '500' },
  unitBtnTextActive: { color: '#1c1c1e' },

  emptyState: { alignItems: 'center', justifyContent: 'center', padding: 40 },
  emptyTitle: { fontSize: 18, fontWeight: '600', color: '#3a3a3c', marginBottom: 10, textAlign: 'center' },
  emptyBody: { fontSize: 14, color: '#8e8e93', lineHeight: 21, textAlign: 'center' },

  pastSection: { marginTop: 8, marginHorizontal: 16 },
  pastHeader: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingVertical: 12 },
  pastHeaderText: { fontSize: 12, fontWeight: '700', color: '#8e8e93', textTransform: 'uppercase', letterSpacing: 0.5 },
  pastChevron: { fontSize: 11, color: '#8e8e93' },
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

const ftStyles = StyleSheet.create({
  container: { backgroundColor: '#fff', marginTop: 0 },
  modelBlock: {},
  modelHeader: {
    paddingHorizontal: 14,
    paddingVertical: 7,
  },
  modelHeaderText: { color: '#fff', fontSize: 13, fontWeight: '600' },

  tableRow: { flexDirection: 'row' },

  labelCell: {
    width: LABEL_W,
    justifyContent: 'center',
    paddingLeft: 12,
    paddingRight: 4,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: '#e5e5ea',
  },
  labelText: { fontSize: 12, fontWeight: '600', color: '#3a3a3c' },
  sublabelText: { fontSize: 10, color: '#8e8e93', marginTop: 1 },
  sectionLabelText: { fontSize: 11, fontWeight: '700', color: '#6e6e73', textTransform: 'uppercase', letterSpacing: 0.3 },

  dateText: { fontSize: 12, fontWeight: '600', color: '#3a3a3c', textAlign: 'center', lineHeight: 17 },

  // cell base
  cell: { borderRightWidth: StyleSheet.hairlineWidth, borderRightColor: '#e5e5ea' },
  wmoEmoji: { fontSize: 22, lineHeight: 28 },
  wmoLabel: { fontSize: 10, color: '#3a3a3c', textAlign: 'center', marginTop: 2, lineHeight: 12 },

  precipPct: { fontSize: 13, fontWeight: '600' },
  precipTrack: { marginTop: 3, width: 44, height: 3, backgroundColor: '#e5e5ea', borderRadius: 1.5, overflow: 'hidden' },
  precipFill: { height: 3, borderRadius: 1.5 },

  dataText: { fontSize: 13, color: '#1c1c1e', fontWeight: '500', textAlign: 'center' },

  windSpeed: { fontSize: 12, fontWeight: '700', textAlign: 'center' },
  windDir: { fontSize: 11, textAlign: 'center', marginTop: 2 },

  cloudPct: { fontSize: 13, fontWeight: '600', color: '#1c1c1e' },

  nil: { fontSize: 16, color: '#c7c7cc' },
});
