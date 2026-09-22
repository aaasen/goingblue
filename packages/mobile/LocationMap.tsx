import { useEffect, useMemo, useRef, useState } from 'react';
import { ActivityIndicator, Alert, Modal, StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import {
  Camera, GeoJSONSource, Images, Layer, Map, Marker,
  type CameraRef, type PressEvent, type PressEventWithFeatures, type SymbolLayerSpecification,
} from '@maplibre/maplibre-react-native';
import MaterialCommunityIcons from '@expo/vector-icons/MaterialCommunityIcons';
import type { NativeSyntheticEvent } from 'react-native';
import { MAX_ZOOM, MIN_ZOOM } from './basemapStyle';
import { useBasemapStyle } from './useBasemapStyle';
import { palette } from './palette';
import { favoriteKey, type Favorite } from './favorites';
import FavoriteSheet from './FavoriteSheet';
import OfflineMapsScreen from './OfflineMapsScreen';
import type { CoordFormat } from './settings';

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
  // The phone's last known position, drawn as a blue dot. The pin stays the point of interest.
  userCoord?: LatLon | null;
  // When provided, a locate button asks for a fresh fix and the map moves to whatever comes back.
  // Null means no fix; the caller has already told the user why.
  onLocate?: () => Promise<LatLon | null>;
  locating?: boolean;
  // Whether the pin is riding the phone's position. Only changes the button's glyph: filled while
  // following, outlined when not, the convention map apps use for their tracking button.
  following?: boolean;
  // Saved points, drawn as stars with their names. Tapping one reports it, so the caller can put
  // the pin on the favorite's own coordinates rather than wherever the finger landed.
  favorites?: readonly Favorite[];
  onPickFavorite?: (f: Favorite) => void;
  // When provided, a star button saves a point under a name, through a sheet that starts on the
  // marked point, or takes the favorite already there back out, after asking. Filled while the
  // point is a favorite, greyed while there is no point to start from.
  onSaveFavorite?: (name: string, coord: LatLon) => void;
  onRemoveFavorite?: () => void;
  currentFavorite?: Favorite | null;
  // Points with a saved forecast, drawn as gray dots. Tapping one reports it, so the caller can
  // put the pin on the forecast's own coordinates.
  pastPoints?: readonly LatLon[];
  onPickPast?: (c: LatLon) => void;
  // How the favorite sheet writes the point it is saving.
  coordFormat?: CoordFormat;
  // When set, a download button opens the offline maps sheet.
  offlineMaps?: boolean;
}

// The picker's starting point before any coordinate is set: as far out as the basemap allows,
// centered so the 300pt builder map holds North America from the Florida Keys to the Arctic
// coast. Mercator spends most of that height on the north, so the Arctic islands are out.
const DEFAULT_VIEW = { center: [-110, 54] as [number, number], zoom: MIN_ZOOM };
// Zoom applied once a coordinate exists — tight enough to confirm the spot, loose enough to nudge it.
const PICKED_ZOOM = 9;

const MAP_IMAGES = {
  'peak-triangle': require('./assets/peak-triangle.png'),
  'favorite-star': require('./assets/favorite-star.png'),
};

