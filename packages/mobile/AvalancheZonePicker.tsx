import { memo, useEffect, useMemo, useState } from 'react';
import { StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import MaterialCommunityIcons from '@expo/vector-icons/MaterialCommunityIcons';
import type { AvalanchePiece } from '@weather/protocol';
import DayRow from './components/DayRow';
import InfoModal from './components/InfoModal';
import { palette } from './palette';
import { zoneNames } from './avalancheDisplay';
import { ZONE_CENTER_SECTIONS, centerName, centerRegions } from './avalancheZones';

const CONTENT_PAD = 16;

// One row of a list: its name, and a check when it is the one selected.
function Item({ label, selected, last, onPress }: { label: string; selected: boolean; last: boolean; onPress: () => void }) {
  return (
    <TouchableOpacity
      style={[styles.item, !last && styles.itemBorder]}
      onPress={onPress}
      accessibilityRole="button"
      accessibilityState={{ selected }}
    >
      <Text style={styles.itemText}>{label}</Text>
      {selected && <MaterialCommunityIcons name="check" size={20} color={palette.pageLink} />}
    </TouchableOpacity>
  );
}

// The Avalanche tab's way to a forecast: a forecast center, then one of its regions, each chosen
// from a full-screen list, and the day to request for. The rows sit under the map as the Weather tab's coordinate rows do.
// `zone` is the selected region. Choosing another center with more than one region clears it
// until one of that center's regions is chosen, and reports the center through `onCenter`.
export default memo(function AvalancheZonePicker({ zone, onZone, onCenter, day, onDay }: {
  zone: AvalanchePiece | null; onZone: (zone: AvalanchePiece | null) => void; onCenter: (center: string) => void;
  // The day to request for (see DayRow).
  day: string; onDay: (day: string) => void;
}) {
  const [center, setCenter] = useState<string | null>(zone?.center ?? null);
  const [list, setList] = useState<'center' | 'region' | null>(null);
  // A region selected elsewhere, as by a tap on the map, brings its center with it.
  useEffect(() => { if (zone) setCenter(zone.center); }, [zone]);
  const sections = useMemo(() => (center ? centerRegions(center) : []), [center]);

  function pickCenter(key: string) {
    setCenter(key);
    setList(null);
    if (key === zone?.center) return;
    const regions = centerRegions(key).flatMap((s) => s.pieces);
    if (regions.length === 1) {
      onZone(regions[0]);
    } else {
      onZone(null);
      onCenter(key);
    }
  }

  function pickRegion(piece: AvalanchePiece) {
    onZone(piece);
    setList(null);
  }

  const region = zone && zone.center === center ? zoneNames(zone) : null;
  return (
    <View style={styles.rows}>
      <TouchableOpacity style={styles.row} onPress={() => setList('center')} accessibilityRole="button">
        <Text style={styles.label}>Center</Text>
        <Text style={[styles.value, !center && styles.placeholder]} numberOfLines={1}>
          {center ? centerName(center) : 'Choose a forecast center'}
        </Text>
        <MaterialCommunityIcons name="chevron-down" size={20} color={palette.textTertiary} style={styles.chevron} />
      </TouchableOpacity>
      <TouchableOpacity
        style={styles.row}
        onPress={() => setList('region')}
        disabled={!center}
        accessibilityRole="button"
        accessibilityState={{ disabled: !center }}
      >
        <Text style={styles.label}>Region</Text>
        <Text style={[styles.value, !region && styles.placeholder]} numberOfLines={1}>
          {region ?? 'Choose a region'}
        </Text>
        <MaterialCommunityIcons name="chevron-down" size={20} color={palette.textTertiary} style={styles.chevron} />
      </TouchableOpacity>
      <DayRow day={day} onDay={onDay} />

      <InfoModal visible={list === 'center'} title="Forecast Center" grouped onClose={() => setList(null)}>
        {ZONE_CENTER_SECTIONS.map((section) => (
          <View key={section.title} style={styles.section}>
            <Text style={styles.sectionLabel}>{section.title}</Text>
            <View style={styles.list}>
              {section.centers.map((c, i) => (
                <Item
                  key={c.key} label={c.name} selected={c.key === center} last={i === section.centers.length - 1}
                  onPress={() => pickCenter(c.key)}
                />
              ))}
            </View>
          </View>
        ))}
      </InfoModal>

      <InfoModal visible={list === 'region'} title="Region" grouped onClose={() => setList(null)}>
        {sections.map((section, s) => (
          <View key={section.title ?? s} style={styles.section}>
            {section.title && <Text style={styles.sectionLabel}>{section.title}</Text>}
            <View style={styles.list}>
              {section.pieces.map((piece, i) => (
                <Item
                  key={piece.id} label={zoneNames(piece)} selected={piece.id === zone?.id}
                  last={i === section.pieces.length - 1} onPress={() => pickRegion(piece)}
                />
              ))}
            </View>
          </View>
        ))}
      </InfoModal>
    </View>
  );
});

const styles = StyleSheet.create({
  // The rows under the map, as HomeScreen's coordinate rows are drawn.
  rows: { backgroundColor: palette.card, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: palette.pageRule },
  row: {
    flexDirection: 'row', alignItems: 'baseline', paddingHorizontal: CONTENT_PAD, paddingVertical: 12,
    borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: palette.cardRule,
  },
  label: { width: 104, fontSize: 15, fontWeight: '600', color: palette.textSecondary },
  value: { flex: 1, fontSize: 15, color: palette.text },
  placeholder: { color: palette.textTertiary },
  chevron: { alignSelf: 'center', marginLeft: 8 },
  section: { marginBottom: 20 },
  sectionLabel: { fontSize: 12, fontWeight: '600', color: palette.pageLabel, textTransform: 'uppercase', letterSpacing: 0.5, marginBottom: 8 },
  list: { backgroundColor: palette.card, borderRadius: 12, overflow: 'hidden' },
  item: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 14, paddingVertical: 12 },
  itemBorder: { borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: palette.cardRule },
  itemText: { flex: 1, fontSize: 16, color: palette.text },
});
