"""Vectorize Copernicus Global Land Cover 100 m (CGLS-LC100 discrete classification) into a
`landcover` tile layer for z0-MAXZOOM, replacing Protomaps' stock layer which ends at z7.

    landcover_build.py SRC OUT.pmtiles MAXZOOM [--bbox W,S,E,N] [--work DIR]

SRC is the global discrete-classification GeoTIFF (local path or https URL — it is a tiled COG,
so a bbox window reads only its blocks). Zoom bands are rasterized separately, each from the
raster mode-resampled to about one source pixel per rendered pixel at the band's top zoom, then
sieved (minimum mapping unit) and polygonized; tippecanoe tiles each band and tile-join merges
the bands. Class codes collapse to the kinds the style colours: forest, scrub, grassland,
farmland, barren, glacier, urban_area, wetland. Water (80/200) is dropped — the water polygons
come from Protomaps.
"""
import argparse, json, os, subprocess, sys, tempfile
from concurrent.futures import ProcessPoolExecutor
from pathlib import Path

import numpy as np
import rasterio
from rasterio.enums import Resampling
from rasterio.features import shapes, sieve
from rasterio.windows import Window, from_bounds

os.environ.setdefault("GDAL_DISABLE_READDIR_ON_OPEN", "EMPTY_DIR")
os.environ.setdefault("GDAL_HTTP_MERGE_CONSECUTIVE_RANGES", "YES")
os.environ.setdefault("CPL_VSIL_CURL_CACHE_SIZE", "268435456")

# CGLS discrete classes -> style kind. 111-126 are forest types (closed/open x leaf type).
KINDS = {
    20: "scrub", 30: "grassland", 40: "farmland", 50: "urban_area", 60: "barren",
    70: "glacier", 90: "wetland", 100: "grassland",
    **{c: "forest" for c in (111, 112, 113, 114, 115, 116, 121, 122, 123, 124, 125, 126)},
}
KIND_IDS = {k: i + 1 for i, k in enumerate(sorted(set(KINDS.values())))}  # 0 = nothing
ID_KINDS = {v: k for k, v in KIND_IDS.items()}
LUT = np.zeros(256, dtype=np.uint8)
for code, kind in KINDS.items():
    LUT[code] = KIND_IDS[kind]

# (minzoom, maxzoom, downsample factor vs 100 m source). A 512 px tile at the band's top zoom
# renders ~150 m/px at the equator, so 2x (200 m) at z10 is already sub-pixel.
BANDS = [(0, 4, 128), (5, 6, 32), (7, 8, 8), (9, 10, 2)]
SIEVE_PX = 4          # minimum mapping unit, in (downsampled) pixels
WINDOW = 8192         # source pixels per processing window edge


def src_path(src):
    return f"/vsicurl/{src}" if src.startswith(("http://", "https://")) else src


def polygonize_window(args):
    src, win, factor, out = args
    col, row, w, h = win
    with rasterio.open(src_path(src)) as ds:
        window = Window(col, row, w, h)
        ow, oh = max(1, w // factor), max(1, h // factor)
        data = ds.read(1, window=window, out_shape=(oh, ow), resampling=Resampling.mode)
        transform = ds.window_transform(window) * rasterio.Affine.scale(w / ow, h / oh)
    ids = LUT[data]
    if not ids.any():
        return 0
    ids = sieve(ids, SIEVE_PX)
    n = 0
    with open(out, "w") as f:
        for geom, val in shapes(ids, mask=ids > 0, transform=transform):
            f.write(json.dumps({"type": "Feature", "properties": {"kind": ID_KINDS[int(val)]},
                                "geometry": geom}, separators=(",", ":")) + "\n")
            n += 1
    return n


def windows_for(ds, bbox, factor):
    if bbox:
        full = from_bounds(*bbox, transform=ds.transform).round_offsets().round_lengths()
    else:
        full = Window(0, 0, ds.width, ds.height)
    step = WINDOW - WINDOW % factor
    c0, r0 = int(full.col_off), int(full.row_off)
    for row in range(r0, r0 + int(full.height), step):
        for col in range(c0, c0 + int(full.width), step):
            yield (col, row, min(step, c0 + int(full.width) - col), min(step, r0 + int(full.height) - row))


def build_band(src, work, bbox, minzoom, maxzoom, factor, jobs):
    out = work / f"landcover-z{minzoom}-{maxzoom}.pmtiles"
    if out.exists() and out.stat().st_size > 0:
        print(f"have {out.name}", flush=True)
        return out
    seqdir = work / f"seq-z{minzoom}-{maxzoom}"
    seqdir.mkdir(exist_ok=True)
    with rasterio.open(src_path(src)) as ds:
        wins = list(windows_for(ds, bbox, factor))
    tasks = [(src, w, factor, seqdir / f"{w[0]}_{w[1]}.geojsonseq") for w in wins]
    tasks = [t for t in tasks if not t[3].exists()]
    print(f"band z{minzoom}-{maxzoom}: {len(wins)} windows ({len(tasks)} to do) at {factor}x", flush=True)
    with ProcessPoolExecutor(jobs) as ex:
        total = sum(ex.map(polygonize_window, tasks))
    print(f"  {total} polygons", flush=True)
    files = [str(p) for p in sorted(seqdir.glob("*.geojsonseq")) if p.stat().st_size > 0]
    subprocess.run(["tippecanoe", "-o", str(out), "--force", "-l", "landcover",
                    "-Z", str(minzoom), "-z", str(maxzoom),
                    "--detect-shared-borders", "--coalesce-smallest-as-needed",
                    "--no-tile-size-limit", "--no-feature-limit", "-pf", "-pk", "-ps",
                    "-n", "weather-landcover", "-A", "© Copernicus Global Land Service",
                    *files], check=True)
    return out


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("src")
    ap.add_argument("out", type=Path)
    ap.add_argument("maxzoom", type=int)
    ap.add_argument("--bbox", help="W,S,E,N in degrees (test runs)")
    ap.add_argument("--work", type=Path, help="intermediate dir (default: next to OUT)")
    ap.add_argument("--jobs", type=int, default=int(os.environ.get("WORKERS", os.cpu_count() or 4)))
    a = ap.parse_args()
    bbox = tuple(float(v) for v in a.bbox.split(",")) if a.bbox else None
    work = a.work or a.out.parent / "landcover-work"
    work.mkdir(parents=True, exist_ok=True)
    bands = []
    for minzoom, maxzoom, factor in BANDS:
        if minzoom > a.maxzoom:
            break
        bands.append(build_band(a.src, work, bbox, minzoom, min(maxzoom, a.maxzoom), factor, a.jobs))
    subprocess.run(["tile-join", "--force", "-pk", "-o", str(a.out), *map(str, bands)], check=True)
    print(f"done: {a.out} {a.out.stat().st_size / 1e6:.1f} MB", flush=True)


if __name__ == "__main__":
    main()
