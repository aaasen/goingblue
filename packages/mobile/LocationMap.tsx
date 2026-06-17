import { StyleSheet, View, Platform } from 'react-native';
import MapView, { Marker, PROVIDER_GOOGLE, PROVIDER_DEFAULT, type MapPressEvent } from 'react-native-maps';

export interface LatLon {
  lat: number;
  lon: number;
}

interface Props {
  // The point to mark. When null, no marker is shown and the map opens on a wide default view.
  coord: LatLon | null;
  // When provided, the map is a picker: tapping or dragging the marker reports a new coordinate.
  // When omitted, the map is a read-only preview (no panning, so it doesn't fight a parent ScrollView).
  onPick?: (c: LatLon) => void;
  height?: number;
}

// Wide view of the contiguous US, used as the picker's starting point before any coordinate is set.
const DEFAULT_REGION = { latitude: 37, longitude: -96, latitudeDelta: 60, longitudeDelta: 60 };
// Zoom applied once a coordinate exists — tight enough to confirm the spot, loose enough to nudge it.
const PICKED_DELTA = 0.4;

// iOS uses Apple Maps (no API key). Android uses Google Maps, which needs the key configured under
// expo.android.config.googleMaps.apiKey in app.json.
const provider = Platform.OS === 'android' ? PROVIDER_GOOGLE : PROVIDER_DEFAULT;

// react-native-maps native map. A `.web.tsx` sibling renders nothing on web, where the map module
// isn't available — callers fall back to the lat/lon text inputs there.
export default function LocationMap({ coord, onPick, height = 200 }: Props) {
  const interactive = onPick != null;
  const initialRegion = coord
    ? { latitude: coord.lat, longitude: coord.lon, latitudeDelta: PICKED_DELTA, longitudeDelta: PICKED_DELTA }
    : DEFAULT_REGION;

  function report(latitude: number, longitude: number) {
    onPick?.({ lat: latitude, lon: longitude });
  }

  return (
    <View style={[styles.wrap, { height }]}>
      <MapView
        style={StyleSheet.absoluteFill}
        provider={provider}
        initialRegion={initialRegion}
        onPress={interactive ? (e: MapPressEvent) => report(e.nativeEvent.coordinate.latitude, e.nativeEvent.coordinate.longitude) : undefined}
        scrollEnabled={interactive}
        pitchEnabled={false}
        rotateEnabled={false}
      >
        {coord && (
          <Marker
            coordinate={{ latitude: coord.lat, longitude: coord.lon }}
            draggable={interactive}
            onDragEnd={interactive ? (e) => report(e.nativeEvent.coordinate.latitude, e.nativeEvent.coordinate.longitude) : undefined}
          />
        )}
      </MapView>
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { marginTop: 10, borderRadius: 12, overflow: 'hidden', backgroundColor: '#e5e8ee' },
});
