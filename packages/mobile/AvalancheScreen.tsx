import { useMemo, useState, type ReactNode } from 'react';
import { Platform, StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import MaterialCommunityIcons from '@expo/vector-icons/MaterialCommunityIcons';
import { SkiaPictureView, Skia, matchFont, type SkCanvas, type SkFont, type SkPicture, type SkSVG } from '@shopify/react-native-skia';
import { ASPECTS, type AvalancheForecast, type AvalancheProblem, type DangerDay, type Elevation } from '@weather/protocol';
import { DANGER_ICONS, DANGER_ICON_HEIGHT, type DangerIcon } from './dangerIcons';
import { drawText, fillPaint, strokePaint, textWidth } from './skiaPaint';
import { palette } from './palette';
import InfoModal from './components/InfoModal';
import Section from './components/Section';
import type { TimeFormat } from './settings';
import {
  CONFIDENCE_NAMES, DANGER_SCALE, DANGER_SCALE_INTRO, DISCLAIMERS, bulletinCenter, preparedBy, ELEVATION_NAMES, PROBLEM_NAMES, ROSE_ELEVATION_NAMES, dangerCell, dangerTables, likelihoodScale,
  sizeScale, stampLabel,
  type Scale,
} from './avalancheDisplay';

// The page's side inset and the cards' own padding: the graphics are drawn to the width left
// inside both, measured off the page.
const PAD = 16;
const CARD_PAD = 14;

interface Fonts { scale: SkFont; scaleBold: SkFont; compass: SkFont }

function useFonts(): Fonts {
  return useMemo(() => {
    // Android's Skia font manager doesn't know "System" (see Meteogram's fonts).
    const font = (style: Parameters<typeof matchFont>[0]) =>
      matchFont({ fontFamily: Platform.select({ android: 'sans-serif', default: 'System' }), ...style });
    return {
      scale: font({ fontSize: 13, fontWeight: '400' }),
      scaleBold: font({ fontSize: 13, fontWeight: '700' }),
      compass: font({ fontSize: 14, fontWeight: '400' }),
    };
  }, []);
}

function centered(canvas: SkCanvas, text: string, cx: number, baseline: number, font: SkFont, css: string): void {
  drawText(canvas, text, cx - textWidth(font, text) / 2, baseline, font, css);
}

// ── Danger ratings ───────────────────────────────────────────────────────────
// One table per forecast day, the way Avalanche Canada lays them out: a dark header naming the
// day, then a row per band, alpine on top. The band's cell wears its terrain color and the
// rating's cell its level's color, led by the level's NAPADS icon.

const BANDS: { key: keyof Pick<DangerDay, 'alp' | 'tln' | 'btl'>; fill: string }[] = [
  { key: 'alp', fill: '#ffffff' },
  { key: 'tln', fill: '#b9d22b' },
  { key: 'btl', fill: '#639a5e' },
];
const DAY_HEAD = '#141729';
const ICON_H = 26;
const SCALE_ICON_H = 40;
// Wide enough for the widest icon, so the ratings' text lines up whatever the level.
const iconSlot = (height: number) => height * Math.max(...Object.values(DANGER_ICONS).map((i) => i.width)) / DANGER_ICON_HEIGHT;
const ICON_SLOT = iconSlot(ICON_H);

const iconSvgs = new Map<DangerIcon, SkSVG>();
function iconSvg(icon: DangerIcon): SkSVG {
  let svg = iconSvgs.get(icon);
  if (!svg) {
    const parsed = Skia.SVG.MakeFromString(DANGER_ICONS[icon].svg);
    if (!parsed) throw new Error(`invalid danger icon: ${icon}`);
    svg = parsed;
    iconSvgs.set(icon, svg);
  }
  return svg;
}

// The SVGs size themselves in viewBox units, so the canvas scales them to the height, centered in
// the slot so each icon has the same room on either side.
const iconPictures = new Map<string, SkPicture>();
function iconPicture(icon: DangerIcon, height = ICON_H): SkPicture {
  const key = `${icon}:${height}`;
  let picture = iconPictures.get(key);
  if (!picture) {
    const slot = iconSlot(height);
    const recorder = Skia.PictureRecorder();
    const canvas = recorder.beginRecording(Skia.XYWHRect(0, 0, slot, height));
    const scale = height / DANGER_ICON_HEIGHT;
    canvas.translate((slot - DANGER_ICONS[icon].width * scale) / 2, 0);
    canvas.scale(scale, scale);
    canvas.drawSvg(iconSvg(icon));
    picture = recorder.finishRecordingAsPicture();
    iconPictures.set(key, picture);
  }
  return picture;
}

function DangerTable({ day, label }: { day: DangerDay; label: string }) {
  return (
    <View style={styles.dangerDay}>
      <Text style={styles.dangerDayLabel}>{label}</Text>
      {BANDS.map((band) => {
        const cell = dangerCell(day[band.key]);
        return (
          <View key={band.key} style={styles.dangerRow}>
            <View style={[styles.dangerBand, { backgroundColor: band.fill }]}>
              <Text style={styles.dangerBandText}>{ELEVATION_NAMES[band.key]}</Text>
            </View>
            <View style={[styles.dangerRating, { backgroundColor: cell.fill }]}>
              <SkiaPictureView style={styles.dangerIcon} picture={iconPicture(cell.icon)} />
              <Text style={[styles.dangerRatingText, { color: cell.text }]}>
                {cell.number ? `${cell.number} – ${cell.name}` : cell.name}
              </Text>
            </View>
          </View>
        );
      })}
    </View>
  );
}

// The scale behind the ratings' ⓘ: a row per level or status, led by a stripe in its color.
function DangerScale() {
  return (
    <>
      <Text style={[styles.prose, styles.scaleIntro]}>{DANGER_SCALE_INTRO}</Text>
      {DANGER_SCALE.map((entry) => {
        const cell = dangerCell(entry.rating);
        return (
          <View key={entry.rating} style={styles.scaleRow}>
            <View style={[styles.scaleStripe, { backgroundColor: cell.fill }]} />
            <View style={styles.scaleBody}>
              <View style={styles.scaleHead}>
                <SkiaPictureView style={styles.scaleIcon} picture={iconPicture(cell.icon, SCALE_ICON_H)} />
                <Text style={styles.scaleName}>{cell.number ? `${cell.number} – ${cell.name}` : cell.name}</Text>
              </View>
              {'description' in entry ? (
                <Text style={styles.prose}>{entry.description}</Text>
              ) : (
                <>
                  <Text style={[styles.prose, styles.scaleGapSmall]}>
                    <Text style={styles.bold}>{entry.lead}</Text> {entry.advice}
                  </Text>
                  <Text style={[styles.prose, styles.scaleGapSmall]}>
                    <Text style={styles.bold}>Likelihood:</Text> {entry.likelihood}
                  </Text>
                  <Text style={styles.prose}>
                    <Text style={styles.bold}>Size and distribution:</Text> {entry.size}
                  </Text>
                </>
              )}
            </View>
          </View>
        );
      })}
    </>
  );
}

// ── Problem graphics ─────────────────────────────────────────────────────────
// Avalanche Canada's problem card: the location rose on the left, the likelihood and size
// scales stacked on the right.

const PROBLEM_FILL = '#507baf';
const ROSE_LINE = '#d1d1d6';
const ROSE_EDGE = '#8e8e93';
const LEADER = '#8e8e93';
const RAD = Math.PI / 180;
// Each band's ring as fractions of the rose's radius, alpine at the center.
const RINGS: [Elevation, number, number][] = [['alp', 0, 1 / 3], ['tln', 1 / 3, 2 / 3], ['btl', 2 / 3, 1]];
// Where each band's leader starts: along a ray into the southwest wedge, one point per ring.
const LEADER_BEARING = 215;
const LEADER_AT: Record<Elevation, number> = { alp: 0.24, tln: 0.5, btl: 0.83 };
const LEADER_ROW_H = 18;

// A point at a bearing clockwise from north.
function polar(cx: number, cy: number, r: number, bearing: number): [number, number] {
  return [cx + r * Math.sin(bearing * RAD), cy - r * Math.cos(bearing * RAD)];
}

function roseRadius(W: number): number {
  return Math.min(W / 2 - 22, 64);
}

function roseLayout(W: number) {
  const R = roseRadius(W);
  const cy = 22 + R;
  const southY = cy + R + 14;
  const labelY = (i: number) => southY + 20 + i * LEADER_ROW_H;
  return { R, cx: W / 2, cy, southY, labelY, height: labelY(RINGS.length - 1) + 6 };
}

// Octagons with a flat side up, so each aspect is one wedge from the center to an edge and each
// band one ring. A cell fills where the problem sits at that aspect and band. Leaders run from
// each ring down to its band's name, stepping left so none crosses another's label.
function recordRose(problem: AvalancheProblem, W: number, fonts: Fonts): SkPicture {
  const { R, cx, cy, southY, labelY, height } = roseLayout(W);
  const recorder = Skia.PictureRecorder();
  const canvas = recorder.beginRecording(Skia.XYWHRect(0, 0, W, height));
  const fill = fillPaint(PROBLEM_FILL);
  for (const [band, r0, r1] of RINGS) {
    if (!problem.elevations.includes(band)) continue;
    ASPECTS.forEach((aspect, i) => {
      if (!problem.aspects.includes(aspect)) return;
      const a0 = i * 45 - 22.5, a1 = i * 45 + 22.5;
      const path = Skia.Path.Make();
      path.moveTo(...polar(cx, cy, R * r1, a0));
      path.lineTo(...polar(cx, cy, R * r1, a1));
      path.lineTo(...polar(cx, cy, R * r0, a1));
      path.lineTo(...polar(cx, cy, R * r0, a0));
      path.close();
      canvas.drawPath(path, fill);
    });
  }
  const line = strokePaint(ROSE_LINE, 1);
  for (let i = 0; i < 8; i++) {
    const [x, y] = polar(cx, cy, R, i * 45 + 22.5);
    canvas.drawLine(cx, cy, x, y, line);
  }
  for (const [, , r] of RINGS) {
    const path = Skia.Path.Make();
    for (let i = 0; i < 8; i++) {
      const [x, y] = polar(cx, cy, R * r, i * 45 + 22.5);
      if (i === 0) path.moveTo(x, y); else path.lineTo(x, y);
    }
    path.close();
    canvas.drawPath(path, r === 1 ? strokePaint(ROSE_EDGE, 1) : line);
  }

  const edge = R * Math.cos(22.5 * RAD);
  const ink = palette.text;
  centered(canvas, 'N', cx, cy - edge - 8, fonts.compass, ink);
  centered(canvas, 'S', cx, southY, fonts.compass, ink);
  drawText(canvas, 'E', cx + edge + 8, cy + 5, fonts.compass, ink);
  drawText(canvas, 'W', cx - edge - 8 - textWidth(fonts.compass, 'W'), cy + 5, fonts.compass, ink);

  const leader = strokePaint(LEADER, 1);
  const dot = fillPaint(LEADER);
  (['alp', 'tln', 'btl'] as const).forEach((band, i) => {
    const [x, y] = polar(cx, cy, R * LEADER_AT[band], LEADER_BEARING);
    const baseline = labelY(i);
    const elbow = baseline - 4;
    canvas.drawCircle(x, y, 1.75, dot);
    canvas.drawLine(x, y, x, elbow, leader);
    canvas.drawLine(x, elbow, x + 5, elbow, leader);
    drawText(canvas, ROSE_ELEVATION_NAMES[band], x + 8, baseline, fonts.scale, ink);
  });
  return recorder.finishRecordingAsPicture();
}

function Rose({ problem, width, fonts }: { problem: AvalancheProblem; width: number; fonts: Fonts }) {
  const picture = useMemo(() => recordRose(problem, width, fonts), [problem, width, fonts]);
  return <SkiaPictureView style={{ width, height: roseLayout(width).height }} picture={picture} />;
}

// A ruler with a tick per row, the bar over the covered rows, and each row's label beside it;
// notes sit in a second column after the widest label.
const SCALE_ROW_H = 20;
const SCALE_PAD = 10;
const RULER_X = 5;
const SCALE_TEXT_X = RULER_X + 12;

function scaleHeight(scale: Scale): number {
  return 2 * SCALE_PAD + (scale.rows.length - 1) * SCALE_ROW_H;
}

function recordScale(scale: Scale, W: number, fonts: Fonts): SkPicture {
  const recorder = Skia.PictureRecorder();
  const canvas = recorder.beginRecording(Skia.XYWHRect(0, 0, W, scaleHeight(scale)));
  const y = (row: number) => SCALE_PAD + row * SCALE_ROW_H;
  const line = strokePaint(ROSE_EDGE, 1);
  canvas.drawLine(RULER_X, y(0), RULER_X, y(scale.rows.length - 1), line);
  scale.rows.forEach((_, r) => canvas.drawLine(RULER_X - 4, y(r), RULER_X + 4, y(r), line));
  const [top, bottom] = scale.bar;
  canvas.drawRect(Skia.XYWHRect(RULER_X - 4, y(top), 8, y(bottom) - y(top)), fillPaint(PROBLEM_FILL));
  const font = (bold: boolean) => (bold ? fonts.scaleBold : fonts.scale);
  scale.rows.forEach((row, r) => drawText(canvas, row.label, SCALE_TEXT_X, y(r) + 4.5, font(row.bold), palette.text));
  const noteX = SCALE_TEXT_X + Math.max(...scale.rows.map((row) => textWidth(fonts.scaleBold, row.label))) + 5;
  for (const note of scale.notes) drawText(canvas, note.label, noteX, y(note.at) + 4.5, font(note.bold), palette.text);
  return recorder.finishRecordingAsPicture();
}

function ScaleView({ scale, width, fonts }: { scale: Scale; width: number; fonts: Fonts }) {
  const picture = useMemo(() => recordScale(scale, width, fonts), [scale, width, fonts]);
  return <SkiaPictureView style={{ width, height: scaleHeight(scale) }} picture={picture} />;
}

function ColumnLabel({ label }: { label: string }) {
  return (
    <View style={styles.columnLabel}>
      <Text style={styles.columnLabelText}>{label}</Text>
    </View>
  );
}

const PROBLEM_GAP = 16;

function ProblemCard({ problem, index, width, fonts }: { problem: AvalancheProblem; index: number; width: number; fonts: Fonts }) {
  const likelihood = useMemo(() => likelihoodScale(problem.likelihood), [problem.likelihood]);
  const size = useMemo(() => sizeScale(problem.size), [problem.size]);
  const roseW = Math.floor((width - PROBLEM_GAP) * 0.55);
  const scaleW = width - PROBLEM_GAP - roseW;
  return (
    <View style={styles.problem}>
      <Text style={styles.problemHead}>{`Problem ${index + 1}: ${PROBLEM_NAMES[problem.type]}`}</Text>
      <View style={styles.problemBody}>
        {width > 0 && (
          <View style={styles.problemColumns}>
            <View style={{ width: roseW }}>
              <ColumnLabel label="Location" />
              <Rose problem={problem} width={roseW} fonts={fonts} />
            </View>
            <View style={{ width: scaleW }}>
              <ColumnLabel label="Likelihood" />
              <ScaleView scale={likelihood} width={scaleW} fonts={fonts} />
              <View style={styles.scaleGap} />
              <ColumnLabel label="Size" />
              <ScaleView scale={size} width={scaleW} fonts={fonts} />
            </View>
          </View>
        )}
        {problem.description ? <View style={styles.problemText}><Prose text={problem.description} /></View> : null}
      </View>
    </View>
  );
}

// ── Page ─────────────────────────────────────────────────────────────────────

function Stamp({ label, value }: { label: string; value: string }) {
  return (
    <View style={styles.stampColumn}>
      <Text style={styles.stampLabel}>{label}</Text>
      <Text style={styles.stampValue}>{value}</Text>
    </View>
  );
}

// A Section whose label opens and closes it. Starts closed.
function CollapsibleSection({ label, children }: { label: string; children: ReactNode }) {
  const [open, setOpen] = useState(false);
  return (
    <View style={styles.section}>
      <TouchableOpacity
        style={[styles.sectionToggle, open && styles.sectionToggleOpen]}
        onPress={() => setOpen((o) => !o)}
        activeOpacity={0.7}
        accessibilityRole="button"
        accessibilityState={{ expanded: open }}
      >
        <Text style={[styles.sectionLabel, styles.sectionLabelToggle]}>{label}</Text>
        <MaterialCommunityIcons name={open ? 'chevron-up' : 'chevron-down'} size={18} color={palette.pageLabel} />
      </TouchableOpacity>
      {open && children}
    </View>
  );
}

function Card({ children }: { children: ReactNode }) {
  return <View style={styles.card}>{children}</View>;
}

// Paragraphs are blank-line separated; single line breaks stay inside a paragraph.
function Prose({ text, lead = false }: { text: string; lead?: boolean }) {
  const paragraphs = text.split(/\n\n+/).filter(Boolean);
  return (
    <>
      {paragraphs.map((p, i) => (
        <Text key={i} style={[styles.prose, lead && styles.proseLead, i < paragraphs.length - 1 && styles.proseGap]}>{p}</Text>
      ))}
    </>
  );
}

function Bullets({ items }: { items: string[] }) {
  return (
    <>
      {items.map((item, i) => (
        <View key={i} style={[styles.bulletRow, i < items.length - 1 && styles.proseGap]}>
          <Text style={styles.bullet}>•</Text>
          <Text style={[styles.prose, styles.bulletText]}>{item}</Text>
        </View>
      ))}
    </>
  );
}

// `region` names where the bulletin was requested for.
export default function AvalancheForecastView({ forecast, region, timeFormat }: {
  forecast: AvalancheForecast; region: string; timeFormat: TimeFormat;
}) {
  const fonts = useFonts();
  // The page's width, measured on layout; the pictures draw to what is left inside a card.
  const [pageW, setPageW] = useState(0);
  const [scaleInfo, setScaleInfo] = useState(false);
  const graphicW = pageW - 2 * PAD - 2 * CARD_PAD;
  const stamp = (ms: number) => stampLabel(ms, forecast.timezone, timeFormat);
  const disclaimer = DISCLAIMERS[bulletinCenter(forecast)];
  return (
    <View style={styles.page} onLayout={(e) => setPageW(e.nativeEvent.layout.width)}>
      {forecast.expires < Date.now() && (
        <View style={styles.expired}>
          <MaterialCommunityIcons name="alert" size={20} color={palette.warning} />
          <Text style={styles.expiredText}>This forecast is no longer valid</Text>
          <MaterialCommunityIcons name="alert" size={20} color={palette.warning} />
        </View>
      )}
      <View style={styles.stamps}>
        <Stamp label="Date issued" value={stamp(forecast.issued)} />
        <Stamp label="Valid until" value={stamp(forecast.expires)} />
      </View>
      <View style={[styles.stamps, styles.stampsLast]}>
        <Stamp label="Prepared by" value={preparedBy(forecast)} />
        {region ? <Stamp label="Region" value={region} /> : <View style={styles.stampColumn} />}
      </View>

      {forecast.bottomLine ? (
        <View style={styles.section}><Card><Prose text={forecast.bottomLine} lead /></Card></View>
      ) : null}

      <Section label="Danger Ratings" info={() => setScaleInfo(true)}>
        {dangerTables(forecast).map((t) => <DangerTable key={t.key} day={t.day} label={t.label} />)}
      </Section>
      <InfoModal visible={scaleInfo} title="Avalanche Danger Scale" onClose={() => setScaleInfo(false)}>
        <DangerScale />
      </InfoModal>

      {forecast.advice.length > 0 && (
        <Section label="Terrain and Travel Advice"><Card><Bullets items={forecast.advice} /></Card></Section>
      )}

      <Section label="Avalanche Problems">
        {forecast.problems.length > 0
          ? forecast.problems.map((p, i) => <ProblemCard key={i} problem={p} index={i} width={graphicW} fonts={fonts} />)
          : <Card><Prose text="No problems identified." /></Card>}
      </Section>

      {forecast.avalancheSummary ? (
        <Section label="Avalanche Summary"><Card><Prose text={forecast.avalancheSummary} /></Card></Section>
      ) : null}
      {forecast.snowpackSummary ? (
        <Section label="Snowpack Summary"><Card><Prose text={forecast.snowpackSummary} /></Card></Section>
      ) : null}

      {forecast.weather.length > 0 && (
        <Section label="Weather Summary">
          <Card>
            {forecast.weather.map((w, i) => (
              <View key={i} style={i < forecast.weather.length - 1 && styles.proseGap}>
                {w.label ? <Text style={styles.weatherLabel}>{w.label}</Text> : null}
                <Prose text={w.text} />
              </View>
            ))}
          </Card>
        </Section>
      )}

      <Section label="Confidence">
        <Card>
          <Text style={[styles.prose, styles.confidence, forecast.confidence.statements.length > 0 && styles.proseGap]}>
            {CONFIDENCE_NAMES[forecast.confidence.rating]}
          </Text>
          {forecast.confidence.statements.length > 0 && <Bullets items={forecast.confidence.statements} />}
        </Card>
      </Section>

      {disclaimer && (
        <CollapsibleSection label="Forecast Disclaimer">
          <Card>
            {disclaimer.map((p, i, all) => (
              <Text key={i} style={[styles.prose, i < all.length - 1 && styles.proseGap]}>{p}</Text>
            ))}
          </Card>
        </CollapsibleSection>
      )}

      <Text style={styles.attribution}>Avalanche forecast provided by Avalanche Canada.</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  page: { paddingHorizontal: PAD },
  expired: {
    flexDirection: 'row', alignItems: 'center', gap: 8, marginBottom: 12,
    padding: 12, backgroundColor: palette.warningTint, borderRadius: 10, borderWidth: 1, borderColor: palette.warning,
  },
  expiredText: { flex: 1, color: palette.warning, fontSize: 14, fontWeight: '600', lineHeight: 20, textAlign: 'center' },
  stamps: { flexDirection: 'row', gap: 16, marginBottom: 10 },
  stampsLast: { marginBottom: 20 },
  stampColumn: { flex: 1 },
  stampLabel: { fontSize: 12, fontWeight: '700', color: palette.brand, textTransform: 'uppercase', letterSpacing: 0.3, marginBottom: 2 },
  stampValue: { fontSize: 12, fontWeight: '600', color: palette.pageTextSecondary, textTransform: 'uppercase', letterSpacing: 0.3, lineHeight: 17 },
  section: { marginBottom: 20 },
  sectionToggle: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  sectionToggleOpen: { marginBottom: 8 },
  sectionLabelToggle: { marginBottom: 0 },
  sectionLabel: { fontSize: 12, fontWeight: '600', color: palette.pageLabel, textTransform: 'uppercase', letterSpacing: 0.5, marginBottom: 8 },
  card: { backgroundColor: palette.card, borderRadius: 12, padding: CARD_PAD },
  prose: { fontSize: 15, color: palette.textBody, lineHeight: 22 },
  proseLead: { fontSize: 18, lineHeight: 25, fontWeight: '700', color: palette.text, textAlign: 'center' },
  proseGap: { marginBottom: 10 },
  bulletRow: { flexDirection: 'row', gap: 8 },
  bullet: { fontSize: 15, lineHeight: 22, color: palette.textSecondary },
  bulletText: { flex: 1 },
  problem: { borderRadius: 12, overflow: 'hidden', marginBottom: 10, backgroundColor: palette.card },
  problemHead: { backgroundColor: DAY_HEAD, color: '#ffffff', fontSize: 17, fontWeight: '400', paddingHorizontal: CARD_PAD, paddingVertical: 12 },
  problemBody: { padding: CARD_PAD },
  problemColumns: { flexDirection: 'row', gap: PROBLEM_GAP },
  problemText: { marginTop: 12 },
  columnLabel: { borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: palette.cardRule, paddingBottom: 5, marginBottom: 6 },
  columnLabelText: { fontSize: 12, fontWeight: '700', color: palette.text, textTransform: 'uppercase', letterSpacing: 0.5 },
  scaleGap: { height: 10 },
  weatherLabel: { fontSize: 15, fontWeight: '700', color: palette.text, lineHeight: 22 },
  confidence: { fontWeight: '600', color: palette.text },
  dangerDay: { borderRadius: 12, overflow: 'hidden', marginBottom: 10, backgroundColor: '#ffffff' },
  dangerDayLabel: { backgroundColor: DAY_HEAD, color: '#ffffff', fontSize: 17, fontWeight: '600', paddingHorizontal: 14, paddingVertical: 12 },
  dangerRow: { flexDirection: 'row', minHeight: 46, marginTop: 2 },
  // Room for "Below Treeline" and no more, so the longest status fits the rating cell on one line.
  dangerBand: { width: 136, justifyContent: 'center', paddingHorizontal: 14, marginRight: 2 },
  dangerBandText: { fontSize: 15, color: '#1c1c1e' },
  dangerRating: { flex: 1, flexDirection: 'row', alignItems: 'center', paddingHorizontal: 8, gap: 8 },
  dangerIcon: { width: ICON_SLOT, height: ICON_H },
  dangerRatingText: { flex: 1, fontSize: 15, fontWeight: '700' },
  bold: { fontWeight: '700', color: palette.text },
  scaleIntro: { marginBottom: 16 },
  scaleRow: {
    flexDirection: 'row', paddingVertical: 14,
    borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: palette.cardRule,
  },
  // White statuses need an edge to show against the sheet.
  scaleStripe: { width: 8, marginRight: 12, borderWidth: StyleSheet.hairlineWidth, borderColor: palette.cardRule },
  scaleBody: { flex: 1 },
  scaleHead: { flexDirection: 'row', alignItems: 'center', gap: 10, marginBottom: 8 },
  scaleIcon: { width: iconSlot(SCALE_ICON_H), height: SCALE_ICON_H },
  scaleName: { flex: 1, fontSize: 17, fontWeight: '700', color: palette.text },
  scaleGapSmall: { marginBottom: 6 },
  attribution: { fontSize: 12, color: palette.textTertiary, textAlign: 'center', marginTop: 4, marginBottom: 8 },
});
