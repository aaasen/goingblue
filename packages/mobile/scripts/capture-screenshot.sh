#!/bin/bash
#
# Capture one App Store screenshot from the booted simulator.
#
#   ./scripts/capture-screenshot.sh meteogram   → screenshots/01-meteogram.png
#   ./scripts/capture-screenshot.sh builder     → screenshots/02-builder.png
#
# Navigate the app to the screen you want, then run this. Files are numbered in capture order,
# which is the order App Store Connect shows them in, so capture them in the order you want them
# read. Run --clear when you're done to hand the status bar back to the simulator.
#
# App Store Connect wants one set of iPhone screenshots at the 6.9" size. There is no iPad set to
# take: app.json sets supportsTablet: false.
set -euo pipefail

# 6.9" iPhone, portrait — what an iPhone 17 Pro Max simulator captures natively. Landscape counts
# as the same size transposed, since the app rotates.
EXPECTED="1320x2868"
EXPECTED_LANDSCAPE="2868x1320"

MOBILE_DIR="$(cd "$(dirname "$0")/.." && pwd)"
OUT_DIR="${SCREENSHOT_DIR:-$MOBILE_DIR/screenshots}"

die() { echo "error: $*" >&2; exit 1; }

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
apply_status_bar() {
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

next_index() {
  local max=0 base num
  shopt -s nullglob
  for f in "$OUT_DIR"/[0-9][0-9]-*.png; do
    base="$(basename "$f")"
    # 10# forces base 10, so 08 and 09 don't read as invalid octal.
    num=$((10#${base:0:2}))
    if (( num > max )); then max=$num; fi
  done
  shopt -u nullglob
  printf '%02d' $((max + 1))
}

if [ "${1:-}" = "--clear" ]; then
  xcrun simctl status_bar booted clear
  echo "status bar restored"
  exit 0
fi

NAME="${1:-}"
[ -n "$NAME" ] || die "usage: $(basename "$0") <name> | --clear"
# The name becomes part of a filename and nothing else, so keep it to something a filename likes.
[[ "$NAME" =~ ^[a-z0-9-]+$ ]] || die "name must be lowercase letters, digits and dashes: '$NAME'"

DEVICE="$(booted_name)"
[ -n "$DEVICE" ] || die "no booted simulator — start one with: npx expo run:ios --configuration Release --device \"iPhone 17 Pro Max\""

mkdir -p "$OUT_DIR"
apply_status_bar

OUT="$OUT_DIR/$(next_index)-$NAME.png"
xcrun simctl io booted screenshot "$OUT" >/dev/null 2>&1

SIZE="$(sips -g pixelWidth -g pixelHeight "$OUT" | awk '/pixelWidth/{w=$2} /pixelHeight/{h=$2} END{print w "x" h}')"
echo "$(basename "$OUT")  $SIZE  ($DEVICE)"

if [ "$SIZE" != "$EXPECTED" ] && [ "$SIZE" != "$EXPECTED_LANDSCAPE" ]; then
  # Not fatal: App Store Connect states the sizes it accepts and is the authority. But the usual
  # cause is the wrong simulator being booted, which is worth catching before a whole set is shot.
  echo "warning: expected $EXPECTED for the 6.9\" set — is '$DEVICE' the right simulator?" >&2
fi
