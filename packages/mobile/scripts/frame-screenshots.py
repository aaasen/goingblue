#!/usr/bin/env python3
"""Frame the raw simulator captures into captioned App Store screenshots.

capture-screenshot.sh shoots bare 1320x2868 frames off the simulator. App Store Connect will take
those as they are, but a listing reads better when each frame says what it is showing. This adds
the caption and the sky behind the capture, writing to screenshots/framed/ and leaving the raw
captures untouched so a caption change never means re-shooting.

Run from packages/mobile after capturing:

    python3 scripts/frame-screenshots.py

Needs Pillow (`pip install pillow`) and macOS's system font, same as render-splash.py. Neither is a
build dependency: this runs by hand when the screenshots or their captions change.

The output is 1320x2868 — the same size as the input, because that is what App Store Connect wants
for the 6.9" set. So the capture is scaled inside the canvas to make room for the caption; the
frame is not added around a full-size shot.
"""

import argparse
import sys
from pathlib import Path

from PIL import Image, ImageDraw, ImageFilter, ImageFont

# One line per screenshot, keyed by the capture's name with its ordering prefix stripped. Every
# capture must appear here — an unlisted one is an error rather than an unlabelled screenshot,
# since a silently uncaptioned frame is the kind of thing that reaches the store.
#
# Order comes from the capture's numeric prefix, not from this dict: reordering the listing means
# renaming the files in screenshots/, which is the same convention capture-screenshot.sh numbers
# them under.
# "iPhone satellite" is deliberate and should not be shortened to Apple's own feature name. See
# d2cd3c9: Apple asks that their marks be adjectives modifying a generic noun rather than standing
# alone as a feature name, and review guideline 2.3.7 polices trademarked terms in App Store
# metadata specifically — which is exactly what a screenshot caption is.
#
# ZOLEO is not named here even though the landing page mentions it: devices.ts offers only
# internet, SMS, inReach and iPhone, so a caption listing ZOLEO would name a device the picker in
# the screenshot underneath does not have.
CAPTIONS = {
    # "up to 13 days" carries a hedge that has to stay. FILL_HORIZON_DAYS = 12 sets the ceiling,
    # but reaching it depends on the reply budget, and effectiveMode() clamps Range to Auto for the
    # short-horizon (Canadian) models — so a flat "13-day forecasts" would overclaim. The caption
    # also no longer says "hourly": hourly detail and the full horizon are opposite ends of one
    # budget in layout.ts, never both at once.
    "mont-blanc": "Detailed forecasts up to 13 days without cell reception",
    "builder": "30+ weather models over SMS, inReach, or iPhone satellite",
    "denali": "Mountain weather forecasts for climbers, skiers, and alpinists",
    "air-quality": "Plan around wildfire smoke with AQI forecasts",
    "past": "All forecasts are saved for comparing multiple models",
    "detail": "Detailed forecast information including sunrise, sunset, and moon phase",
}

# The 6.9" iPhone set. Input and output are both this size (see the module docstring).
CANVAS_W, CANVAS_H = 1320, 2868

# The ground is the icon's own sky, sampled straight off assets/icon.png: it runs from #2382e4 at
# the top of the frame to #83c5fb at the horizon. Taken as a gradient rather than one flat blue
# because a flat sample of a gradient reads as neither end of it — and because the deep top is what
# the caption needs to sit on, while the pale bottom is what the (white) app UI needs to sit
# against.
SKY_TOP = "#2382e4"
SKY_BOTTOM = "#83c5fb"

# White, not the navy used elsewhere: against #2382e4 white clears 3:1, which is the bar for text
# this size, and it keeps the caption from competing with the app's own navy chrome.
TEXT_COLOR = "#ffffff"
SHADOW_ALPHA = 70

# Layout, in output pixels. The caption block is measured rather than fixed, so a long caption
# wraps to more lines and the device takes whatever height is left.
TEXT_MARGIN_X = 96
TOP_PAD = 130
CAPTION_GAP = 86      # caption block to the top of the device

# How far past the bottom of the canvas the device runs. The bottom corners are cut off by the
# canvas edge, so the screen bleeds to the bottom of the frame rather than sitting above a strip
# of sky.
#
# This is the one dial that sets how big the device is. The capture's aspect is fixed, and the top
# of the device is pinned under the caption, so reaching the bottom edge at all means scaling the
# device up — and more bleed means a wider device and thinner side margins. MIN_DEVICE_MARGIN_X is
# the backstop; the script fails rather than quietly running the device off the sides too.
DEVICE_BLEED = 120
MIN_DEVICE_MARGIN_X = 56

