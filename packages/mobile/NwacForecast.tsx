import { useEffect, useMemo, useState } from 'react';
import { Image, StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import MaterialCommunityIcons from '@expo/vector-icons/MaterialCommunityIcons';
import { SkiaPictureView, Skia, type SkPicture } from '@shopify/react-native-skia';
import { DANGER_LEVELS, ELEVATIONS, type AvalancheForecast, type AvalancheProblem, type DangerDay, type Elevation, type ProblemType } from '@weather/protocol';
import { CARD_PAD, DangerScale, PAD, Prose, Rose, ScaleView, iconPicture, iconSlot, roseFitsBeside, useFonts, type Fonts } from './AvalancheScreen';
import InfoModal from './components/InfoModal';
import WarningBanner from './components/WarningBanner';
import { dangerCell, highestDanger, likelihoodScale, nwacBandLabel, nwacDayLabel, nwacProblemNames, nwacSizeScale, nwacStamp, nwacZone } from './avalancheDisplay';
import { fillPaint } from './skiaPaint';
import { palette } from './palette';
import { loadHideExpiredBanner, type TimeFormat } from './settings';

// An NWAC forecast laid out the way nwac.us lays it out, narrowed to a phone: the outlook day
// collapses, and the problem graphics take two rows rather than four columns.

const PROBLEM_ICONS: Record<ProblemType, number> = {
  stormSlab: require('./assets/problem-icons/StormSlab.png'),
  windSlab: require('./assets/problem-icons/WindSlab.png'),
  persistentSlab: require('./assets/problem-icons/PersistentSlab.png'),
  deepPersistentSlab: require('./assets/problem-icons/DeepPersistentSlab.png'),
  wetSlab: require('./assets/problem-icons/WetSlab.png'),
  wetLoose: require('./assets/problem-icons/WetLoose.png'),
  dryLoose: require('./assets/problem-icons/DryLoose.png'),
  cornice: require('./assets/problem-icons/CorniceFall.png'),
  glide: require('./assets/problem-icons/Glide.png'),
};

const BAND_FILL = '#e7e9ec';
const ROSE_FILL = '#c9cbd0';
const SCALE_TEXT_MUTED = '#a3a6ab';
const NO_LEVEL_FILL = '#d9dbdf';
const NAVY = '#1b2a56';
const ROW_GAP = 4;
const PROBLEM_ICON = 84;
const COLUMN_GAP = 12;

// Upper band on top, where the pyramid's tip is.
const BANDS_TOP_DOWN = [...ELEVATIONS].reverse();

function recordPyramid(day: DangerDay, W: number, rowH: number, cx: number, baseHalf: number, bands: boolean): SkPicture {
  const H = 3 * rowH + 2 * ROW_GAP;
  const recorder = Skia.PictureRecorder();
  const canvas = recorder.beginRecording(Skia.XYWHRect(0, 0, W, H));
  const half = (y: number) => (y / H) * baseHalf;
  BANDS_TOP_DOWN.forEach((band, i) => {
    const y0 = i * (rowH + ROW_GAP), y1 = y0 + rowH;
    if (bands) canvas.drawRect(Skia.XYWHRect(0, y0, W * 0.92, rowH), fillPaint(BAND_FILL));
    const cell = dangerCell(day[band]);
    const path = Skia.Path.Make();
    path.moveTo(cx - half(y0), y0);
    path.lineTo(cx + half(y0), y0);
    path.lineTo(cx + half(y1), y1);
    path.lineTo(cx - half(y1), y1);
    path.close();
    canvas.drawPath(path, fillPaint(cell.fill === '#ffffff' ? NO_LEVEL_FILL : cell.fill));
  });
  return recorder.finishRecordingAsPicture();
}

const ratingText = (band: Elevation, day: DangerDay) => {
  const cell = dangerCell(day[band]);
  return cell.number ? `${cell.number} - ${cell.name}` : cell.name;
};

// The first day: a gray row per band, its elevations on a chip, over the pyramid.
function ForecastDay({ day, zone, width }: { day: DangerDay; zone: string; width: number }) {
  const rowH = 74;
  const picture = useMemo(() => recordPyramid(day, width, rowH, width * 0.36, width * 0.22, true), [day, width]);
  const iconH = 34;
  return (
    <View style={{ height: 3 * rowH + 2 * ROW_GAP }}>
      <SkiaPictureView style={StyleSheet.absoluteFill} picture={picture} />
      {BANDS_TOP_DOWN.map((band, i) => {
        const label = nwacBandLabel(zone, band);
        return (
          <View key={band} style={[styles.bandRow, { top: i * (rowH + ROW_GAP), height: rowH }]}>
            <View style={styles.chip}>
              <Text style={styles.chipText}>{label.name}</Text>
              <Text style={styles.chipText}>{label.range}</Text>
            </View>
            <Text style={[styles.rating, { left: width * 0.6, width: width * 0.4 - iconSlot(iconH) * 0.55 }]} numberOfLines={2}>{ratingText(band, day)}</Text>
            <SkiaPictureView style={[styles.bandIcon, { width: iconSlot(iconH), height: iconH, top: (rowH - iconH) / 2 }]} picture={iconPicture(dangerCell(day[band]).icon, iconH)} />
          </View>
        );
      })}
    </View>
  );
}

// The outlook day: the same pyramid and ratings, smaller and without the rows.
function OutlookDay({ day, width }: { day: DangerDay; width: number }) {
  const rowH = 50;
  const picture = useMemo(() => recordPyramid(day, width, rowH, width * 0.24, width * 0.18, false), [day, width]);
  const iconH = 26;
  return (
    <View style={{ height: 3 * rowH + 2 * ROW_GAP }}>
      <SkiaPictureView style={StyleSheet.absoluteFill} picture={picture} />
      {BANDS_TOP_DOWN.map((band, i) => (
        <View key={band} style={[styles.bandRow, { top: i * (rowH + ROW_GAP), height: rowH }]}>
          <Text style={[styles.rating, { left: width * 0.47, width: width * 0.53 - iconSlot(iconH) }]} numberOfLines={2}>{ratingText(band, day)}</Text>
          <SkiaPictureView style={[styles.bandIcon, { width: iconSlot(iconH), height: iconH, top: (rowH - iconH) / 2 }]} picture={iconPicture(dangerCell(day[band]).icon, iconH)} />
        </View>
      ))}
    </View>
  );
}

function ScaleBar() {
  return (
    <View style={styles.scaleBar}>
      {DANGER_LEVELS.map((level) => {
        const cell = dangerCell(level);
        return (
          <View key={level} style={styles.scaleSegment}>
            <View style={[styles.scaleColor, { backgroundColor: cell.fill }]} />
            <Text style={styles.scaleNumber}>{cell.number}</Text>
            <Text style={styles.scaleName} numberOfLines={1} adjustsFontSizeToFit>{cell.name}</Text>
          </View>
        );
      })}
    </View>
  );
}

function ColumnLabel({ label }: { label: string }) {
  return (
    <View style={styles.columnHead}>
      <Text style={styles.columnLabel}>{label}</Text>
    </View>
  );
}

function ProblemCard({ problem, index, zone, width, fonts }: { problem: AvalancheProblem; index: number; zone: string; width: number; fonts: Fonts }) {
  const name = nwacProblemNames[problem.type];
  const labels = useMemo(() => Object.fromEntries(ELEVATIONS.map((e) => {
    const { name: band, range } = nwacBandLabel(zone, e);
    return [e, `${band} ${range}`];
  })) as Record<Elevation, string>, [zone]);
  const rose = useMemo(() => ({ fill: ROSE_FILL, labels, font: fonts.small, left: true }), [labels, fonts]);
  const likelihood = useMemo(() => likelihoodScale(problem.likelihood), [problem.likelihood]);
  const size = useMemo(() => nwacSizeScale(problem.size), [problem.size]);
  const scale = useMemo(() => ({ fill: ROSE_FILL, stroke: palette.textSecondary, muted: SCALE_TEXT_MUTED }), []);
  const besideW = width - PROBLEM_ICON - COLUMN_GAP;
  const beside = roseFitsBeside(besideW, labels, fonts);
  const scaleW = (width - COLUMN_GAP) / 2;
  return (
    <View style={styles.problem}>
      <Text style={styles.problemHead}>{`PROBLEM #${index + 1}: ${name.toUpperCase()}`}</Text>
      <View style={beside ? styles.columns : undefined}>
        <View style={[styles.typeColumn, beside && { width: PROBLEM_ICON }]}>
          <ColumnLabel label="PROBLEM TYPE" />
          <Image source={PROBLEM_ICONS[problem.type]} style={styles.problemIcon} accessibilityLabel={name} />
          <Text style={styles.problemName}>{name}</Text>
        </View>
        <View style={beside ? { width: besideW } : styles.roseStacked}>
          <ColumnLabel label="ASPECT/ELEVATION" />
          <Rose problem={problem} width={beside ? besideW : width} fonts={fonts} style={rose} />
        </View>
      </View>
      <View style={[styles.columns, styles.scales]}>
        <View style={{ width: scaleW }}>
          <ColumnLabel label="LIKELIHOOD" />
          <ScaleView scale={likelihood} width={scaleW} fonts={fonts} style={scale} />
        </View>
        <View style={{ width: scaleW }}>
          <ColumnLabel label="SIZE" />
          <ScaleView scale={size} width={scaleW} fonts={fonts} style={scale} />
        </View>
      </View>
      {problem.description ? <View style={styles.problemText}><Prose text={problem.description} /></View> : null}
    </View>
  );
}

function Stamp({ label, value }: { label: string; value: string }) {
  return (
    <View style={styles.stamp}>
      <Text style={styles.stampLabel}>{label}</Text>
      <Text style={styles.stampValue}>{value}</Text>
    </View>
  );
}

function Heading({ children, info }: { children: string; info?: () => void }) {
  return (
    <View style={styles.headingRow}>
      <Text style={styles.heading}>{children}</Text>
      {info && (
        <TouchableOpacity onPress={info} hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }} accessibilityRole="button" accessibilityLabel={`About ${children}`}>
          <MaterialCommunityIcons name="help-circle" size={18} color={palette.textSecondary} />
        </TouchableOpacity>
      )}
    </View>
  );
}

