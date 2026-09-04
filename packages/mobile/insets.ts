import { Platform } from 'react-native';
import Constants from 'expo-constants';

// The page's scroll view underlaps the system chrome, so what it must clear depends on the
// orientation. Portrait: the status bar — resting content seats one bar-height down, and the
// meteogram docks its floating strip on the same line, with the parked location map behind the
// clock above it. iPhone landscape: iOS hides the status bar, so the top needs nothing and the
// strip docks flush with the top of the screen — but the camera cutout swings to the sides, so
// the page insets left and right by the same measure instead, which keeps the meteogram's rail
// clear of the cutout (the cutout's depth is what the portrait status bar height measures).
// iPads and Android keep their status bar in landscape and have no side cutout, so they keep
// the portrait rule. expo-constants rather than a safe-area dependency: these two numbers are
// the only insets the layout needs, and statusBarHeight is measured at launch in portrait,
// which is the measure both cases want.
export function pageInsets(width: number, height: number): { top: number; side: number } {
  const phoneLandscape = Platform.OS === 'ios' && !Platform.isPad && width > height;
  return phoneLandscape
    ? { top: 0, side: Constants.statusBarHeight }
    : { top: Constants.statusBarHeight, side: 0 };
}
