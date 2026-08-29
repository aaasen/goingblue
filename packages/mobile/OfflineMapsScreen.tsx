import { useEffect, useRef, useState, type ReactNode } from 'react';
import {
  ActivityIndicator, Alert, Keyboard, Linking, Modal, Platform, SafeAreaView, ScrollView, StyleSheet,
  Text, TextInput, TouchableOpacity, View, useWindowDimensions, type GestureResponderEvent,
} from 'react-native';
import * as Location from 'expo-location';
import MaterialCommunityIcons from '@expo/vector-icons/MaterialCommunityIcons';
import { findPack, formatBytes, formatTallyBytes, searchPacks, tally, type Pack } from './catalog';
import { regionsAt } from './outlines';
import { MODAL_TOP_INSET } from './insets';
import { usePackState } from './packStore';
import { clearTileCache, tileCacheSize, TILE_CACHE_EMPTY_BYTES } from './tileCache';

interface Props {
  visible: boolean;
  onClose: () => void;
  downloaded: ReadonlySet<string>;
  onDownload: (id: string) => void;
  onRemove: (id: string) => void;
}

// Everything the map keeps on the phone, holdings first: the tile cache the map fills on its
// own while online and the downloaded regions. Then one download section: the packs for where
// the person is standing (the state or province at full detail, the country as an overview)
// with a search for anywhere else below — the full catalog is three hundred rows; nobody
// browses it.

// Where the phone is, as far as the sheet has got in finding out. `off` is a permission not
// granted (the row offers to ask); `failed` is a granted permission and no fix.
type Here =
  | { kind: 'locating' }
  | { kind: 'off'; canAskAgain: boolean }
  | { kind: 'failed' }
  | { kind: 'found'; packs: Pack[] };

