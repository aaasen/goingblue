"""Build the stripped vector basemap from the stock Protomaps z0-8 extract (v3).

All layers re-encoded at extent 1024 (0.5px precision at 512px render):
- water: drop ocean polys + tiny parts, simplify shorelines
- earth: simplify coastline
- landuse: glacier + bare_rock only, simplify
- landcover: re-quantize only (shared-edge partition; no per-feature simplify)
- boundaries: simplify lines
- places: country/region/locality only
- pois: kept as-is (points)
Writes deduped MBTiles; convert with `pmtiles convert` afterwards.
"""
import gzip, hashlib, json, sqlite3
from multiprocessing import Pool
from pmtiles.reader import Reader, MmapSource, all_tiles
import mapbox_vector_tile
from shapely.geometry import shape, mapping
from shapely.affinity import scale as shp_scale

import os, sys
SRC = sys.argv[1] if len(sys.argv) > 1 else "basemap-global-z8.pmtiles"
OUT = sys.argv[2] if len(sys.argv) > 2 else "basemap-stripped.mbtiles"
MAXZOOM = sys.argv[3] if len(sys.argv) > 3 else "8"
MVT_OPTS = {"y_coord_down": True}
ENC_OPTS = {"extents": 1024, "quantize_bounds": None, "y_coord_down": True}
SCALE = 1024 / 4096
PLACE_KINDS = {"country", "region", "locality"}
LANDUSE_KINDS = {"glacier", "bare_rock"}

def ring_area(ring):
    s = 0
    for i in range(len(ring) - 1):
        s += ring[i][0] * ring[i + 1][1] - ring[i + 1][0] * ring[i][1]
    return abs(s) / 2

def xform(g, simplify_tol):
    """Simplify (in source units) then scale to the smaller extent."""
    try:
        geom = shape(g)
        if simplify_tol and geom.geom_type in ("Polygon", "MultiPolygon",
                                               "LineString", "MultiLineString"):
            geom = geom.simplify(simplify_tol, preserve_topology=True)
            if geom.is_empty:
                return None
        return mapping(shp_scale(geom, SCALE, SCALE, origin=(0, 0)))
    except Exception:
        return None

def clean_props(f):
    return {k: v for k, v in f["properties"].items() if v is not None}

def prep(layer, simplify_tol=0, kind_keep=None, drop_kinds=frozenset(),
         min_part=0):
    feats = []
    for f in layer["features"]:
        props = clean_props(f)
        kind = props.get("kind")
        if kind_keep is not None and kind not in kind_keep:
            continue
        g = f["geometry"]
        if kind in drop_kinds and g["type"] in ("Polygon", "MultiPolygon"):
            continue
        if min_part and g["type"] == "Polygon":
            if ring_area(g["coordinates"][0]) < min_part:
                continue
        elif min_part and g["type"] == "MultiPolygon":
            parts = [r for r in g["coordinates"] if ring_area(r[0]) >= min_part]
            if not parts:
                continue
            g = {"type": "MultiPolygon", "coordinates": parts}
        g = xform(g, simplify_tol)
        if g is None:
            continue
        feats.append({"geometry": g, "properties": props})
    return feats

LAYER_RULES = {
    "water": dict(simplify_tol=4, min_part=256),
    "earth": dict(simplify_tol=4),
    "landuse": dict(simplify_tol=3, kind_keep=LANDUSE_KINDS),
    "landcover": dict(simplify_tol=0),
    "boundaries": dict(simplify_tol=2),
    "places": dict(kind_keep=PLACE_KINDS),
    "pois": dict(),
}
# STRIP_DROP=landcover when the driver supplies its own landcover layer (landcover_build.py).
for _name in filter(None, os.environ.get("STRIP_DROP", "").split(",")):
    LAYER_RULES.pop(_name, None)

def process(args):
    z, x, y, data = args
    tile = mapbox_vector_tile.decode(gzip.decompress(data),
                                     default_options=MVT_OPTS)
    out_layers = []
    for name, rule in LAYER_RULES.items():
        layer = tile.get(name)
        if not layer:
            continue
        feats = prep(layer, **rule)
        if feats:
            out_layers.append({"name": name, "features": feats})
    if not out_layers:
        return None
    try:
        enc = mapbox_vector_tile.encode(out_layers, default_options=ENC_OPTS)
    except Exception:
        return None
    return z, x, y, gzip.compress(enc, 6)

def main():
    reader = Reader(MmapSource(open(SRC, "rb")))
    meta = reader.metadata()
    db = sqlite3.connect(OUT)
    db.executescript("""
        PRAGMA journal_mode=OFF; PRAGMA synchronous=OFF;
        CREATE TABLE metadata (name text, value text);
        CREATE TABLE map (zoom_level int, tile_column int, tile_row int, tile_id text);
        CREATE TABLE images (tile_id text PRIMARY KEY, tile_data blob);
        CREATE VIEW tiles AS SELECT map.zoom_level, map.tile_column, map.tile_row,
            images.tile_data FROM map JOIN images ON images.tile_id = map.tile_id;
    """)
    db.executemany("INSERT INTO metadata VALUES (?, ?)", {
        "name": "weather-basemap", "format": "pbf",
        "minzoom": "0", "maxzoom": MAXZOOM,
        "bounds": "-180,-85.05113,180,85.05113", "center": "0,0,2",
        "type": "baselayer",
        "attribution": meta.get("attribution", ""),
        "json": json.dumps({"vector_layers": [
            l for l in meta.get("vector_layers", []) if l["id"] in LAYER_RULES]}),
    }.items())

    def gen():
        for zxy, data in all_tiles(reader.get_bytes):
            yield zxy[0], zxy[1], zxy[2], data

    n = written = 0
    with Pool(int(os.environ.get("WORKERS", os.cpu_count() or 4))) as pool:
        for res in pool.imap_unordered(process, gen(), chunksize=64):
            n += 1
            if n % 10000 == 0:
                print(f"...{n} tiles, {written} written", flush=True)
            if res is None:
                continue
            z, x, y, out = res
            tid = hashlib.md5(out).hexdigest()
            db.execute("INSERT OR IGNORE INTO images VALUES (?, ?)", (tid, out))
            db.execute("INSERT INTO map VALUES (?, ?, ?, ?)",
                       (z, x, (1 << z) - 1 - y, tid))
            written += 1
    db.commit()
    db.close()
    print(f"done: {n} source tiles, {written} written")

if __name__ == "__main__":
    main()