CAPTION_MAX_LINES = 3
CAPTION_SIZE_MAX = 82
CAPTION_SIZE_MIN = 54
LINE_SPACING = 1.16

# Screen corner radius as a fraction of screen width. The iPhone 17 Pro Max display is ~165px
# round at its native 1320px width; that ratio holds as the capture is scaled.
SCREEN_RADIUS_RATIO = 165 / 1320

# The variable system font; 'Bold' is the named instance matching RN's fontWeight 700.
FONT_PATH = "/System/Library/Fonts/SFNS.ttf"

# The README's one image: the first READERS_COMBO_N framed frames butted together. No gutter
# between them — every frame carries the same vertical sky ramp, so the seams fall on identical
# colour at every row and disappear, and the devices are already held apart by their own side
# margins. Written at 2x the width GitHub renders a README at, which is where the phone UI stops
# being legible below.
README_COMBO_N = 4
README_COMBO_W = 2560

HERE = Path(__file__).resolve().parent
SRC_DIR = HERE.parent / "screenshots"
OUT_DIR = SRC_DIR / "framed"
README_COMBO = SRC_DIR / "readme.png"


def rgb(hex_color: str) -> tuple[int, int, int]:
    h = hex_color.lstrip("#")
    return tuple(int(h[i : i + 2], 16) for i in (0, 2, 4))


def sky(size: tuple[int, int]) -> Image.Image:
    """Vertical SKY_TOP -> SKY_BOTTOM ramp. Built one pixel wide and stretched, which is both
    faster than per-pixel work over the full canvas and smoother, since the resize interpolates."""
    w, h = size
    top, bottom = rgb(SKY_TOP), rgb(SKY_BOTTOM)
    column = Image.new("RGB", (1, h))
    for y in range(h):
        t = y / (h - 1)
        column.putpixel((0, y), tuple(round(a + (b - a) * t) for a, b in zip(top, bottom)))
    return column.resize(size, Image.BILINEAR)


def load_font(size: int) -> ImageFont.FreeTypeFont:
    font = ImageFont.truetype(FONT_PATH, size)
    font.set_variation_by_name("Bold")
    return font


def wrap(text: str, font: ImageFont.FreeTypeFont, max_w: int) -> list[str]:
    """Greedy word wrap on rendered width. A single word wider than max_w gets its own line rather
    than being broken mid-word — at these sizes that only happens if a caption is unreasonable."""
    lines: list[str] = []
    line = ""
    for word in text.split():
        trial = f"{line} {word}".strip()
        if line and font.getlength(trial) > max_w:
            lines.append(line)
            line = word
        else:
            line = trial
    if line:
        lines.append(line)
    return lines


def plan_captions(captions: list[str], max_w: int) -> tuple[ImageFont.FreeTypeFont, list[list[str]]]:
    """One type size for the whole set — the largest at which *every* caption fits in
    CAPTION_MAX_LINES.

    Sized per-screenshot instead, a short caption would be set larger than a long one and the
    device below it would be a different size in every frame. The store shows these as a strip the
    reader swipes through, so anything that moves between frames reads as a mistake. Shrinking the
    whole set to its longest caption is the cost of holding the layout still.
    """
    for size in range(CAPTION_SIZE_MAX, CAPTION_SIZE_MIN - 1, -2):
        font = load_font(size)
        wrapped = [wrap(c, font, max_w) for c in captions]
        if max(len(w) for w in wrapped) <= CAPTION_MAX_LINES:
            return font, wrapped
    font = load_font(CAPTION_SIZE_MIN)
    return font, [wrap(c, font, max_w) for c in captions]


def rounded_mask(size: tuple[int, int], radius: int) -> Image.Image:
    mask = Image.new("L", size, 0)
    ImageDraw.Draw(mask).rounded_rectangle((0, 0, size[0] - 1, size[1] - 1), radius, fill=255)
    return mask