export default function OfflineMapsScreen({ visible, onClose, downloaded, onDownload, onRemove }: Props) {
  const [here, setHere] = useState<Here>({ kind: 'locating' });
  const [query, setQuery] = useState('');
  // undefined = not read yet; null = couldn't be read.
  const [cacheBytes, setCacheBytes] = useState<number | null | undefined>(undefined);
  const [clearing, setClearing] = useState(false);
  // Keyboard height as extra scroll room. automaticallyAdjustKeyboardInsets would do this, but
  // it doesn't work inside a Modal (the keyboard frame is measured against the window), so the
  // sheet tracks the keyboard itself. Android resizes the window instead.
  const [keyboard, setKeyboard] = useState(0);
  const [searching, setSearching] = useState(false);
  const { height: windowHeight } = useWindowDimensions();
  const scrollRef = useRef<ScrollView>(null);
  const searchY = useRef(0);

  useEffect(() => {
    if (Platform.OS !== 'ios') return;
    const show = Keyboard.addListener('keyboardWillShow', (e) => setKeyboard(e.endCoordinates.height));
    const hide = Keyboard.addListener('keyboardWillHide', () => setKeyboard(0));
    return () => { show.remove(); hide.remove(); };
  }, []);

  // While a search is underway, the content gets a viewport-sized tail: without it the scroll
  // clamps — there isn't enough below the search box to bring it to the top — and the results
  // end up under the keyboard. With it, the search pins to the top and the results own the band
  // between it and the keyboard. The tail holds while the query is non-empty, not just while
  // the field has focus: a tap on a result dismisses the keyboard, and if the tail collapsed on
  // that blur the rows would move mid-press and the tap would cancel instead of downloading.
  const bottomPad = searching || query.trim() ? windowHeight : keyboard > 0 ? keyboard + 12 : undefined;

  function scrollToSearch() {
    setSearching(true);
    // After the keyboard animation and the padding render it needs.
    setTimeout(() => scrollRef.current?.scrollTo({ y: searchY.current - 8, animated: true }), 300);
  }

  // Look the position up on each open. Only when access was already granted: a permission
  // dialog on top of a sheet that just slid in asks before the person has seen what it's for —
  // the row explains, and asks when tapped.
  useEffect(() => {
    if (!visible) return;
    setQuery('');
    setHere({ kind: 'locating' });
    setCacheBytes(undefined);
    let cancelled = false;
    tileCacheSize().then((bytes) => { if (!cancelled) setCacheBytes(bytes); });
    (async () => {
      const { granted, canAskAgain } = await Location.getForegroundPermissionsAsync();
      const next = granted ? await locate() : { kind: 'off' as const, canAskAgain };
      if (!cancelled) setHere(next);
    })();
    return () => { cancelled = true; };
  }, [visible]);

  async function askAndLocate() {
    setHere({ kind: 'locating' });
    const { status, canAskAgain } = await Location.requestForegroundPermissionsAsync();
    if (status !== 'granted') {
      setHere({ kind: 'off', canAskAgain });
      // Once the OS has stopped asking, Settings is the only way to turn it on.
      if (!canAskAgain) {
        Alert.alert('Location is off for this app', 'Turn it on in Settings to see the maps for where you are.', [
          { text: 'Cancel', style: 'cancel' },
          { text: 'Open Settings', onPress: () => { Linking.openSettings(); } },
        ]);
      }
      return;
    }
    setHere(await locate());
  }

  async function runClearCache() {
    setClearing(true);
    try {
      await clearTileCache();
    } catch {
      Alert.alert('Couldn’t clear the tile cache', 'Try again in a moment.');
    } finally {
      setCacheBytes(await tileCacheSize());
      setClearing(false);
    }
  }

  function confirmClearCache() {
    Alert.alert('Clear tile cache?', 'The map fetches the tiles again the next time it draws them online. Downloaded regions are kept.', [
      { text: 'Cancel', style: 'cancel' },
      { text: 'Clear', style: 'destructive', onPress: runClearCache },
    ]);
  }

  const held = downloadedPacks(downloaded);
  const heldBytes = tally(held.packs).bytes;
  // In the suggestion and search lists the whole row acts and its icon is decoration — with the
  // keyboard up a tap on a non-touchable row body only dismisses the keyboard, and an icon with
  // its own press would fire the action twice.
  const rowAction = (pack: Pack) => () =>
    downloaded.has(pack.id) ? confirmRemovePack(pack, onRemove) : onDownload(pack.id);
  // The skeleton of an emptied cache still has a file size; don't report it as content.
  const cacheEmpty = cacheBytes != null && cacheBytes <= TILE_CACHE_EMPTY_BYTES;
  const control = (pack: Pack, interactive = true) => (
    <DownloadControl pack={pack} downloaded={downloaded} onDownload={onDownload} onRemove={(p) => confirmRemovePack(p, onRemove)} interactive={interactive} />
  );
  const results = searchPacks(query);

  return (
    <Modal visible={visible} animationType="slide" presentationStyle="fullScreen" onRequestClose={onClose}>
      <SafeAreaView style={styles.root}>
        <View style={styles.header}>
          <Text style={styles.title}>Offline maps</Text>
          <TouchableOpacity onPress={onClose} accessibilityRole="button" hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}>
            <Text style={styles.done}>Done</Text>
          </TouchableOpacity>
        </View>

        <ScrollView
          ref={scrollRef}
          style={styles.scroll}
          contentContainerStyle={[styles.content, bottomPad != null && { paddingBottom: bottomPad }]}
          keyboardShouldPersistTaps="handled"
          keyboardDismissMode="on-drag"
        >
          <Text style={styles.intro}>
            Going Blue comes with a low-resolution map of the world for displaying forecast location.
            Download maps for higher resolution while offline.
          </Text>

          <Text style={styles.heading}>{heldBytes ? `Offline maps · ${formatBytes(heldBytes)}` : 'Offline maps'}</Text>
          <View style={styles.card}>
            {held.packs.map((pack, i) => (
              <Row key={pack.id} title={pack.name} subtitle={packDetails(pack)} divider={i > 0} trailing={control(pack)} />
            ))}
            <Row
              divider={held.packs.length > 0}
              title="Tile cache"
              subtitle={cacheBytes === undefined ? 'Measuring…'
                : cacheBytes === null ? 'Size unavailable'
                : cacheEmpty ? 'Empty'
                : formatBytes(cacheBytes)}
              trailing={
                <TouchableOpacity
                  onPress={confirmClearCache}
                  disabled={clearing || cacheEmpty || cacheBytes == null}
                  activeOpacity={0.6}
                  accessibilityRole="button"
                  hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
                >
                  {clearing
                    ? <ActivityIndicator color="#cc2222" />
                    : <Text style={[styles.clear, (cacheEmpty || cacheBytes == null) && styles.clearDisabled]}>Clear</Text>}
                </TouchableOpacity>
              }
            />
          </View>

          <Text style={[styles.heading, styles.headingGap]}>Download maps</Text>
          <View style={styles.card}>
            {here.kind === 'locating' && (
              <Row title="Finding your location…" subtitle="" trailing={<ActivityIndicator color="#8e8e93" />} />
            )}
            {here.kind === 'off' && (
              <Row
                title="Use my location"
                subtitle="Shows the maps for the state and country you're in"
                trailing={<MaterialCommunityIcons name="crosshairs-gps" size={24} color="#2a6bb5" />}
                onPress={askAndLocate}
              />
            )}
            {here.kind === 'failed' && (
              <Row
                title="Couldn’t get your location"
                subtitle="Tap to try again"
                trailing={<MaterialCommunityIcons name="refresh" size={24} color="#2a6bb5" />}
                onPress={askAndLocate}
              />
            )}
            {here.kind === 'found' && here.packs.length === 0 && (
              <Row title="No map pack here" subtitle="You're outside every region the packs cover" />
            )}
            {here.kind === 'found' && here.packs.map((pack, i) => (
              <Row key={pack.id} title={pack.name} subtitle={packDetails(pack)} divider={i > 0} trailing={control(pack, false)} onPress={rowAction(pack)} />
            ))}
          </View>

          <View style={styles.searchGap} onLayout={(e) => { searchY.current = e.nativeEvent.layout.y; }} />
          <View style={styles.search}>
            <MaterialCommunityIcons name="magnify" size={20} color="#8e8e93" />
            <TextInput
              style={styles.searchInput}
              value={query}
              onChangeText={setQuery}
              placeholder="Country, state, or province"
              placeholderTextColor="#8e8e93"
              autoCapitalize="words"
              autoCorrect={false}
              onFocus={scrollToSearch}
              onBlur={() => setSearching(false)}
              clearButtonMode="while-editing"
              returnKeyType="search"
              accessibilityLabel="Search regions"
            />
          </View>
          {query.trim().length > 0 && (
            <View style={styles.card}>
              {results.length === 0 && <Row title="No regions match" subtitle="" />}
              {results.map((pack, i) => (
                <Row key={pack.id} title={pack.name} subtitle={packDetails(pack)} divider={i > 0} trailing={control(pack, false)} onPress={rowAction(pack)} />
              ))}
            </View>
          )}
          <Text style={styles.attribution}>
            Map data © OpenStreetMap contributors, via Protomaps; place data from the Overture Maps
            Foundation; terrain from Mapterhorn (Copernicus DEM); land cover from the Copernicus
            Global Land Service; region boundaries from Natural Earth.
          </Text>
        </ScrollView>
      </SafeAreaView>
    </Modal>
  );
}

