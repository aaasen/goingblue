"""Bake the global hillshade pyramid from the Mapterhorn z0-8 extract.

Per tile: decode Terrarium webp -> elevation, pad 1px from neighbors (seam-free
gradients), Horn hillshade, encode grayscale lossy WebP q50. Deduped MBTiles out;
convert with `pmtiles convert` afterwards.
"""
import hashlib, io, math, sqlite3, sys
from collections import OrderedDict
from multiprocessing import Pool
import numpy as np
from PIL import Image
from pmtiles.reader import Reader, MmapSource, all_tiles

# SRC may be several comma-separated archives that together cover the world (longitude bands);
# lookups try each, so a tile's neighbour padding works across band boundaries.
SRC = sys.argv[1] if len(sys.argv) > 1 else "terrain-z8.pmtiles"
SRCS = SRC.split(",")
OUT = sys.argv[2] if len(sys.argv) > 2 else "hillshade.mbtiles"
MAXZOOM = sys.argv[3] if len(sys.argv) > 3 else "8"
QUALITY = 40
EXAGGERATION = 1.3
import os
WORKERS = int(os.environ.get("WORKERS", os.cpu_count() or 4))

_readers = None
_cache = None  # OrderedDict[(z,x,y)] -> int16 elev array or None

def init_worker():
    global _readers, _cache
    _readers = [Reader(MmapSource(open(p, "rb"))) for p in SRCS]
    _cache = OrderedDict()

def get_elev(z, x, y):
    n = 1 << z
    if x < 0: x += n
    if x >= n: x -= n
    if y < 0 or y >= n:
        return None
    key = (z, x, y)
    if key in _cache:
        _cache.move_to_end(key)
        return _cache[key]
    data = None
    for r in _readers:
        data = r.get(z, x, y)
        if data is not None:
            break
    if data is None:
        val = None
    else:
        a = np.asarray(Image.open(io.BytesIO(data)).convert("RGB"), dtype=np.int32)
        val = (a[..., 0] * 256 + a[..., 1] - 32768).astype(np.int16)
    _cache[key] = val
    if len(_cache) > 320:
        _cache.popitem(last=False)
    return val

def tile_center_lat(y, z):
    n = math.pi - 2 * math.pi * (y + 0.5) / (2 ** z)
    return math.degrees(math.atan(math.sinh(n)))

def process(task):
    z, x, y = task
    elev = get_elev(z, x, y)
    if elev is None:
        return None
    size = elev.shape[0]
    pad = np.zeros((size + 2, size + 2), dtype=np.float64)
    pad[1:-1, 1:-1] = elev
    left = get_elev(z, x - 1, y)
    right = get_elev(z, x + 1, y)
    up = get_elev(z, x, y - 1)
    down = get_elev(z, x, y + 1)
    pad[1:-1, 0] = left[:, -1] if left is not None else elev[:, 0]
    pad[1:-1, -1] = right[:, 0] if right is not None else elev[:, -1]
    pad[0, 1:-1] = up[-1, :] if up is not None else elev[0, :]
    pad[-1, 1:-1] = down[0, :] if down is not None else elev[-1, :]
    for (dy, dx), (ci, cj) in ((( -1, -1), (0, 0)), ((-1, 1), (0, -1)),
                               ((1, -1), (-1, 0)), ((1, 1), (-1, -1))):
        d = get_elev(z, x + dx, y + dy)
        pad[ci, cj] = d[-1 if dy < 0 else 0, -1 if dx < 0 else 0] \
            if d is not None else elev[-1 if dy > 0 else 0, -1 if dx > 0 else 0]
    px_m = 156543.03 / (2 ** z) / (size / 256) * max(
        math.cos(math.radians(tile_center_lat(y, z))), 0.05)
    gy, gx = np.gradient(pad * EXAGGERATION, px_m)
    gy, gx = gy[1:-1, 1:-1], gx[1:-1, 1:-1]
    slope = np.arctan(np.hypot(gx, gy))
    aspect = np.arctan2(-gx, gy)
    azr, altr = math.radians(360 - 315 + 90), math.radians(45)
    shaded = (np.sin(altr) * np.cos(slope) +
              np.cos(altr) * np.sin(slope) * np.cos(azr - aspect))
    hs = np.clip((shaded + 1) / 2 * 255, 0, 255).astype(np.uint8)
    # transparent over flat sea so the style's ocean color shows through
    alpha = np.where((elev <= 0) & (slope < 1e-6), 0, 255).astype(np.uint8)
    if not alpha.any():
        return z, x, y, EMPTY_TILE
    rgba = np.dstack([hs, hs, hs, alpha])
    buf = io.BytesIO()
    Image.fromarray(rgba, "RGBA").save(buf, "WEBP", quality=QUALITY, method=4)
    return z, x, y, buf.getvalue()

