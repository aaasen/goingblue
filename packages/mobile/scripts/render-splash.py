#!/usr/bin/env python3
"""Render assets/splash.png — the app icon over the "Going Blue" wordmark.

expo-splash-screen draws one centered image on a flat background and cannot render text, so the
wordmark has to be baked into the asset. This reproduces the header of the setup screen
(SetupScreen.tsx) exactly — same icon size and corner radius, same gap, same type — so the launch
image hands off to the first screen without anything moving.

Run from packages/mobile after changing assets/icon.png:

    python3 scripts/render-splash.py

Needs Pillow (`pip install pillow`) and macOS's system font. Neither is a build dependency: the
rendered PNG is committed, and this only runs when the icon or the wordmark changes.
"""

from pathlib import Path

from PIL import Image, ImageDraw, ImageFont

# Layout in points, matching SetupScreen's styles.icon and styles.brand. Anything changed there
# should change here too.
ICON_PT = 96
ICON_RADIUS_PT = 22
GAP_PT = 14
BRAND_PT = 30
BRAND_TEXT = "Going Blue"
BRAND_COLOR = "#2a6bb5"

# iOS tops out at @3x, and the icon source is 1024px, so 3x stays crisp without wasting bytes.
SCALE = 3

# The variable system font; 'Bold' is the named instance matching RN's fontWeight 700.
FONT_PATH = "/System/Library/Fonts/SFNS.ttf"

HERE = Path(__file__).resolve().parent
ICON_SRC = HERE.parent / "assets" / "icon.png"
OUT = HERE.parent / "assets" / "splash.png"


def rounded(img: Image.Image, radius: int) -> Image.Image:
    """Apply an RN-style borderRadius. The icon source is opaque, so this both builds the alpha
    channel and rounds it — the splash sits on a flat background and needs the corners cut."""
    mask = Image.new("L", img.size, 0)
    ImageDraw.Draw(mask).rounded_rectangle((0, 0, img.width - 1, img.height - 1), radius, fill=255)
    out = img.convert("RGBA")
    out.putalpha(mask)
    return out


def main() -> None:
    icon_px = ICON_PT * SCALE
    icon = rounded(Image.open(ICON_SRC).resize((icon_px, icon_px), Image.LANCZOS), ICON_RADIUS_PT * SCALE)

    font = ImageFont.truetype(FONT_PATH, BRAND_PT * SCALE)
    font.set_variation_by_name("Bold")
    # Ink extents, not the font's line box: the canvas is trimmed to the visible mark so that
    # expo-splash-screen's imageWidth maps to the width you actually see.
    left, top, right, bottom = font.getbbox(BRAND_TEXT)
    text_w, text_h = right - left, bottom - top

    width = max(icon_px, text_w)
    height = icon_px + GAP_PT * SCALE + text_h

    canvas = Image.new("RGBA", (width, height), (0, 0, 0, 0))
    canvas.alpha_composite(icon, ((width - icon_px) // 2, 0))
    # Offset by the bbox origin so the glyphs land flush against the top of their band.
    ImageDraw.Draw(canvas).text(
        ((width - text_w) // 2 - left, icon_px + GAP_PT * SCALE - top),
        BRAND_TEXT,
        font=font,
        fill=BRAND_COLOR,
    )

    canvas.save(OUT)
    print(f"{OUT.relative_to(HERE.parent)}: {width}x{height}px @{SCALE}x "
          f"= {width // SCALE}x{height // SCALE}pt (set imageWidth to {width // SCALE})")


if __name__ == "__main__":
    main()
