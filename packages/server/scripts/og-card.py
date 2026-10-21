"""Render the link-preview card (og-card.jpg) that every public page names as its og:image.

The card is the hero photo with the icon, name and tagline on the left and the Denali capture on
the right. It is laid out in HTML and captured with headless Chrome at 2x, so the type is the same
system font the landing page draws.

    python3 packages/server/scripts/og-card.py

Inputs are the hero photo and icon in packages/server/public and the raw iOS capture
packages/mobile/screenshots/altitude.png. Rerun whenever any of them, or the tagline, changes.
"""

import subprocess
import tempfile
from pathlib import Path

from PIL import Image

ROOT = Path(__file__).resolve().parents[3]
PUBLIC = ROOT / "packages/server/public"
SCREENSHOT = ROOT / "packages/mobile/screenshots/altitude.png"
OUT = PUBLIC / "og-card.jpg"
CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"

W, H, SCALE = 1200, 630, 2

# The phone is sized so the capture ends just below the freezing level row.
HTML = """<!doctype html>
<html><head><meta charset=utf-8><style>
  html, body {{ margin: 0; }}
  .card {{ position: relative; width: {w}px; height: {h}px; overflow: hidden; color: #fff;
    font-family: -apple-system, system-ui, sans-serif;
    background: linear-gradient(rgba(12, 34, 64, 0.15), rgba(12, 34, 64, 0.5)),
      url("{photo}") center top / cover no-repeat #0c2240; }}
  .brand {{ position: absolute; left: 0; top: 0; bottom: 0; width: 746px; align-items: center;
    text-align: center; display: flex; flex-direction: column; justify-content: center; }}
  .appicon {{ width: 150px; height: 150px; border-radius: 34px; box-shadow: 0 8px 28px rgba(6, 18, 36, 0.45); }}
  h1 {{ margin: 28px 0 18px; font-size: 68px; letter-spacing: -0.02em; line-height: 1;
    text-shadow: 0 2px 14px rgba(6, 18, 36, 0.55); }}
  p {{ margin: 0; font-size: 28px; line-height: 1.25; text-shadow: 0 2px 12px rgba(6, 18, 36, 0.55); }}
  .phone {{ position: absolute; right: 110px; top: 70px; width: 344px; border-radius: 43px;
    box-shadow: 0 12px 40px rgba(6, 18, 36, 0.55); }}
</style></head><body>
<div class=card>
  <div class=brand>
    <img class=appicon src="{icon}">
    <h1>Going Blue</h1>
    <p>Expedition weather forecasts via satellite</p>
  </div>
  <img class=phone src="{screenshot}">
</div>
</body></html>
"""


def main() -> None:
    with tempfile.TemporaryDirectory() as tmp:
        page = Path(tmp) / "card.html"
        png = Path(tmp) / "card.png"
        page.write_text(
            HTML.format(
                w=W,
                h=H,
                photo=(PUBLIC / "sultana-2400.jpg").as_uri(),
                icon=(PUBLIC / "icon-512.jpg").as_uri(),
                screenshot=SCREENSHOT.as_uri(),
            )
        )
        subprocess.run(
            [
                CHROME,
                "--headless=new",
                "--disable-gpu",
                "--hide-scrollbars",
                f"--force-device-scale-factor={SCALE}",
                f"--window-size={W},{H}",
                f"--screenshot={png}",
                page.as_uri(),
            ],
            check=True,
            capture_output=True,
        )
        img = Image.open(png).convert("RGB")
        if img.size != (W * SCALE, H * SCALE):
            raise SystemExit(f"unexpected capture size {img.size}")
        img.save(OUT, "JPEG", quality=82, optimize=True, progressive=True)
    print(f"{OUT.relative_to(ROOT)}: {OUT.stat().st_size // 1024} KB")


if __name__ == "__main__":
    main()