// MapLibre Native map over the PMTiles basemap (see basemapStyle.ts). One component for both the
// builder's picker and the decoder's preview — they differ only in height and in whether tapping
// picks a coordinate. The picker's corner button opens the same map fullscreen; the preview has no
// controls.
export default function LocationMap({ coord, onPick, height, active = true, userCoord, onLocate, locating = false, following = false, favorites, onPickFavorite, onSaveFavorite, onRemoveFavorite, currentFavorite = null, pastPoints, onPickPast, coordFormat = 'latlon', offlineMaps = false }: Props) {
  const cameraRef = useRef<CameraRef>(null);
  const fullscreenCameraRef = useRef<CameraRef>(null);
  const wasActive = useRef(active);
  const [fullscreen, setFullscreen] = useState(false);
  const [favoriteSheet, setFavoriteSheet] = useState(false);
  const [offlineMapsSheet, setOfflineMapsSheet] = useState(false);
  const [mapRevision, setMapRevision] = useState(0);
  const interactive = onPick != null;
  const mapStyle = useBasemapStyle();
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

  async function locate() {
    const c = await onLocate?.();
    if (!c) return;
    const stop = { center: [c.lon, c.lat] as [number, number], zoom: PICKED_ZOOM, duration: 250 };
    cameraRef.current?.easeTo(stop);
    fullscreenCameraRef.current?.easeTo(stop);
  }

  // Each feature carries its favorite's key: coordinates that come back from a native hit test
  // have been through a float, and the key has not.
  const favoriteFeatures = useMemo<GeoJSON.FeatureCollection | null>(() => {
    if (!favorites || favorites.length === 0) return null;
    return {
      type: 'FeatureCollection',
      features: favorites.map((f) => ({
        type: 'Feature',
        geometry: { type: 'Point', coordinates: [f.lon, f.lat] },
        properties: { key: favoriteKey(f), name: f.name },
      })),
    };
  }, [favorites]);

  // A tap that lands on a star goes here instead of to the map's own press. Stopped from
  // bubbling so it can't also pick the point under the finger.
  const onFavoritePress = interactive && onPickFavorite
    ? (e: NativeSyntheticEvent<PressEventWithFeatures>) => {
        e.stopPropagation();
        const key = e.nativeEvent.features[0]?.properties?.key;
        const hit = favorites?.find((f) => favoriteKey(f) === key);
        if (hit) onPickFavorite(hit);
      }
    : undefined;

  const pastFeatures = useMemo<GeoJSON.FeatureCollection | null>(() => {
    if (!pastPoints || pastPoints.length === 0) return null;
    return {
      type: 'FeatureCollection',
      features: pastPoints.map((p) => ({
        type: 'Feature',
        geometry: { type: 'Point', coordinates: [p.lon, p.lat] },
        properties: { key: favoriteKey(p) },
      })),
    };
  }, [pastPoints]);

  const onPastPress = interactive && onPickPast
    ? (e: NativeSyntheticEvent<PressEventWithFeatures>) => {
        e.stopPropagation();
        const key = e.nativeEvent.features[0]?.properties?.key;
        const hit = pastPoints?.find((p) => favoriteKey(p) === key);
        if (hit) onPickPast(hit);
      }
    : undefined;

  const onPress = interactive
    ? (e: NativeSyntheticEvent<PressEvent>) => {
        const [lon, lat] = e.nativeEvent.lngLat;
        onPick({ lat, lon });
      }
    : undefined;

  // The preview stays locked so it doesn't fight the parent ScrollView.
  function renderMap(ref: React.RefObject<CameraRef | null>, key?: number) {
    if (!mapStyle) return null;
    return (
      <Map
        key={key}
        style={StyleSheet.absoluteFill}
        mapStyle={mapStyle}
        onPress={onPress}
        dragPan={interactive}
        touchZoom={interactive}
        doubleTapZoom={interactive}
        touchRotate={false}
        touchPitch={false}
        compass={false}
        logo={false}
        attribution={false}
      >
        <Images images={MAP_IMAGES} />
        <Camera ref={ref} initialViewState={initialViewState} minZoom={MIN_ZOOM} maxZoom={MAX_ZOOM} />
        {/* A style layer rather than a Marker: markers are native views over the GL surface, so a
            layer always sits under the pin, and a forecast on top of the phone's position keeps the
            pin in front. */}
        {userCoord && (
          <GeoJSONSource id="user-location" data={{ type: 'Point', coordinates: [userCoord.lon, userCoord.lat] }}>
            <Layer id="user-location-dot" type="circle" paint={USER_DOT_PAINT} />
          </GeoJSONSource>
        )}
        {pastFeatures && (
          <GeoJSONSource id="past-forecasts" data={pastFeatures} onPress={onPastPress}>
            <Layer id="past-forecast-dots" type="circle" paint={PAST_DOT_PAINT} />
          </GeoJSONSource>
        )}
        {favoriteFeatures && (
          <GeoJSONSource id="favorites" data={favoriteFeatures} onPress={onFavoritePress}>
            <Layer id="favorite-stars" type="symbol" layout={FAVORITE_LAYOUT} paint={FAVORITE_PAINT} />
          </GeoJSONSource>
        )}
        {coord && (
          <Marker lngLat={[coord.lon, coord.lat]} anchor="bottom">
            <View style={styles.pin}>
              <View style={styles.pinBalloon}>
                <View style={styles.pinDot} />
              </View>
            </View>
          </Marker>
        )}
      </Map>
    );
  }

  function renderLocateButton(style: object) {
    if (!onLocate) return null;
    return (
      <TouchableOpacity
        style={style}
        onPress={locate}
        disabled={locating}
        accessibilityRole="button"
        accessibilityLabel="Use my current location"
      >
        {locating
          ? <ActivityIndicator color={palette.link} />
          : <MaterialCommunityIcons name={following ? 'crosshairs-gps' : 'crosshairs'} size={24} color={palette.link} />}
      </TouchableOpacity>
    );
  }

  // The star toggles: on a point that isn't saved it opens the name sheet, on a favorite it
  // removes it. Removal asks first, since the name goes with it. An Alert rather than a sheet of
  // our own: it presents over the fullscreen modal without having to be that modal's child.
  function onStarPress() {
    if (!currentFavorite) {
      setFavoriteSheet(true);
      return;
    }
    Alert.alert('Delete 1 favorite?', undefined, [
      { text: 'Cancel', style: 'cancel' },
      { text: 'Delete', style: 'destructive', onPress: () => onRemoveFavorite?.() },
    ]);
  }

  function renderFavoriteButton(style: object) {
    if (!onSaveFavorite) return null;
    const saved = currentFavorite != null;
    return (
      <TouchableOpacity
        style={[style, !coord && styles.cornerButtonDisabled]}
        onPress={onStarPress}
        disabled={!coord}
        accessibilityRole="button"
        accessibilityLabel={saved ? 'Delete favorite' : 'Add favorite'}
      >
        <MaterialCommunityIcons name={saved ? 'star' : 'star-outline'} size={26} color={saved ? FAVORITE : palette.link} />
      </TouchableOpacity>
    );
  }

  function renderOfflineMapsButton(style: object) {
    if (!offlineMaps) return null;
    return (
      <TouchableOpacity
        style={style}
        onPress={() => setOfflineMapsSheet(true)}
        accessibilityRole="button"
        accessibilityLabel="Offline maps"
      >
        <MaterialCommunityIcons name="layers-outline" size={26} color={palette.link} />
      </TouchableOpacity>
    );
  }

  // Rendered inside whichever surface is showing. Under the fullscreen modal it has to be that
  // modal's child: iOS will not present a second modal from beneath one already up.
  function renderFavoriteSheet() {
    if (!favoriteSheet || !coord || !onSaveFavorite) return null;
    return (
      <FavoriteSheet
        coord={coord}
        favorites={favorites ?? []}
        coordFormat={coordFormat}
        onSave={(name, c) => { onSaveFavorite(name, c); setFavoriteSheet(false); }}
        onClose={() => setFavoriteSheet(false)}
      />
    );
  }

  // Same rule as the favorite sheet.
  function renderOfflineMapsSheet() {
    if (!offlineMaps) return null;
    return <OfflineMapsScreen visible={offlineMapsSheet} onClose={() => setOfflineMapsSheet(false)} />;
  }

  return (
    <View style={[styles.wrap, height == null ? styles.square : { height }]}>
      {!fullscreen && (
        <>
          {renderMap(cameraRef, mapRevision)}
          {mapStyle && <Text style={styles.attribution}>© OpenStreetMap</Text>}
          {interactive && (
            <TouchableOpacity
              style={styles.fullscreenButton}
              onPress={() => setFullscreen(true)}
              accessibilityRole="button"
              accessibilityLabel="Open map fullscreen"
            >
              {/* Material's fullscreen glyph rather than a ⛶ text character, which several
                  platforms draw as a plain box or a missing-glyph slug. */}
              <MaterialCommunityIcons name="fullscreen" size={26} color={palette.link} />
            </TouchableOpacity>
          )}
          {renderLocateButton(styles.locateButton)}
          {renderFavoriteButton(styles.favoriteButton)}
          {renderOfflineMapsButton(styles.offlineMapsButton)}
          {renderFavoriteSheet()}
          {renderOfflineMapsSheet()}
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
            {renderMap(fullscreenCameraRef)}
            {mapStyle && <Text style={styles.attribution}>© OpenStreetMap</Text>}
            <TouchableOpacity
              style={styles.doneButton}
              onPress={() => setFullscreen(false)}
              accessibilityRole="button"
            >
              <Text style={styles.doneButtonText}>Done</Text>
            </TouchableOpacity>
            {renderLocateButton(styles.fullscreenLocateButton)}
            {renderFavoriteButton(styles.fullscreenFavoriteButton)}
            {renderOfflineMapsButton(styles.fullscreenOfflineMapsButton)}
            {renderFavoriteSheet()}
            {renderOfflineMapsSheet()}
          </View>
        </Modal>
      )}
    </View>
  );
}