export default function NwacForecastView({ forecast, timeFormat }: { forecast: AvalancheForecast; timeFormat: TimeFormat }) {
  const fonts = useFonts();
  const [pageW, setPageW] = useState(0);
  const [scaleInfo, setScaleInfo] = useState(false);
  const [outlookOpen, setOutlookOpen] = useState(false);
  const [hideExpired, setHideExpired] = useState(false);
  useEffect(() => { loadHideExpiredBanner().then(setHideExpired); }, []);
  const width = pageW - 2 * PAD;
  const zone = nwacZone(forecast);
  const stamp = (ms: number) => nwacStamp(ms, forecast.timezone, timeFormat);
  const [today, outlook] = forecast.danger;
  const corner = today && dangerCell(highestDanger(today)).number ? dangerCell(highestDanger(today)).icon : null;
  return (
    <View style={styles.page} onLayout={(e) => setPageW(e.nativeEvent.layout.width)}>
      {forecast.expires < Date.now() && !hideExpired && (
        <WarningBanner>This forecast is no longer valid</WarningBanner>
      )}
      <View style={styles.zoneRow}>
        <MaterialCommunityIcons name="map-marker" size={20} color={palette.textSecondary} />
        <Text style={styles.zone}>{zone.toUpperCase()}</Text>
      </View>
      <View style={styles.stamps}>
        <Stamp label="ISSUED" value={stamp(forecast.issued)} />
        <Stamp label="EXPIRES" value={stamp(forecast.expires)} />
        {forecast.author ? <Stamp label="AUTHOR" value={forecast.author} /> : null}
      </View>

      {forecast.bottomLine ? (
        <View style={styles.bottomLine}>
          {corner && <SkiaPictureView style={[styles.cornerIcon, { width: iconSlot(46) }]} picture={iconPicture(corner, 46)} />}
          <View style={styles.bottomLineHead}><Text style={styles.columnLabel}>THE BOTTOM LINE</Text></View>
          <Prose text={forecast.bottomLine} />
        </View>
      ) : null}

      {today && width > 0 && (
        <View style={styles.section}>
          <Heading info={() => setScaleInfo(true)}>AVALANCHE DANGER</Heading>
          <Text style={styles.dayLabel}>{nwacDayLabel(today.date)}</Text>
          <ForecastDay day={today} zone={zone} width={width} />
          {outlook && (
            <View style={styles.outlook}>
              <TouchableOpacity
                style={styles.outlookHead}
                onPress={() => setOutlookOpen((o) => !o)}
                accessibilityRole="button"
                accessibilityState={{ expanded: outlookOpen }}
              >
                <Text style={styles.outlookLabel}>{nwacDayLabel(outlook.date)}</Text>
                <MaterialCommunityIcons name={outlookOpen ? 'chevron-up' : 'chevron-down'} size={24} color={palette.text} />
              </TouchableOpacity>
              {outlookOpen && <OutlookDay day={outlook} width={width} />}
            </View>
          )}
          <Text style={styles.scaleHeading}>DANGER SCALE</Text>
          <ScaleBar />
          <TouchableOpacity style={styles.scaleButton} onPress={() => setScaleInfo(true)} accessibilityRole="button">
            <MaterialCommunityIcons name="plus" size={16} color="#ffffff" />
            <Text style={styles.scaleButtonText}>Danger Scale</Text>
          </TouchableOpacity>
          <InfoModal visible={scaleInfo} title="Avalanche Danger Scale" onClose={() => setScaleInfo(false)}>
            <DangerScale />
          </InfoModal>
        </View>
      )}

      {today && width > 0 && (
        <View style={styles.section}>
          <Heading>{`AVALANCHE PROBLEMS (${forecast.problems.length})`}</Heading>
          {forecast.problems.map((p, i) => <ProblemCard key={i} problem={p} index={i} zone={zone} width={width} fonts={fonts} />)}
        </View>
      )}

      {forecast.hazardDiscussion ? (
        <View style={styles.section}>
          <Heading>FORECAST DISCUSSION</Heading>
          <Prose text={forecast.hazardDiscussion} />
        </View>
      ) : null}

      <Text style={styles.attribution}>Avalanche forecast provided by Northwest Avalanche Center.</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  page: { paddingHorizontal: PAD },
  zoneRow: { flexDirection: 'row', alignItems: 'center', gap: 8, marginBottom: 12 },
  zone: { flex: 1, fontSize: 18, fontWeight: '700', color: palette.textSecondary, letterSpacing: 0.3 },
  stamps: { marginBottom: 24, gap: 10 },
  stamp: { borderLeftWidth: 1, borderLeftColor: palette.cardRule, paddingLeft: 12 },
  stampLabel: { fontSize: 12, fontWeight: '700', color: palette.textSecondary, letterSpacing: 0.3, marginBottom: 3 },
  stampValue: { fontSize: 15, color: palette.text },
  bottomLine: {
    backgroundColor: palette.card, borderRadius: 6, borderWidth: 1, borderColor: palette.cardRule,
    padding: CARD_PAD, paddingTop: 30, marginTop: 8, marginBottom: 24,
  },
  cornerIcon: { position: 'absolute', top: -16, left: -8, height: 46 },
  bottomLineHead: { alignSelf: 'flex-start', borderBottomWidth: 1, borderBottomColor: palette.cardRule, paddingBottom: 3, marginBottom: 10 },
  section: { marginBottom: 24 },
  headingRow: { flexDirection: 'row', alignItems: 'center', gap: 8, marginBottom: 10 },
  heading: { fontSize: 19, fontWeight: '700', color: palette.text, letterSpacing: 0.3 },
  dayLabel: { fontSize: 16, fontWeight: '700', color: palette.text, marginBottom: 10 },
  bandRow: { position: 'absolute', left: 0, right: 0, justifyContent: 'center' },
  chip: { position: 'absolute', left: 8, backgroundColor: '#ffffff', borderRadius: 3, paddingHorizontal: 5, paddingVertical: 3 },
  chipText: { fontSize: 11, lineHeight: 15, color: '#6b6e73' },
  rating: { position: 'absolute', fontSize: 15, fontWeight: '700', color: palette.text },
  bandIcon: { position: 'absolute', right: 0 },
  outlook: { marginTop: 20, borderTopWidth: 6, borderBottomWidth: 6, borderColor: BAND_FILL, paddingBottom: 12 },
  outlookHead: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingVertical: 12 },
  outlookLabel: { fontSize: 16, fontWeight: '700', color: palette.text },
  scaleHeading: { fontSize: 15, fontWeight: '700', color: palette.text, letterSpacing: 0.3, marginTop: 20, marginBottom: 8 },
  scaleBar: { flexDirection: 'row', gap: 3, marginBottom: 14 },
  scaleSegment: { flex: 1, alignItems: 'center' },
  scaleColor: { alignSelf: 'stretch', height: 9, marginBottom: 4 },
  scaleNumber: { fontSize: 12, fontWeight: '700', color: palette.text },
  scaleName: { fontSize: 11, color: palette.text },
  scaleButton: { alignSelf: 'center', flexDirection: 'row', alignItems: 'center', gap: 6, backgroundColor: NAVY, borderRadius: 5, paddingHorizontal: 14, paddingVertical: 9 },
  scaleButtonText: { fontSize: 15, fontWeight: '600', color: '#ffffff' },
  problem: { marginBottom: 24 },
  problemHead: { fontSize: 16, fontWeight: '700', color: palette.text, letterSpacing: 0.3, marginBottom: 14 },
  columns: { flexDirection: 'row', gap: COLUMN_GAP },
  typeColumn: { alignItems: 'center' },
  roseStacked: { marginTop: 14 },
  columnHead: { alignSelf: 'center', borderBottomWidth: 1, borderBottomColor: palette.cardRule, paddingBottom: 3, marginBottom: 10 },
  columnLabel: { fontSize: 12, fontWeight: '700', color: palette.text, letterSpacing: 0.4 },
  problemIcon: { width: PROBLEM_ICON, height: PROBLEM_ICON },
  problemName: { fontSize: 13, fontWeight: '700', color: palette.text, textAlign: 'center', marginTop: 6 },
  scales: { marginTop: 16 },
  problemText: { marginTop: 14 },
  attribution: { fontSize: 12, color: palette.textTertiary, textAlign: 'center', marginTop: 4, marginBottom: 8 },
});
