import { useEffect, useMemo, useState } from 'react';
import { Image, StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import MaterialCommunityIcons from '@expo/vector-icons/MaterialCommunityIcons';
import { SkiaPictureView, Skia, StrokeJoin, type SkPicture } from '@shopify/react-native-skia';
import { AVALANCHE_PIECES, ELEVATIONS, type AvalancheForecast, type AvalancheProblem, type DangerDay, type Elevation, type ProblemType } from '@weather/protocol';
import { CARD_PAD, Card, DangerScale, PAD, ProblemHead, Prose, Rose, ScaleView, StampGrid, roseOctagon, type ScaleStyle, iconPicture, iconSlot, useFonts, type Fonts } from './AvalancheScreen';
import InfoModal from './components/InfoModal';
import Section from './components/Section';
import WarningBanner from './components/WarningBanner';
import { dangerCell, highestDanger, likelihoodScale, dayLabel, nacBandLabel, nacProblemNames, nacSizeScale, nacZonePiece, preparedBy, stampLabel, zoneNames } from './avalancheDisplay';
import { fillPaint, strokePaint } from './skiaPaint';
import { palette } from './palette';
import { loadHideExpiredBanner, type TimeFormat } from './settings';

// An avalanche.org center's forecast laid out the way the center's site lays it out (nwac.us and
// the rest share avalanche.org's forecast widget), narrowed to a phone: the days stack, the second collapsible, and
// the problem graphics take two rows rather than four columns.

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
// A shade darker than the band rows it is drawn on.
const PYRAMID_BORDER = '#cfd2d7';
const ROSE_FILL = '#c9cbd0';
const ROSE_LINE = '#58595b';
const ROSE_STYLE = { fill: ROSE_FILL, line: ROSE_LINE };
const SCALE_TEXT_MUTED = '#a3a6ab';
// avalanche.org's scales: both rulers the same length, wide ticks, the bar hugging the exact range.
const SCALE_STYLE: ScaleStyle = {
  fill: ROSE_FILL, stroke: ROSE_LINE, muted: SCALE_TEXT_MUTED, lineWidth: 1.5,
  span: 126, tick: 11, gap: 20, barPad: 3, centered: true,
};
const NO_LEVEL_FILL = '#d9dbdf';
const ROW_GAP = 4;
// The day's highest danger, centered over the bottom line's text.
const CORNER_ICON = 46;
const CARD_RADIUS = 12;
// How far below the top of its row the pyramid's tip sits.
const PYRAMID_TOP = 8;
const COLUMN_GAP = 12;
// Pulls the problem icon and rose up toward their column labels.
const GRAPHIC_LIFT = 6;

// Upper band on top, where the pyramid's tip is.
const BANDS_TOP_DOWN = [...ELEVATIONS].reverse();

function recordPyramid(day: DangerDay, W: number, rowH: number, cx: number, baseHalf: number, corner: number): SkPicture {
  const H = 3 * rowH + 2 * ROW_GAP;
  const recorder = Skia.PictureRecorder();
  const canvas = recorder.beginRecording(Skia.XYWHRect(0, 0, W, H));
  const half = (y: number) => ((y - PYRAMID_TOP) / (H - PYRAMID_TOP)) * baseHalf;
  BANDS_TOP_DOWN.forEach((band, i) => {
    const rowY = i * (rowH + ROW_GAP), y1 = rowY + rowH;
    const y0 = Math.max(rowY, PYRAMID_TOP);
    canvas.drawRect(Skia.XYWHRect(0, rowY, W, rowH), fillPaint(BAND_FILL));
    const cell = dangerCell(day[band]);
    const path = Skia.Path.Make();
    path.moveTo(cx - half(y0), y0);
    path.lineTo(cx + half(y0), y0);
    path.lineTo(cx + half(y1), y1);
    path.lineTo(cx - half(y1), y1);
    path.close();
    canvas.drawPath(path, fillPaint(cell.fill === '#ffffff' ? NO_LEVEL_FILL : cell.fill));
    // The border, half its width inside the band so the row's edges don't clip it.
    const b0 = y0 + 0.5, b1 = y1 - 0.5;
    const border = Skia.Path.Make();
    border.moveTo(cx - half(b0), b0);
    border.lineTo(cx + half(b0), b0);
    border.lineTo(cx + half(b1), b1);
    border.lineTo(cx - half(b1), b1);
    border.close();
    canvas.drawPath(border, strokePaint(PYRAMID_BORDER, 1, undefined, StrokeJoin.Round));
  });
  // The border around the rows, half its width inside so the view doesn't clip it. Its bottom
  // corners round by `corner` to follow a card's.
  const e = 0.5, r = Math.max(0, corner - e);
  const frame = Skia.Path.Make();
  frame.moveTo(e, e);
  frame.lineTo(W - e, e);
  frame.lineTo(W - e, H - e - r);
  frame.arcToTangent(W - e, H - e, W - e - r, H - e, r);
  frame.lineTo(e + r, H - e);
  frame.arcToTangent(e, H - e, e, H - e - r, r);
  frame.close();
  canvas.drawPath(frame, strokePaint(PYRAMID_BORDER, 1));
  return recorder.finishRecordingAsPicture();
}

const ratingText = (band: Elevation, day: DangerDay) => {
  const cell = dangerCell(day[band]);
  return cell.number ? `${cell.number} - ${cell.name}` : cell.name;
};

// A day: a gray row per band, its elevations on a chip, over the pyramid. Reaches out through
// the card padding to the edges of the card, so `width` is the inner width. `last` is the day at the
// card's bottom edge.
function ForecastDay({ day, zone, width: inner, last }: { day: DangerDay; zone: number | null; width: number; last: boolean }) {
  const rowH = 60;
  const width = inner + 2 * CARD_PAD;
  const picture = useMemo(() => recordPyramid(day, width, rowH, width * 0.27, width * 0.22, last ? CARD_RADIUS : 0), [day, width, last]);
  const iconH = 34;
  return (
    <View style={{ height: 3 * rowH + 2 * ROW_GAP, marginHorizontal: -CARD_PAD }}>
      <SkiaPictureView style={StyleSheet.absoluteFill} picture={picture} />
      {BANDS_TOP_DOWN.map((band, i) => {
        const label = nacBandLabel(zone, band);
        return (
          <View key={band} style={[styles.bandRow, { top: i * (rowH + ROW_GAP), height: rowH }]}>
            <View style={styles.chip}>
              {label.name ? <Text style={styles.chipText}>{label.name}</Text> : null}
              {label.range ? <Text style={styles.chipText}>{label.range}</Text> : null}
            </View>
            <Text style={[styles.rating, { left: width * 0.51, width: width * 0.49 - iconSlot(iconH) * 0.55 }]} numberOfLines={2}>{ratingText(band, day)}</Text>
            <SkiaPictureView style={[styles.bandIcon, { width: iconSlot(iconH), height: iconH, top: (rowH - iconH) / 2 }]} picture={iconPicture(dangerCell(day[band]).icon, iconH)} />
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

// Two equal columns over two rows: type and rose, then likelihood and size.
function ProblemCard({ problem, index, width, fonts }: { problem: AvalancheProblem; index: number; width: number; fonts: Fonts }) {
  const name = nacProblemNames[problem.type];
  const likelihood = useMemo(() => likelihoodScale(problem.likelihood, 0), [problem.likelihood]);
  const size = useMemo(() => nacSizeScale(problem.size), [problem.size]);
  const cellW = (width - COLUMN_GAP) / 2;
  // The icon spans the rose's octagon, top edge to bottom edge.
  const { top: iconTop, height: icon } = roseOctagon(cellW, ROSE_STYLE);
  return (
    <View style={styles.problem}>
      <ProblemHead index={index} name={name} />
      <View style={styles.problemBody}>
        <View style={styles.columns}>
          <View style={[styles.cell, { width: cellW }]}>
            <ColumnLabel label="PROBLEM TYPE" />
            <Image source={PROBLEM_ICONS[problem.type]} style={{ width: icon, height: icon, marginTop: iconTop - GRAPHIC_LIFT }} accessibilityLabel={name} />
            <Text style={styles.problemName}>{name}</Text>
          </View>
          <View style={[styles.cell, { width: cellW }]}>
            <ColumnLabel label="ASPECT/ELEVATION" />
            <View style={styles.rose}><Rose problem={problem} width={cellW} fonts={fonts} style={ROSE_STYLE} /></View>
          </View>
        </View>
        <View style={[styles.columns, styles.scales]}>
          <View style={{ width: cellW }}>
            <ColumnLabel label="LIKELIHOOD" />
            <ScaleView scale={likelihood} width={cellW} fonts={fonts} style={SCALE_STYLE} />
          </View>
          <View style={{ width: cellW }}>
            <ColumnLabel label="SIZE" />
            <ScaleView scale={size} width={cellW} fonts={fonts} style={SCALE_STYLE} />
          </View>
        </View>
        {problem.description ? <View style={styles.problemText}><Prose text={problem.description} /></View> : null}
      </View>
    </View>
  );
}

// `requested` is the piece the bulletin was requested in, whose zone it is shown for.
export default function NacForecastView({ forecast, requested, timeFormat }: {
  forecast: AvalancheForecast; requested: number | null; timeFormat: TimeFormat;
}) {
  const fonts = useFonts();
  const [pageW, setPageW] = useState(0);
  const [scaleInfo, setScaleInfo] = useState(false);
  const [outlookOpen, setOutlookOpen] = useState(true);
  const [hideExpired, setHideExpired] = useState(false);
  useEffect(() => { loadHideExpiredBanner().then(setHideExpired); }, []);
  // What is left inside a card.
  const width = pageW - 2 * PAD - 2 * CARD_PAD;
  const zone = nacZonePiece(forecast, requested);
  const zonePiece = zone === null ? null : AVALANCHE_PIECES[zone];
  const stamp = (ms: number) => stampLabel(ms, forecast.timezone, timeFormat);
  const [today, outlook] = forecast.danger;
  const corner = today && dangerCell(highestDanger(today)).number ? dangerCell(highestDanger(today)).icon : null;
  return (
    <View style={styles.page} onLayout={(e) => setPageW(e.nativeEvent.layout.width)}>
      {forecast.expires < Date.now() && !hideExpired && (
        <WarningBanner>This forecast is no longer valid</WarningBanner>
      )}
      <StampGrid
        rows={[
          [['Issued', stamp(forecast.issued)], ['Expires', stamp(forecast.expires)]],
          [['Zone', zonePiece ? zoneNames(zonePiece) : null], ['Author', forecast.author]],
        ]}
      />

      {forecast.bottomLine ? (
        <View style={styles.bottomLine}>
          <Card>
            {corner && <SkiaPictureView style={[styles.cornerIcon, { width: iconSlot(CORNER_ICON) }]} picture={iconPicture(corner, CORNER_ICON)} />}
            <Prose text={forecast.bottomLine} />
          </Card>
        </View>
      ) : null}

      {today && width > 0 && (
        <Section label="Avalanche Danger" info={() => setScaleInfo(true)}>
          {/* The last day's rows run to the card's bottom edge; the card clips them to its corners. */}
          <View style={[styles.dangerCard, (!outlook || outlookOpen) && styles.dangerCardFlush]}>
            <Text style={styles.dayLabel}>{dayLabel(today.date)}</Text>
            <ForecastDay day={today} zone={zone} width={width} last={!outlook} />
            {outlook && (
              <>
                <TouchableOpacity
                  style={[styles.nextDay, !outlookOpen && styles.nextDayClosed]}
                  onPress={() => setOutlookOpen((o) => !o)}
                  accessibilityRole="button"
                  accessibilityState={{ expanded: outlookOpen }}
                >
                  <Text style={styles.nextDayLabel}>{dayLabel(outlook.date)}</Text>
                  <MaterialCommunityIcons name={outlookOpen ? 'chevron-up' : 'chevron-down'} size={24} color={palette.text} />
                </TouchableOpacity>
                {outlookOpen && <ForecastDay day={outlook} zone={zone} width={width} last />}
              </>
            )}
          </View>
          <InfoModal visible={scaleInfo} title="Avalanche Danger Scale" onClose={() => setScaleInfo(false)}>
            <DangerScale />
          </InfoModal>
        </Section>
      )}

      {today && width > 0 && (
        <Section label={`Avalanche Problems (${forecast.problems.length})`}>
          {forecast.problems.map((p, i) => <ProblemCard key={i} problem={p} index={i} width={width} fonts={fonts} />)}
        </Section>
      )}

      {forecast.hazardDiscussion ? (
        <Section label="Forecast Discussion"><Card><Prose text={forecast.hazardDiscussion} /></Card></Section>
      ) : null}

      <Text style={styles.attribution}>{`Avalanche forecast provided by ${preparedBy(forecast)}`}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  page: { paddingHorizontal: PAD },
  bottomLine: { marginBottom: 20 },
  cornerIcon: { alignSelf: 'center', height: CORNER_ICON, marginBottom: 10 },
  bandRow: { position: 'absolute', left: 0, right: 0, justifyContent: 'center' },
  chip: { position: 'absolute', left: 1, backgroundColor: '#ffffff', borderWidth: 1, borderLeftWidth: 0, borderColor: PYRAMID_BORDER, borderTopRightRadius: 3, borderBottomRightRadius: 3, paddingHorizontal: 5, paddingVertical: 3 },
  chipText: { fontSize: 11, lineHeight: 15, fontWeight: '500', color: '#6b6e73' },
  dangerCard: { backgroundColor: palette.card, borderRadius: CARD_RADIUS, padding: CARD_PAD, overflow: 'hidden' },
  dangerCardFlush: { paddingBottom: 0 },
  dayLabel: { fontSize: 16, lineHeight: 24, fontWeight: '600', color: palette.text, marginBottom: CARD_PAD },
  nextDay: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingVertical: CARD_PAD },
  nextDayClosed: { paddingBottom: 0 },
  nextDayLabel: { fontSize: 16, fontWeight: '600', color: palette.text },
  rating: { position: 'absolute', fontSize: 15, fontWeight: '700', color: palette.text },
  bandIcon: { position: 'absolute', right: 0 },
  problem: { backgroundColor: palette.card, borderRadius: 12, overflow: 'hidden', marginBottom: 10 },
  problemBody: { padding: CARD_PAD },
  columns: { flexDirection: 'row', gap: COLUMN_GAP },
  cell: { alignItems: 'center' },
  columnHead: { alignSelf: 'center', borderBottomWidth: 1, borderBottomColor: palette.cardRule, paddingBottom: 3, marginBottom: 10 },
  columnLabel: { fontSize: 12, fontWeight: '700', color: palette.text, letterSpacing: 0.4 },
  problemName: { fontSize: 13, fontWeight: '700', color: palette.text, textAlign: 'center', marginTop: 6 },
  rose: { marginTop: -GRAPHIC_LIFT },
  scales: { marginTop: 26, marginBottom: 10 },
  problemText: { marginTop: 14 },
  attribution: { fontSize: 12, color: palette.textTertiary, textAlign: 'center', marginTop: 4, marginBottom: 8 },
});