// The phone's position, resolved to its packs: the state or province first, then the country.
async function locate(): Promise<Here> {
  try {
    const pos = await Location.getCurrentPositionAsync({ accuracy: Location.Accuracy.Balanced });
    const { state, country } = regionsAt(pos.coords.latitude, pos.coords.longitude);
    return { kind: 'found', packs: [state, country].filter((p): p is Pack => !!p) };
  } catch {
    return { kind: 'failed' };
  }
}

function Row({ title, subtitle, trailing, divider, onPress }: {
  title: string;
  subtitle: string;
  trailing?: ReactNode;
  divider?: boolean;
  onPress?: () => void;
}) {
  // With the keyboard up inside this Modal, the scroll view's keyboard-dismiss handling eats
  // the press (keyboardShouldPersistTaps doesn't help on the new architecture), so the row
  // recognizes taps itself from the raw touch events, which still arrive when the press is
  // cancelled: touch down and up in nearly the same place, quickly, is a tap. The normal press
  // path stays for feedback and accessibility; `fire` dedupes when both deliver.
  const touch = useRef({ x: 0, y: 0, t: 0, firedAt: 0 });
  const fire = () => {
    const now = Date.now();
    if (now - touch.current.firedAt < 400) return;
    touch.current.firedAt = now;
    onPress?.();
  };
  const raw = onPress
    ? {
        onTouchStart: (e: GestureResponderEvent) => {
          touch.current.x = e.nativeEvent.pageX;
          touch.current.y = e.nativeEvent.pageY;
          touch.current.t = Date.now();
        },
        onTouchEnd: (e: GestureResponderEvent) => {
          const { x, y, t } = touch.current;
          const dx = e.nativeEvent.pageX - x;
          const dy = e.nativeEvent.pageY - y;
          if (Date.now() - t < 400 && dx * dx + dy * dy < 144) fire();
        },
      }
    : undefined;
  const body = (
    <View style={[styles.row, divider && styles.rowDivider]} {...raw}>
      <View style={styles.rowText}>
        <Text style={styles.rowTitle}>{title}</Text>
        {subtitle ? <Text style={styles.rowSubtitle}>{subtitle}</Text> : null}
      </View>
      {trailing}
    </View>
  );
  return onPress
    ? (
      <TouchableOpacity onPress={fire} activeOpacity={0.6} accessibilityRole="button">
        {body}
      </TouchableOpacity>
    )
    : body;
}

function joinDetails(parts: string[]): string {
  return parts.filter(Boolean).join(' · ');
}

// "z10 · 8.5 MB · United States of America" — the size is left off while the pack is unbuilt
// rather than shown as unknown; a state names its country so search results read unambiguously.
export function packDetails(pack: Pack): string {
  return joinDetails([
    `z${pack.maxzoom}`,
    pack.bytes == null ? '' : formatBytes(pack.bytes),
    pack.parent ? findPack(pack.parent)?.name ?? '' : '',
  ]);
}