def _make_empty():
    buf = io.BytesIO()
    Image.fromarray(np.zeros((512, 512, 4), dtype=np.uint8), "RGBA").save(
        buf, "WEBP", quality=QUALITY, method=4)
    return buf.getvalue()

EMPTY_TILE = _make_empty()

def main():
    seen = set()
    tasks = []
    for path in SRCS:
        reader = Reader(MmapSource(open(path, "rb")))
        for zxy, _ in all_tiles(reader.get_bytes):
            # Antarctica stays at overview detail: skip z7-8 below 60S
            if zxy[0] >= 7 and tile_center_lat(zxy[2], zxy[0]) < -60:
                continue
            # Band extracts are tile-granular, so boundary tiles can appear in two bands.
            if zxy in seen:
                continue
            seen.add(zxy)
            tasks.append(zxy)

    # WAL + periodic commits: the bake runs for hours on a spot VM, so a preemption must leave
    # a consistent db that the next run extends instead of a corrupt one it starts over from.
    db = sqlite3.connect(OUT)
    db.executescript("""
        PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL;
        CREATE TABLE IF NOT EXISTS metadata (name text, value text);
        CREATE TABLE IF NOT EXISTS map (zoom_level int, tile_column int, tile_row int, tile_id text);
        CREATE TABLE IF NOT EXISTS images (tile_id text PRIMARY KEY, tile_data blob);
        CREATE VIEW IF NOT EXISTS tiles AS SELECT map.zoom_level, map.tile_column, map.tile_row,
            images.tile_data FROM map JOIN images ON images.tile_id = map.tile_id;
    """)
    db.execute("DELETE FROM metadata")
    db.executemany("INSERT INTO metadata VALUES (?, ?)", {
        "name": "weather-hillshade", "format": "webp",
        "minzoom": "0", "maxzoom": MAXZOOM,
        "bounds": "-180,-85.05113,180,85.05113", "center": "0,0,2",
        "type": "baselayer",
        "attribution": "© Mapterhorn, Copernicus DEM",
    }.items())
    baked = {(z, x, (1 << z) - 1 - row) for z, x, row in
             db.execute("SELECT zoom_level, tile_column, tile_row FROM map")}
    if baked:
        tasks = [t for t in tasks if t not in baked]
        print(f"resuming: {len(baked)} tiles already baked")
    tasks.sort(key=lambda t: (t[0], t[2], t[1]))   # row-major per zoom for cache
    print(f"{len(tasks)} tiles to bake")

    n = 0
    with Pool(WORKERS, initializer=init_worker) as pool:
        for res in pool.imap(process, tasks, chunksize=32):
            n += 1
            if n % 10000 == 0:
                db.commit()
                print(f"...{n}/{len(tasks)}", flush=True)
            if res is None:
                continue
            z, x, y, out = res
            tid = hashlib.md5(out).hexdigest()
            db.execute("INSERT OR IGNORE INTO images VALUES (?, ?)", (tid, out))
            db.execute("INSERT INTO map VALUES (?, ?, ?, ?)",
                       (z, x, (1 << z) - 1 - y, tid))
    db.commit()
    # pmtiles convert looks tiles up by z/x/y; without this index each lookup scans the table.
    db.execute("CREATE UNIQUE INDEX IF NOT EXISTS map_idx ON map (zoom_level, tile_column, tile_row)")
    db.commit()
    db.close()
    print(f"done: {n} tiles")

if __name__ == "__main__":
    main()
