---
name: screenshots
description: Capture screenshots for release on the App Store
---

The App Store requires app screenshots that are updated on each release. This is how to take them.

This is the process for taking screenshots. Run everything from `packages/mobile`. 
1. Start Metro with `pnpm start` if it is not already running. 
2. Launch the "iPhone 17 Pro Max" simulator and make sure no other simulator is booted. 
3. Import test data with `pnpm seed-shots --device "iPhone 17 Pro Max" --bundle com.laneaasen.weather.dev`.
4. Open the simulator, launch the dev build, and turn off the gear by tapping the floating gear and turning off "Tools button". If there is a back link visible in the status bar, close the app and open it again.
5. Check that the data was imported. Scroll down to "Saved forecasts" and check for 8 entries. 
6. Take all of the shots listed under the "Screenshots" header. Scroll the start of the meteogram to the specified window start. Scroll vertically so that the top of the map is just off the very top of the screen (under the status bar) and the location the map is showing is visible below the camera cutout. Anything in the lower rounded section of the screen will be cut off from the framed screenshots. Use `scripts/capture-screenshot.sh <filename>` to capture the screenshots once the simulator is in position.
7. Once all screenshots are taken, frame them with `scripts/frame-screenshots.py`. Update the `CAPTIONS_LIST` to match the order and text of the screenshots defined here. This will generate screenshots in `screenshots/framed/` and also a `screenshots/readme.png` which merges all of the screenshots.
8. Cleanup. Run `scripts/capture-screenshot.sh --clear` to give the simulator control of the clock and battery.

# Screenshots

## Overview

Caption: "Expedition weather forecasts via inReach, ZOLEO, and iPhone satellite"
Location: Mont Blanc
Model: Auto
Variables: Humidity, freezing level, detailed clouds
Window start: Tuesday the 8th, 9am
Filename: overview

## High Altitude

Caption: "High-altitude winds and freezing level forecasts for mountaineering"
Location: Denali
Model: Auto
Variables: Humidity, freezing level, pressure-level winds at 400, 500, and 600 hPa
Window start: Friday the 11th, 3am
Filename: altitude

## Cloud Cover

Caption: "Avoid whiteouts and flat light with detailed cloud cover"
Location: Jiehkkevarri summit (69.46921,19.87873)
Model: Auto
Variables: Humidity, detailed clouds
Window start: Saturday the 5th, 4am
Filename: cloud

## AQI

Caption: "Plan around wildfire smoke with AQI forecasts"
Location: Eldorado Peak, North Cascades (48.53752,-121.13440)
Model: Auto
Variables: Precipitation probability, US AQI variables
Window start: Friday the 4th, 7pm
Filename: aqi

## Model Agreement

Caption: "Compare forecasts from NOAA, ECMWF, GEM, and ICON models"
Location: Monte Fitz Roy summit (-49.27125,-73.04321)
Model: ECMWF, NOAA, GEM, ICON. Select ECMWF in the compare pills before capturing.
Variables: Humidity, model agreement
Window start: Tuesday the 8th, 8am
Filename: agreement

# Tips

1. How to scrub: Tap the mini meteogram at the target day to jump the window there, then drag the table horizontally to align the first column. Drag slowly and hold at the end, otherwise it flings.

# Android

Google Play takes the same five shots. Run everything from `packages/mobile`.
1. Start Metro with `pnpm start` if it is not already running.
2. Start the emulator with `emulator -avd Pixel_9_API_36` and make sure no other Android device is attached. Run `adb reverse tcp:8081 tcp:8081` so the dev client can reach Metro at localhost.
3. If native dependencies changed since the last build, reinstall the debug build with `npx expo run:android --no-bundler`. A reinstall wipes the app's data, so do this before seeding.
4. Import test data with `pnpm seed-shots --android`. This writes the app's SQLite database through `run-as`, so it only works with the debug build, not the preview one.
5. Open the bundle in the dev client with `adb shell am start -a android.intent.action.VIEW -d "exp+mobile://expo-development-client/?url=http%3A%2F%2Flocalhost%3A8081" -p com.laneaasen.weather`. Both installed builds claim the scheme, so the package flag matters. Turn off the floating gear with the "Tools button" switch in the dev menu, as on iOS.
6. Check for 8 entries under "Saved forecasts", then take the same shots as above. Use `scripts/capture-screenshot.sh --android <filename>`; captures land in `screenshots/android/`.
7. Frame with `scripts/frame-screenshots.py --android`. Output goes to `screenshots/android/framed/` at 1080x2160, since Google Play caps screenshots at 2:1. `ANDROID_CAPTIONS` overrides the overview caption, which names the iPhone in the App Store set.
8. Cleanup. Run `scripts/capture-screenshot.sh --android --clear` to leave demo mode.

Tips:
1. `adb shell input swipe x1 y x2 y <ms>` drives everything. A swipe over 1.5 s lands without flinging. One meteogram column is about 90 px on the Pixel 9, and the first 20 px of a drag are eaten as touch slop, so nudge with 40 px rather than 20. Tapping the mini strip on the left half of a day lands at its start.
2. The page scroll from the post-Load position to the framed position is a 235 px upward drag from the day header row.
3. The status bar hides the cellular icon instead of showing empty bars: Android 16's demo mode draws a "3G" badge next to any mobile icon. About 20 s after the icon is hidden, SystemUI adds a satellite icon; the capture script exits and re-enters demo mode to reset that, so capture straight after positioning.

# Regenerating seeded data

Each shot's weather is recorded once from live Open-Meteo and replayed through the current codec at seed time, so a codec change never needs a re-record. Re-record one shot with `pnpm record-shot <name>` or all of them with pnpm record-shot --all. Shots are defined in `screenshots/shots.mts`. Add a new shot at the end of the table, since a request's message code is its position and moving earlier shots invalidates their recordings. After recording, run `pnpm test` to confirm every fixture replays, then seed again with step 3.