def frame(
    src: Path,
    lines: list[str],
    font: ImageFont.FreeTypeFont,
    caption_zone_h: int,
) -> Image.Image:
    canvas = sky((CANVAS_W, CANVAS_H))

    # --- caption ---------------------------------------------------------------------------
    # The zone is the tallest caption in the set; a shorter one is centred in it rather than
    # top-aligned, so two- and three-line captions sit optically level against the device below.
    line_h = int(font.size * LINE_SPACING)
    draw = ImageDraw.Draw(canvas)
    y = TOP_PAD + (caption_zone_h - len(lines) * line_h) / 2
    for line in lines:
        w = font.getlength(line)
        draw.text(((CANVAS_W - w) / 2, y), line, font=font, fill=TEXT_COLOR)
        y += line_h

    # --- device geometry -------------------------------------------------------------------
    shot = Image.open(src).convert("RGB")
    aspect = shot.width / shot.height

    # Off the caption zone, not off this frame's caption, so the device lands in the same place
    # at the same size in every frame of the set.
    device_top = TOP_PAD + caption_zone_h + CAPTION_GAP

    # There is no bezel: the capture is the device, rounded at the corners and dropped on the sky.
    # A drawn body would be a second, fake device edge inside the real one the capture already
    # has, and at this size that reads as a mistake rather than as a frame.
    device_h = CANVAS_H - device_top + DEVICE_BLEED
    device_w = int(round(device_h * aspect))
    device_x = (CANVAS_W - device_w) // 2
    if device_x < MIN_DEVICE_MARGIN_X:
        sys.exit(
            f"device is {device_w}px wide, leaving a {device_x}px side margin — reduce "
            f"DEVICE_BLEED ({DEVICE_BLEED}) or shorten the captions"
        )

    radius = int(round(device_w * SCREEN_RADIUS_RATIO))
    mask = rounded_mask((device_w, device_h), radius)

    # --- shadow ----------------------------------------------------------------------------
    # Drawn on its own padded layer so the blur has room to fall off instead of clipping at the
    # device edge. It is what separates a white app UI from a pale sky, so it does real work here
    # rather than being decoration.
    pad = 90
    shadow = Image.new("L", (device_w + 2 * pad, device_h + 2 * pad), 0)
    ImageDraw.Draw(shadow).rounded_rectangle(
        (pad, pad, pad + device_w, pad + device_h), radius, fill=SHADOW_ALPHA
    )
    shadow = shadow.filter(ImageFilter.GaussianBlur(38))
    canvas.paste(
        Image.new("RGB", shadow.size, "#0a2c52"),
        (device_x - pad, device_top - pad + 22),
        shadow,
    )

    canvas.paste(shot.resize((device_w, device_h), Image.LANCZOS), (device_x, device_top), mask)
    return canvas


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--out", type=Path, default=None, help="output directory (default screenshots/framed)")
    args = ap.parse_args()

    out_dir = args.out or OUT_DIR
    out_dir.mkdir(parents=True, exist_ok=True)

    shots = sorted(p for p in SRC_DIR.glob("[0-9][0-9]-*.png"))
    if not shots:
        sys.exit(f"no captures in {SRC_DIR} — run scripts/capture-screenshot.sh first")

    missing = [p.name for p in shots if p.stem.split("-", 1)[1] not in CAPTIONS]
    if missing:
        sys.exit("no caption in CAPTIONS for: " + ", ".join(missing))

    captions = [CAPTIONS[p.stem.split("-", 1)[1]] for p in shots]
    font, wrapped = plan_captions(captions, CANVAS_W - 2 * TEXT_MARGIN_X)
    caption_zone_h = max(len(w) for w in wrapped) * int(font.size * LINE_SPACING)

    written = set()
    combo: list[Image.Image] = []
    for src, lines in zip(shots, wrapped):
        out = out_dir / src.name
        img = frame(src, lines, font, caption_zone_h)
        img.save(out)
        written.add(out.name)
        if len(combo) < README_COMBO_N:
            combo.append(img)
        print(f"{out.name}  {img.width}x{img.height}  ({len(lines)} lines @ {font.size}px)")

    if args.out is None and combo:
        strip = Image.new("RGB", (CANVAS_W * len(combo), CANVAS_H))
        for i, img in enumerate(combo):
            strip.paste(img, (i * CANVAS_W, 0))
        h = round(README_COMBO_W * strip.height / strip.width)
        strip.resize((README_COMBO_W, h), Image.LANCZOS).save(README_COMBO)
        print(f"{README_COMBO.name}  {README_COMBO_W}x{h}  (frames 1-{len(combo)})")

    # Renaming a capture to reorder the listing leaves its framed output behind under the old
    # name, and a stale frame sitting next to the real ones is a plausible thing to upload by
    # mistake. Only ever removes files this script would have written.
    for stale in sorted(out_dir.glob("[0-9][0-9]-*.png")):
        if stale.name not in written:
            stale.unlink()
            print(f"removed stale {stale.name}")


if __name__ == "__main__":
    main()