// The downloaded packs by name, with what they add up to: "3 packs · 95 MB".
export function downloadedPacks(downloaded: ReadonlySet<string>): { packs: Pack[]; summary: string } {
  const packs = [...downloaded].map((id) => findPack(id)).filter((p): p is Pack => !!p).sort((a, b) => a.name.localeCompare(b.name));
  const t = tally(packs);
  return { packs, summary: joinDetails([`${t.packs} ${t.packs === 1 ? 'region' : 'regions'}`, formatTallyBytes(t)]) };
}

// The row's action: download (with its progress while running), or — once downloaded — a check
// that offers removal. Shared with the Settings list, where every row is the second kind.
export function DownloadControl({ pack, downloaded, onDownload, onRemove, interactive = true }: {
  pack: Pack;
  downloaded: ReadonlySet<string>;
  onDownload: (id: string) => void;
  onRemove: (pack: Pack) => void;
  // false when the whole row is the button (suggestions, search results): the icon still shows
  // the state but doesn't press, so a tap on it can't fire the action twice.
  interactive?: boolean;
}) {
  const { progress } = usePackState();
  const running = progress.get(pack.id);
  if (running !== undefined) {
    return (
      <View style={progressStyles.wrap} accessibilityLabel={`Downloading ${pack.name}`}>
        <Text style={progressStyles.pct}>{Math.round(running * 100)}%</Text>
        <ActivityIndicator color="#2a6bb5" />
      </View>
    );
  }
  const on = downloaded.has(pack.id);
  const icon = <MaterialCommunityIcons name={on ? 'check-circle' : 'download-circle-outline'} size={26} color="#2a6bb5" />;
  if (!interactive) return icon;
  return (
    <TouchableOpacity
      onPress={() => (on ? onRemove(pack) : onDownload(pack.id))}
      accessibilityRole="button"
      accessibilityLabel={on ? `Remove ${pack.name}` : `Download ${pack.name}`}
      hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
      activeOpacity={0.6}
    >
      {icon}
    </TouchableOpacity>
  );
}

const progressStyles = StyleSheet.create({
  wrap: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  pct: { fontSize: 13, color: '#8e8e93', fontVariant: ['tabular-nums'] },
});

// The removal confirmation both lists use.
export function confirmRemovePack(pack: Pack, onRemove: (id: string) => void) {
  const message = pack.bytes == null ? undefined : `This will free ${formatBytes(pack.bytes)} of storage.`;
  Alert.alert(`Remove ${pack.name}?`, message, [
    { text: 'Cancel', style: 'cancel' },
    { text: 'Remove', style: 'destructive', onPress: () => onRemove(pack.id) },
  ]);
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: '#f2f2f7', paddingTop: MODAL_TOP_INSET },
  // The same frame as HelpScreen's.
  header: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    paddingHorizontal: 16, paddingTop: 12, paddingBottom: 12,
  },
  title: { flex: 1, fontSize: 20, fontWeight: '700', color: '#1c1c1e' },
  done: { fontSize: 16, fontWeight: '600', color: '#2a6bb5', paddingLeft: 12 },

  scroll: { flex: 1 },
  content: { paddingHorizontal: 16, paddingBottom: 40 },

  intro: { fontSize: 14, color: '#3a3a3c', lineHeight: 20, marginBottom: 20 },
  heading: { fontSize: 13, fontWeight: '700', color: '#8e8e93', textTransform: 'uppercase', letterSpacing: 0.5, marginBottom: 12 },
  headingGap: { marginTop: 24 },
  note: { fontSize: 13, color: '#6e6e73', lineHeight: 19, marginTop: 10 },
  card: { backgroundColor: '#fff', borderRadius: 12, paddingHorizontal: 14 },

  row: { flexDirection: 'row', alignItems: 'center', paddingVertical: 11, gap: 10 },
  rowDivider: { borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: '#d1d1d6' },
  rowText: { flex: 1 },
  rowTitle: { fontSize: 15, color: '#1c1c1e' },
  rowSubtitle: { fontSize: 13, color: '#8e8e93', marginTop: 2 },

  searchGap: { height: 12 },
  search: {
    flexDirection: 'row', alignItems: 'center', gap: 8, backgroundColor: '#fff', borderRadius: 12,
    paddingHorizontal: 12, height: 44, marginBottom: 12,
  },
  searchInput: { flex: 1, fontSize: 15, color: '#1c1c1e' },

  attribution: { fontSize: 12, color: '#8e8e93', lineHeight: 17, marginTop: 28 },

  clear: { color: '#cc2222', fontSize: 15, fontWeight: '600' },
  clearDisabled: { color: '#c7c7cc' },
});
