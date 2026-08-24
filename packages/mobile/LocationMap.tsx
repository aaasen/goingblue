import { useEffect, useRef, useState } from 'react';
import { Modal, StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import { Camera, Images, Map, Marker, type CameraRef, type PressEvent } from '@maplibre/maplibre-react-native';
import MaterialCommunityIcons from '@expo/vector-icons/MaterialCommunityIcons';
import type { NativeSyntheticEvent } from 'react-native';
import { basemapStyle, MAX_ZOOM } from './basemapStyle';

export interface LatLon {
  lat: number;
  lon: number;
}

interface Props {
  // The point to mark. When null, no marker is shown and the map opens on a wide default view.
  coord: LatLon | null;
  // When provided, the map is a picker: tapping reports a new coordinate.
  // When omitted, the map is a read-only preview (no panning, so it doesn't fight a parent ScrollView).
  onPick?: (c: LatLon) => void;
  // Inline height. Omitted, the map is square at whatever width it is given.
  height?: number;
  active?: boolean;
}

// Wide view of the contiguous US, used as the picker's starting point before any coordinate is set.
const DEFAULT_VIEW = { center: [-96, 37] as [number, number], zoom: 2.2 };
// Zoom applied once a coordinate exists — tight enough to confirm the spot, loose enough to nudge it.
const PICKED_ZOOM = 9;

const MAP_IMAGES = { 'peak-triangle': require('./assets/peak-triangle.png') };

// MapLibre Native map over the PMTiles basemap (see basemapStyle.ts). One component for both the
// builder's picker and the decoder's preview — they differ only in height and in whether tapping
// picks a coordinate. Either way the corner button opens the same map fullscreen, where it pans and
// zooms freely. Callers also expose lat/lon text inputs for setting a location without the map.
export default function LocationMap({ coord, onPick, height, active = true }: Props) {
  const cameraRef = useRef<CameraRef>(null);
  const fullscreenCameraRef = useRef<CameraRef>(null);
  const wasActive = useRef(active);
  const [fullscreen, setFullscreen] = useState(false);
  const [mapRevision, setMapRevision] = useState(0);
  const interactive = onPick != null;
  const initialViewState = coord ? { center: [coord.lon, coord.lat] as [number, number], zoom: PICKED_ZOOM } : DEFAULT_VIEW;

  // A native map surface can lose its GL context while its parent has `display: none`. Recreate
  // it when its tab becomes visible again.
  useEffect(() => {
    if (active && !wasActive.current) setMapRevision((revision) => revision + 1);
    wasActive.current = active;
  }, [active]);

  useEffect(() => {
    if (!coord) return;
    const stop = { center: [coord.lon, coord.lat] as [number, number], zoom: PICKED_ZOOM, duration: 250 };
    cameraRef.current?.easeTo(stop);
    fullscreenCameraRef.current?.easeTo(stop);
  }, [coord?.lat, coord?.lon]);

  const onPress = interactive
    ? (e: NativeSyntheticEvent<PressEvent>) => {
        const [lon, lat] = e.nativeEvent.lngLat;
        onPick({ lat, lon });
      }
    : undefined;

  // `pannable` is separate from `interactive`: an inline preview stays locked so it doesn't fight
  // the parent ScrollView, but the same map in the fullscreen modal has no scroll view to fight.
  function renderMap(ref: React.RefObject<CameraRef | null>, pannable: boolean, key?: number) {
    return (
      <Map
        key={key}
        style={StyleSheet.absoluteFill}
        mapStyle={basemapStyle}
        onPress={onPress}
        dragPan={pannable}
        touchZoom={pannable}
        doubleTapZoom={pannable}
        touchRotate={false}
        touchPitch={false}
        compass={false}
        logo={false}
        attribution={false}
      >
        <Images images={MAP_IMAGES} />
        <Camera ref={ref} initialViewState={initialViewState} maxZoom={MAX_ZOOM} />
        {coord && (
          <Marker lngLat={[coord.lon, coord.lat]} anchor="bottom">
            <View style={styles.pin}>
              <View style={styles.pinHead} />
              <View style={styles.pinTail} />
            </View>
          </Marker>
        )}
      </Map>
    );
  }

  return (
    <View style={[styles.wrap, height == null ? styles.square : { height }]}>
      {!fullscreen && (
        <>
          {renderMap(cameraRef, interactive, mapRevision)}
          <TouchableOpacity
            style={styles.fullscreenButton}
            onPress={() => setFullscreen(true)}
            accessibilityRole="button"
            accessibilityLabel="Open map fullscreen"
          >
            {/* Material's fullscreen glyph rather than a ⛶ text character, which several
                platforms draw as a plain box or a missing-glyph slug. */}
            <MaterialCommunityIcons name="fullscreen" size={26} color="#2a6bb5" />
          </TouchableOpacity>
        </>
      )}
      {fullscreen && (
        <Modal
          visible
          animationType="slide"
          presentationStyle="fullScreen"
          onRequestClose={() => setFullscreen(false)}
        >
          <View style={styles.fullscreenWrap}>
            {renderMap(fullscreenCameraRef, true)}
            <TouchableOpacity
              style={styles.doneButton}
              onPress={() => setFullscreen(false)}
              accessibilityRole="button"
            >
              <Text style={styles.doneButtonText}>Done</Text>
            </TouchableOpacity>
          </View>
        </Modal>
      )}
    </View>
  );
}

const PIN = '#d0433b';

const styles = StyleSheet.create({
  // Full-bleed by default: no outer margin, square corners. Callers place and space it.
  wrap: { overflow: 'hidden', backgroundColor: '#e5e8ee' },
  square: { width: '100%', aspectRatio: 1 },
  fullscreenWrap: { flex: 1, backgroundColor: '#e5e8ee' },
  pin: { alignItems: 'center' },
  pinHead: {
    width: 22, height: 22, borderRadius: 11, backgroundColor: PIN,
    borderWidth: 2.5, borderColor: '#ffffff',
  },
  pinTail: {
    width: 0, height: 0, marginTop: -3,
    borderLeftWidth: 6, borderRightWidth: 6, borderTopWidth: 10,
    borderLeftColor: 'transparent', borderRightColor: 'transparent', borderTopColor: PIN,
  },
  fullscreenButton: {
    position: 'absolute', top: 12, right: 12, backgroundColor: 'rgba(255,255,255,0.94)',
    width: 40, height: 40, borderRadius: 8, alignItems: 'center', justifyContent: 'center',
  },
  doneButton: {
    position: 'absolute', top: 56, right: 16, backgroundColor: 'rgba(255,255,255,0.96)',
    borderRadius: 10, paddingHorizontal: 16, paddingVertical: 10,
  },
  doneButtonText: { color: '#2a6bb5', fontSize: 16, fontWeight: '600' },
});
