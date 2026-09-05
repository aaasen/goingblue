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
Variables: Humidity, freezing level
Window start: Tuesday the 8th, 9am
Filename: overview

## High Altitude

Caption: "High-altitude winds and freezing level forecasts for mountaineering"
Location: Denali
Model: Auto
Variables: Freezing level, pressure-level winds at 400, 500, and 600 hPa
Window start: Friday the 11th, 3am
Filename: altitude

## Cloud Cover

Caption: "Avoid whiteouts and flat light with detailed cloud cover"
Location: Jiehkkevarri
Model: Auto
Variables: Detailed clouds
Window start: Saturday the 5th, 3am
Filename: cloud

## AQI

Caption: "Plan around wildfire smoke with AQI forecasts"
Location: 40.558,-112.577 (Lowe peak by SLC)
Model: Auto
Variables: US AQI variables
Window start: Friday the 4th, 6pm
Filename: aqi

## Model Agreement

Caption: "Compare forecasts from NOAA, ECMWF, GEM, and ICON models"
Location: Cerro Torre
Model: ECMWF, NOAA, GEM, ICON
Variables: Model agreement
Window start: Tuesday the 8th, 8am
Filename: agreement

# Tips

1. How to scrub: Tap the mini meteogram at the target day to jump the window there, then drag the table horizontally to align the first column. Drag slowly and hold at the end, otherwise it flings.

# Regenerating seeded data

Each shot's weather is recorded once from live Open-Meteo and replayed through the current codec at seed time, so a codec change never needs a re-record. Re-record one shot with `pnpm record-shot <name>` or all of them with pnpm record-shot --all. Shots are defined in `screenshots/shots.mts`. Add a new shot at the end of the table, since a request's message code is its position and moving earlier shots invalidates their recordings. After recording, run `pnpm test` to confirm every fixture replays, then seed again with step 3.
