import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { Platform, StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import MaterialCommunityIcons from '@expo/vector-icons/MaterialCommunityIcons';
import { SkiaPictureView, Skia, matchFont, type SkCanvas, type SkFont, type SkPicture, type SkSVG } from '@shopify/react-native-skia';
import { ASPECTS, coversCell, type AvalancheForecast, type AvalancheProblem, type DangerDay, type Elevation } from '@weather/protocol';
import { DANGER_ICONS, DANGER_ICON_HEIGHT, type DangerIcon } from './dangerIcons';
import { drawText, fillPaint, strokePaint, textWidth } from './skiaPaint';
import { palette } from './palette';
import InfoModal from './components/InfoModal';
import WarningBanner from './components/WarningBanner';
import Section from './components/Section';
import { loadHideExpiredBanner, type TimeFormat } from './settings';
import {
  CONFIDENCE_NAMES, DANGER_SCALE, DANGER_SCALE_INTRO, DISCLAIMERS, bulletinCenter, preparedBy, ELEVATION_NAMES, PROBLEM_NAMES, ROSE_ELEVATION_NAMES, dangerCell, dangerTables, likelihoodScale,
  sizeScale, stampLabel,
  type Scale,
} from './avalancheDisplay';

// The page's side inset and the cards' own padding: the graphics are drawn to the width left
// inside both, measured off the page.
export const PAD = 16;
export const CARD_PAD = 14;

export interface Fonts { scale: SkFont; scaleBold: SkFont; compass: SkFont; small: SkFont }

export function useFonts(): Fonts {
  return useMemo(() => {
    // Android's Skia font manager doesn't know "System" (see Meteogram's fonts).
    const font = (style: Parameters<typeof matchFont>[0]) =>
      matchFont({ fontFamily: Platform.select({ android: 'sans-serif', default: 'System' }), ...style });
    return {
      scale: font({ fontSize: 13, fontWeight: '400' }),
      scaleBold: font({ fontSize: 13, fontWeight: '700' }),
      compass: font({ fontSize: 14, fontWeight: '400' }),
      small: font({ fontSize: 11, fontWeight: '400' }),
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
export const iconSlot = (height: number) => height * Math.max(...Object.values(DANGER_ICONS).map((i) => i.width)) / DANGER_ICON_HEIGHT;
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
export function iconPicture(icon: DangerIcon, height = ICON_H): SkPicture {
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
export function DangerScale() {
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

// Room outside the rose's edge for a compass letter.
const COMPASS_GAP = 14;
const COMPASS_POINTS = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'];

function roseLayout(W: number, style: RoseStyle) {
  if (!style.labels) {
    // Eight compass letters around the edge, the widest ("NW") level with the corners.
    const R = Math.min((W / 2 - COMPASS_GAP - 12) / Math.cos(22.5 * RAD), 64);
    const edge = R * Math.cos(22.5 * RAD);
    const cy = edge + COMPASS_GAP + 14;
    return { R, cx: W / 2, cy, southY: cy + edge + COMPASS_GAP + 4, labelY: () => 0, height: cy + edge + COMPASS_GAP + 12 };
  }
  const R = roseRadius(W);
  const cy = 22 + R;
  const southY = cy + R + 14;
  const labelY = (i: number) => southY + 20 + i * LEADER_ROW_H;
  return { R, cx: W / 2, cy, southY, labelY, height: labelY(RINGS.length - 1) + 6 };
}

// How a center draws its rose: the covered cells' color, the bands' names on leaders (or none,
// with all eight compass points around the edge instead), and one color for every line.
export interface RoseStyle { fill: string; labels?: Record<Elevation, string>; line?: string }
const STANDARD_ROSE: RoseStyle = { fill: PROBLEM_FILL, labels: ROSE_ELEVATION_NAMES };

// Octagons with a flat side up, so each aspect is one wedge from the center to an edge and each
// band one ring. A cell fills where the problem sits at that aspect and band. Leaders run from
// each ring down to its band's name, stepping left so none crosses another's label.
function recordRose(problem: AvalancheProblem, W: number, fonts: Fonts, style: RoseStyle): SkPicture {
  const { R, cx, cy, southY, labelY, height } = roseLayout(W, style);
  const recorder = Skia.PictureRecorder();
  const canvas = recorder.beginRecording(Skia.XYWHRect(0, 0, W, height));
  const fill = fillPaint(style.fill);
  for (const [band, r0, r1] of RINGS) {
    ASPECTS.forEach((aspect, i) => {
      if (!coversCell(problem, aspect, band)) return;
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
  const line = strokePaint(style.line ?? ROSE_LINE, 1);
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
    canvas.drawPath(path, r === 1 ? strokePaint(style.line ?? ROSE_EDGE, 1) : line);
  }

  const edge = R * Math.cos(22.5 * RAD);
  const ink = palette.text;
  const labels = style.labels;
  if (!labels) {
    COMPASS_POINTS.forEach((point, i) => {
      const [x, y] = polar(cx, cy, edge + COMPASS_GAP, i * 45);
      centered(canvas, point, x, y + 5, fonts.compass, ink);
    });
    return recorder.finishRecordingAsPicture();
  }
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
    drawText(canvas, labels[band], x + 8, baseline, fonts.scale, ink);
  });
  return recorder.finishRecordingAsPicture();
}

// The octagon's flat top edge, below the top of the rose's view, and its height.
export function roseOctagon(width: number, style: RoseStyle = STANDARD_ROSE): { top: number; height: number } {
  const { R, cy } = roseLayout(width, style);
  const edge = R * Math.cos(22.5 * RAD);
  return { top: cy - edge, height: 2 * edge };
}

export function Rose({ problem, width, fonts, style = STANDARD_ROSE }: { problem: AvalancheProblem; width: number; fonts: Fonts; style?: RoseStyle }) {
  const picture = useMemo(() => recordRose(problem, width, fonts, style), [problem, width, fonts, style]);
  return <SkiaPictureView style={{ width, height: roseLayout(width, style).height }} picture={picture} />;
}

// A ruler with a tick per row, the bar over the covered rows, and each row's label beside it;
// notes sit in a second column after the widest label.
const SCALE_ROW_H = 20;
const SCALE_PAD = 10;
const RULER_X = 5;
const SCALE_TEXT_X = RULER_X + 12;

// How a center draws its scales: the bar's color, the color of its outline and the ruler, and the color
// of uncovered rows. `span` fixes the ruler's length whatever the row count, `tick` is the half width
// of the ticks and the bar, `gap` the space from the ruler to the labels, `barPad` how far the bar
// reaches past its ends, and `centered` centers the ruler and labels in the width.
export interface ScaleStyle {
  fill: string; stroke?: string; muted?: string; lineWidth?: number;
  span?: number; tick?: number; gap?: number; barPad?: number; centered?: boolean;
}
const STANDARD_SCALE: ScaleStyle = { fill: PROBLEM_FILL };

function rowStep(scale: Scale, style: ScaleStyle): number {
  return style.span !== undefined ? style.span / (scale.rows.length - 1) : SCALE_ROW_H;
}

function scaleHeight(scale: Scale, style: ScaleStyle): number {
  return 2 * SCALE_PAD + (scale.rows.length - 1) * rowStep(scale, style);
}

function recordScale(scale: Scale, W: number, fonts: Fonts, style: ScaleStyle): SkPicture {
  const recorder = Skia.PictureRecorder();
  const canvas = recorder.beginRecording(Skia.XYWHRect(0, 0, W, scaleHeight(scale, style)));
  const step = rowStep(scale, style);
  const y = (row: number) => SCALE_PAD + row * step;
  const tick = style.tick ?? 4;
  const textGap = style.gap ?? SCALE_TEXT_X - RULER_X;
  const labelsW = Math.max(...scale.rows.map((row) => textWidth(fonts.scaleBold, row.label)));
  const rulerX = style.centered ? Math.max(tick, (W - tick - textGap - labelsW) / 2 + tick) : RULER_X;
  const textX = rulerX + textGap;
  const line = strokePaint(style.stroke ?? ROSE_EDGE, style.lineWidth ?? 1);
  canvas.drawLine(rulerX, y(0), rulerX, y(scale.rows.length - 1), line);
  scale.rows.forEach((_, r) => canvas.drawLine(rulerX - tick, y(r), rulerX + tick, y(r), line));
  const [top, bottom] = scale.bar;
  const pad = style.barPad ?? 0;
  const bar = Skia.XYWHRect(rulerX - tick, y(top) - pad, 2 * tick, y(bottom) - y(top) + 2 * pad);
  canvas.drawRect(bar, fillPaint(style.fill));
  if (style.stroke) canvas.drawRect(bar, strokePaint(style.stroke, style.lineWidth ?? 1));
  const font = (bold: boolean) => (bold ? fonts.scaleBold : fonts.scale);
  scale.rows.forEach((row, r) => drawText(canvas, row.label, textX, y(r) + 4.5, font(row.bold), row.bold ? palette.text : style.muted ?? palette.text));
  const noteX = textX + labelsW + 5;
  for (const note of scale.notes) drawText(canvas, note.label, noteX, y(note.at) + 4.5, font(note.bold), palette.text);
  return recorder.finishRecordingAsPicture();
}

export function ScaleView({ scale, width, fonts, style = STANDARD_SCALE }: { scale: Scale; width: number; fonts: Fonts; style?: ScaleStyle }) {
  const picture = useMemo(() => recordScale(scale, width, fonts, style), [scale, width, fonts, style]);
  return <SkiaPictureView style={{ width, height: scaleHeight(scale, style) }} picture={picture} />;
}

function ColumnLabel({ label }: { label: string }) {
  return (
    <View style={styles.columnLabel}>
      <Text style={styles.columnLabelText}>{label}</Text>
    </View>
  );
}

const PROBLEM_GAP = 16;

// The bar across the top of a problem card. The card clips it to its rounded corners.
export function ProblemHead({ index, name }: { index: number; name: string }) {
  return <Text style={styles.problemHead}>{`Problem ${index + 1}: ${name}`}</Text>;
}

function ProblemCard({ problem, index, width, fonts }: { problem: AvalancheProblem; index: number; width: number; fonts: Fonts }) {
  const likelihood = useMemo(() => likelihoodScale(problem.likelihood), [problem.likelihood]);
  const size = useMemo(() => sizeScale(problem.size), [problem.size]);
  const roseW = Math.floor((width - PROBLEM_GAP) * 0.55);
  const scaleW = width - PROBLEM_GAP - roseW;
  return (
    <View style={styles.problem}>
      <ProblemHead index={index} name={PROBLEM_NAMES[problem.type]} />
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

export function Card({ children }: { children: ReactNode }) {
  return <View style={styles.card}>{children}</View>;
}

// Paragraphs are blank-line separated; single line breaks stay inside a paragraph.
export function Prose({ text, lead = false }: { text: string; lead?: boolean }) {
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

// A bulletin's facts in rows of two labeled columns. A cell without a value stays empty, and a row
// without any is left out. The labels are drawn as Section draws its own.
export type StampCell = [label: string, value: string | null | undefined];
export function StampGrid({ rows }: { rows: StampCell[][] }) {
  const shown = rows.filter((row) => row.some(([, value]) => value));
  return (
    <>
      {shown.map((row, i) => (
        <View key={i} style={[styles.stamps, i === shown.length - 1 && styles.stampsLast]}>
          {row.map(([label, value]) => (value ? <Stamp key={label} label={label} value={value} /> : <View key={label} style={styles.stampColumn} />))}
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
  const [hideExpired, setHideExpired] = useState(false);
  useEffect(() => { loadHideExpiredBanner().then(setHideExpired); }, []);
  const graphicW = pageW - 2 * PAD - 2 * CARD_PAD;
  const stamp = (ms: number) => stampLabel(ms, forecast.timezone, timeFormat);
  const disclaimer = DISCLAIMERS[bulletinCenter(forecast)];
  return (
    <View style={styles.page} onLayout={(e) => setPageW(e.nativeEvent.layout.width)}>
      {forecast.expires < Date.now() && !hideExpired && (
        <WarningBanner>This forecast is no longer valid</WarningBanner>
      )}
      <StampGrid
        rows={[
          [['Issued', stamp(forecast.issued)], ['Expires', stamp(forecast.expires)]],
          [['Region', region], ['Prepared by', preparedBy(forecast)]],
        ]}
      />

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

      <Text style={styles.attribution}>Avalanche forecast provided by Avalanche Canada</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  page: { paddingHorizontal: PAD },
  stamps: { flexDirection: 'row', gap: 16, marginBottom: 10 },
  stampsLast: { marginBottom: 20 },
  stampColumn: { flex: 1 },
  stampLabel: { fontSize: 12, fontWeight: '600', color: palette.pageLabel, textTransform: 'uppercase', letterSpacing: 0.5, marginBottom: 2 },
  stampValue: { fontSize: 15, lineHeight: 20, color: palette.textBody },
  section: { marginBottom: 20 },
  sectionToggle: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  sectionToggleOpen: { marginBottom: 8 },
  sectionLabelToggle: { marginBottom: 0 },
  sectionLabel: { fontSize: 12, fontWeight: '600', color: palette.pageLabel, textTransform: 'uppercase', letterSpacing: 0.5, marginBottom: 8 },
  card: { backgroundColor: palette.card, borderRadius: 12, padding: CARD_PAD },
  prose: { fontSize: 16, color: palette.textBody, lineHeight: 23 },
  proseLead: { fontSize: 18, lineHeight: 25, fontWeight: '700', color: palette.text, textAlign: 'center' },
  proseGap: { marginBottom: 10 },
  bulletRow: { flexDirection: 'row', gap: 8 },
  bullet: { fontSize: 16, lineHeight: 23, color: palette.textSecondary },
  bulletText: { flex: 1 },
  problem: { borderRadius: 12, overflow: 'hidden', marginBottom: 10, backgroundColor: palette.card },
  problemHead: { backgroundColor: DAY_HEAD, color: '#ffffff', fontSize: 17, fontWeight: '400', paddingHorizontal: CARD_PAD, paddingVertical: 12 },
  problemBody: { padding: CARD_PAD },
  problemColumns: { flexDirection: 'row', gap: PROBLEM_GAP },
  problemText: { marginTop: 12 },
  columnLabel: { borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: palette.cardRule, paddingBottom: 5, marginBottom: 6 },
  columnLabelText: { fontSize: 12, fontWeight: '700', color: palette.text, textTransform: 'uppercase', letterSpacing: 0.5 },
  scaleGap: { height: 10 },
  weatherLabel: { fontSize: 16, fontWeight: '700', color: palette.text, lineHeight: 23 },
  confidence: { fontWeight: '600', color: palette.text },
  dangerDay: { borderRadius: 12, overflow: 'hidden', marginBottom: 10, backgroundColor: '#ffffff' },
  dangerDayLabel: { backgroundColor: DAY_HEAD, color: '#ffffff', fontSize: 17, fontWeight: '400', paddingHorizontal: 14, paddingVertical: 12 },
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
