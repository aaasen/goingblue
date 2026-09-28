import { memo } from 'react';
import { StyleSheet } from 'react-native';
import { SkiaPictureView, Skia, StrokeJoin, type SkPicture } from '@shopify/react-native-skia';
import type { DangerDay } from '@weather/protocol';
import { dangerCell } from '../avalancheDisplay';
import { fillPaint, strokePaint } from '../skiaPaint';
import { palette } from '../palette';

// Fits a 24pt slot of the saved-forecast row.
const W = 24;
const H = 20;
const INSET = 1;
// Alpine at the peak, treeline in the middle, below treeline at the base. Each band's top as a
// fraction of the height: in equal heights the peak's band would be too small to read.
const BANDS = [['alp', 0], ['tln', 0.45], ['btl', 0.75]] as const;

// The mountain's half-width at height y, measured from the peak.
const halfAt = (y: number) => ((y - INSET) / (H - 2 * INSET)) * (W / 2 - INSET);

const pictures = new Map<string, SkPicture>();
function mountainPicture(day: Pick<DangerDay, 'alp' | 'tln' | 'btl'>): SkPicture {
  const outline = palette.textSecondary;
  const key = `${day.alp}:${day.tln}:${day.btl}:${outline}`;
  let picture = pictures.get(key);
  if (!picture) {
    const recorder = Skia.PictureRecorder();
    const canvas = recorder.beginRecording(Skia.XYWHRect(0, 0, W, H));
    const cx = W / 2;
    const at = (f: number) => INSET + f * (H - 2 * INSET);
    const lines = Skia.Path.Make();
    BANDS.forEach(([band, from], i) => {
      const top = at(from), bottom = at(i + 1 < BANDS.length ? BANDS[i + 1][1] : 1);
      const path = Skia.Path.Make();
      path.moveTo(cx - halfAt(top), top);
      path.lineTo(cx + halfAt(top), top);
      path.lineTo(cx + halfAt(bottom), bottom);
      path.lineTo(cx - halfAt(bottom), bottom);
      path.close();
      canvas.drawPath(path, fillPaint(dangerCell(day[band]).fill));
      if (i > 0) {
        lines.moveTo(cx - halfAt(top), top);
        lines.lineTo(cx + halfAt(top), top);
      }
    });
    const shape = Skia.Path.Make();
    shape.moveTo(cx, INSET);
    shape.lineTo(W - INSET, H - INSET);
    shape.lineTo(INSET, H - INSET);
    shape.close();
    canvas.drawPath(lines, strokePaint(outline, 1));
    canvas.drawPath(shape, strokePaint(outline, 1, undefined, StrokeJoin.Round));
    picture = recorder.finishRecordingAsPicture();
    pictures.set(key, picture);
  }
  return picture;
}

// A day's danger drawn as a mountain in three bands, for a saved bulletin's row.
export default memo(function DangerMountain({ day }: { day: Pick<DangerDay, 'alp' | 'tln' | 'btl'> }) {
  return <SkiaPictureView style={styles.icon} picture={mountainPicture(day)} />;
});

const styles = StyleSheet.create({
  icon: { width: W, height: H },
});