const PIN = '#d0433b';
// The star's fill, on the button and in the map icon.
const FAVORITE = '#f5b301';
// The phone's position, in the blue-dot idiom every map app uses, so it reads as "you are here"
// rather than as a second point of interest.
const USER_DOT_PAINT = {
  'circle-radius': 7,
  'circle-color': palette.brand,
  'circle-stroke-width': 3,
  'circle-stroke-color': '#ffffff',
  'circle-pitch-alignment': 'map',
} as const;
// Saved forecasts: quieter and smaller than the phone's dot, so they read as places visited
// rather than as a position.
const PAST_DOT_PAINT = {
  'circle-radius': 5,
  'circle-color': '#5f6b7a',
  'circle-stroke-width': 2,
  'circle-stroke-color': '#ffffff',
  'circle-pitch-alignment': 'map',
} as const;
// Favorites: a star with the name under it, in the face and halo the basemap labels its peaks
// with. The star always draws and is never pushed out by a basemap label; the name gives way
// when there is no room for it. The star carries a dark rim rather than a white one, which
// would vanish on a glacier.
const FAVORITE_LAYOUT: SymbolLayerSpecification['layout'] = {
  'icon-image': 'favorite-star',
  'icon-allow-overlap': true,
  'icon-ignore-placement': true,
  'text-field': ['get', 'name'],
  'text-font': ['Noto Sans Medium'],
  'text-size': 12,
  'text-anchor': 'top',
  'text-offset': [0, 0.8],
  'text-optional': true,
};
const FAVORITE_PAINT: SymbolLayerSpecification['paint'] = { 'text-color': '#7a5200', 'text-halo-color': '#ffffff', 'text-halo-width': 1.4 };
// Width of the marker's square before it is turned; the point it lands on is a corner, so the
// shape reaches half its diagonal below the box center — BALLOON * (√2 - 1) / 2 past the bottom.
const BALLOON = 26;
const TIP_DROP = Math.round((BALLOON * (Math.SQRT2 - 1)) / 2);

