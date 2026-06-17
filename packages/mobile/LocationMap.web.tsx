// Web fallback for LocationMap. react-native-maps has no web implementation, so on web (used only
// for development convenience) the map renders nothing — the lat/lon text inputs remain the way to
// set a custom location, and the decoder simply omits the map.

export interface LatLon {
  lat: number;
  lon: number;
}

interface Props {
  coord: LatLon | null;
  onPick?: (c: LatLon) => void;
  height?: number;
}

export default function LocationMap(_props: Props) {
  return null;
}
