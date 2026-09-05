#!/bin/bash
#
# Capture one store screenshot from the booted iOS simulator or the running Android emulator.
#
#   ./scripts/capture-screenshot.sh meteogram             → screenshots/meteogram.png
#   ./scripts/capture-screenshot.sh --android meteogram   → screenshots/android/meteogram.png
#
# Navigate the app to the screen you want, then run this. Capturing the same name again overwrites
# it, so a fumbled shot is just re-shot. Listing order is not decided here: it comes from the
# capture's position in CAPTIONS_LIST in frame-screenshots.py, which numbers the framed output.
# Run --clear (with --android for the emulator) when you're done to hand the status bar back.
#
# App Store Connect wants one set of iPhone screenshots at the 6.9" size. There is no iPad set to
# take: app.json sets supportsTablet: false. Google Play takes phone screenshots at any size
# between 320 and 3840px per side; the Pixel 9 emulator's native 1080x2424 is the reference here
# so the set stays uniform. With several Android targets attached, ANDROID_SERIAL picks one.
set -euo pipefail

MOBILE_DIR="$(cd "$(dirname "$0")/.." && pwd)"

die() { echo "error: $*" >&2; exit 1; }

PLATFORM=ios
if [ "${1:-}" = "--android" ]; then
  PLATFORM=android
  shift
fi

if [ "$PLATFORM" = ios ]; then
  # 6.9" iPhone, portrait — what an iPhone 17 Pro Max simulator captures natively. Landscape
  # counts as the same size transposed, since the app rotates.
  EXPECTED="1320x2868"
  EXPECTED_LANDSCAPE="2868x1320"
  OUT_DIR="${SCREENSHOT_DIR:-$MOBILE_DIR/screenshots}"
else
  EXPECTED="1080x2424"
  EXPECTED_LANDSCAPE="2424x1080"
  OUT_DIR="${SCREENSHOT_DIR:-$MOBILE_DIR/screenshots/android}"
fi

booted_name() {
  # simctl prints "    iPhone 17 Pro Max (UUID) (Booted) " — take everything before the UUID. The
  # trailing `.*` is load-bearing: simctl leaves a space after (Booted), so anchoring on it fails.
  xcrun simctl list devices booted | sed -n 's/^ *\(.*\) ([0-9A-Fa-f-]\{36\}) (Booted).*$/\1/p' | head -1
}

# Freeze the clock at 9:41 with a full battery and no reception. Apple's own marketing shots use
# 9:41, and without a fixed status bar every screenshot carries whatever time and battery level the
# simulator had — which reads as a snapshot of someone's laptop rather than a product shot.
#
# No reception is the point of the product, not an accident: the forecast on screen was decoded on
# the phone from a satellite message, so empty signal dots are what the app is *for*. Note this is
# cosmetic only — simctl does not touch the simulator's real connectivity, so the app still reaches
# the network normally while these are being shot.
#
# The specific flags, each of which was picked by shooting the alternatives and looking at them:
#   cellularMode failed  — empty grey signal dots. 'searching' draws them after the battery, which
#                          looks like a rendering bug; 'notSupported' drops them entirely and reads
#                          as a phone with no SIM rather than one out of range.
#   dataNetwork hide     — without it you get "no service" sitting next to a cheerful LTE badge.
#   no --wifiMode flag   — any value draws a wifi glyph. Omitting it leaves the slot empty, which
#                          is what a phone off the grid actually shows.
#   batteryState discharging — 'charged' means plugged in, and draws the charging bolt.
apply_status_bar_ios() {
  # Clear first: overrides accumulate across runs, so a wifi glyph set by an earlier invocation
  # survives into this one and no flag here would unset it.
  xcrun simctl status_bar booted clear
  xcrun simctl status_bar booted override \
    --time "9:41" \
    --batteryState discharging --batteryLevel 100 \
    --dataNetwork hide \
    --cellularMode failed --cellularBars 0 \
    --operatorName ""
}

# The same status bar on Android, through SystemUI's demo mode: the clock, a full unplugged
# battery, no notification icons, and no radio glyphs at all. Empty signal bars are not on offer
# here: Android 16's demo mode draws a data badge ("3G") next to any mobile icon whatever
# datatype it is given, and the emulator's real radio at zero signal adds an exclamation mark.
# A bar with no cellular icon is what a Pixel without a SIM shows, which reads fine. Demo mode
# has to be allowed once per device before the broadcasts do anything.
#
# Exit before entering: some seconds after mobile is hidden, SystemUI decides the phone has lost
# terrestrial service and adds a satellite icon, and repeating "hide" does not reset that. A
# fresh demo session does, and the capture follows within the grace period.
demo() { adb shell am broadcast -a com.android.systemui.demo "$@" >/dev/null; }
apply_status_bar_android() {
  adb shell settings put global sysui_demo_allowed 1
  demo -e command exit
  demo -e command enter
  demo -e command clock -e hhmm 0941
  demo -e command battery -e level 100 -e plugged false
  demo -e command network -e wifi hide
  demo -e command network -e mobile hide
  demo -e command notifications -e visible false
  demo -e command status -e volume hide -e bluetooth hide -e location hide -e alarm hide -e mute hide
}

if [ "${1:-}" = "--clear" ]; then
  if [ "$PLATFORM" = ios ]; then
    xcrun simctl status_bar booted clear
  else
    demo -e command exit
  fi
  echo "status bar restored"
  exit 0
fi

NAME="${1:-}"
[ -n "$NAME" ] || die "usage: $(basename "$0") [--android] <name> | [--android] --clear"
# The name becomes part of a filename and nothing else, so keep it to something a filename likes.
[[ "$NAME" =~ ^[a-z0-9-]+$ ]] || die "name must be lowercase letters, digits and dashes: '$NAME'"

mkdir -p "$OUT_DIR"
OUT="$OUT_DIR/$NAME.png"

if [ "$PLATFORM" = ios ]; then
  DEVICE="$(booted_name)"
  [ -n "$DEVICE" ] || die "no booted simulator — start one with: npx expo run:ios --configuration Release --device \"iPhone 17 Pro Max\""
  apply_status_bar_ios
  xcrun simctl io booted screenshot "$OUT" >/dev/null 2>&1
else
  DEVICE="$(adb get-serialno 2>/dev/null || true)"
  [ -n "$DEVICE" ] && [ "$DEVICE" != unknown ] || die "no Android device — start the emulator with: emulator -avd Pixel_9_API_36"
  apply_status_bar_android
  # Demo mode redraws the bar on the next frame; without a pause the capture can catch the old one.
  sleep 0.5
  adb exec-out screencap -p > "$OUT"
fi

SIZE="$(sips -g pixelWidth -g pixelHeight "$OUT" | awk '/pixelWidth/{w=$2} /pixelHeight/{h=$2} END{print w "x" h}')"
echo "$(basename "$OUT")  $SIZE  ($DEVICE)"

if [ "$SIZE" != "$EXPECTED" ] && [ "$SIZE" != "$EXPECTED_LANDSCAPE" ]; then
  # Not fatal: the store states the sizes it accepts and is the authority. But the usual cause is
  # the wrong simulator being booted, which is worth catching before a whole set is shot.
  echo "warning: expected $EXPECTED for the $PLATFORM set — is '$DEVICE' the right device?" >&2
fi