const styles = StyleSheet.create({
  // Full-bleed by default: no outer margin, square corners. Callers place and space it.
  wrap: { overflow: 'hidden', backgroundColor: '#e5e8ee' },
  square: { width: '100%', aspectRatio: 1 },
  fullscreenWrap: { flex: 1, backgroundColor: '#e5e8ee' },
  // Teardrop marker: a square rounded on three corners and left sharp on the fourth, turned 45°
  // so the sharp corner points down. A rotation doesn't change the layout box, so the turned shape
  // hangs TIP_DROP past all four sides; padding gives that back, which both keeps the tip on the
  // anchor point and stops the widest part being clipped by the marker container.
  pin: { alignItems: 'center', padding: TIP_DROP },
  pinBalloon: {
    width: BALLOON, height: BALLOON, backgroundColor: PIN,
    borderRadius: BALLOON / 2, borderBottomRightRadius: 0,
    borderWidth: 2, borderColor: '#ffffff',
    alignItems: 'center', justifyContent: 'center',
    transform: [{ rotate: '45deg' }],
    shadowColor: '#000', shadowOpacity: 0.3, shadowRadius: 3, shadowOffset: { width: 0, height: 2 },
    elevation: 4,
  },
  // Rotates with its parent, which a circle doesn't show. The rounded head is centred on the
  // square, so centring the dot centres it in the head.
  pinDot: { width: 8, height: 8, borderRadius: 4, backgroundColor: '#ffffff' },
  // The one credit that belongs on the map itself (ODbL); the full provider list is on the
  // offline maps sheet and the terms page.
  attribution: {
    position: 'absolute', bottom: 4, right: 8, fontSize: 10, color: 'rgba(60,60,67,0.6)',
  },
  fullscreenButton: {
    position: 'absolute', top: 12, right: 12, backgroundColor: 'rgba(255,255,255,0.94)',
    width: 40, height: 40, borderRadius: 8, alignItems: 'center', justifyContent: 'center',
  },
  // Stacked under the fullscreen button inline, and under Done in the modal: locate, then the star.
  locateButton: {
    position: 'absolute', top: 60, right: 12, backgroundColor: 'rgba(255,255,255,0.94)',
    width: 40, height: 40, borderRadius: 8, alignItems: 'center', justifyContent: 'center',
  },
  fullscreenLocateButton: {
    position: 'absolute', top: 108, right: 16, backgroundColor: 'rgba(255,255,255,0.96)',
    width: 40, height: 40, borderRadius: 10, alignItems: 'center', justifyContent: 'center',
  },
  favoriteButton: {
    position: 'absolute', top: 108, right: 12, backgroundColor: 'rgba(255,255,255,0.94)',
    width: 40, height: 40, borderRadius: 8, alignItems: 'center', justifyContent: 'center',
  },
  fullscreenFavoriteButton: {
    position: 'absolute', top: 156, right: 16, backgroundColor: 'rgba(255,255,255,0.96)',
    width: 40, height: 40, borderRadius: 10, alignItems: 'center', justifyContent: 'center',
  },
  // Alone in the top-left corner, level with the fullscreen button inline and with Done in the modal.
  offlineMapsButton: {
    position: 'absolute', top: 12, left: 12, backgroundColor: 'rgba(255,255,255,0.94)',
    width: 40, height: 40, borderRadius: 8, alignItems: 'center', justifyContent: 'center',
  },
  fullscreenOfflineMapsButton: {
    position: 'absolute', top: 56, left: 16, backgroundColor: 'rgba(255,255,255,0.96)',
    width: 40, height: 40, borderRadius: 10, alignItems: 'center', justifyContent: 'center',
  },
  cornerButtonDisabled: { opacity: 0.4 },
  doneButton: {
    position: 'absolute', top: 56, right: 16, backgroundColor: 'rgba(255,255,255,0.96)',
    borderRadius: 10, paddingHorizontal: 16, paddingVertical: 10,
  },
  doneButtonText: { color: palette.link, fontSize: 16, fontWeight: '600' },
});
