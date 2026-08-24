#!/usr/bin/env python3
"""Basemap build driver: one global z0-MAXZOOM pair, then every pack is an extract of it.

    basemap.py all      --work DIR [--vectors SRC] [--terrain SRC] [--landcover SRC] [--maxzoom 10]
    basemap.py overture --work DIR [--release 2026-07-22.0]
    basemap.py labels   --work DIR [--overture DB] --maxzoom 10
    basemap.py landcover --work DIR [--landcover SRC] [--bbox W,S,E,N] --maxzoom 10
    basemap.py vectors  --work DIR --vectors SRC --maxzoom 10      # strip + join labels + landcover
    basemap.py hillshade --work DIR --terrain SRC --maxzoom 10
    basemap.py regions  --work DIR                                   # Natural Earth polygons
    basemap.py packs    --work DIR [--maxzoom 10] [--only id,id]
    basemap.py catalogue --work DIR [--maxzoom 10]                   # the list + outlines, no tiles

SRC is a local .pmtiles or an https:// archive (then `pmtiles extract --maxzoom` pulls a
z0-MAXZOOM copy into DIR first). Outputs in DIR:

    overture.duckdb (--overture)     named peaks / lakes / glaciers with English names (overture step)
    labels.pmtiles                   those, ranked + zoom-banded
    landcover.pmtiles                CGLS-LC100 land cover vectorized for z0-MAXZOOM (stock ends at z7)
    global-base.pmtiles              stripped Protomaps vectors + labels (the online archive)
    global-hs.pmtiles                prebaked hillshade (the online archive)
    global-z6-{base,hs}.pmtiles      z0-6 extract, bundled with the app
    regions/ne_{countries,states}.geojson  Natural Earth 10m admin-0 / admin-1 (regions step)
    packs/<id>-{base,hs}.pmtiles     one pair per catalogue entry
    catalogue.json                   what the app lists: id, name, continent, parent, maxzoom, bounds, bytes
    outlines.json                    simplified pack polygons, for the app's "where you are" lookup

Every step skips work whose output already exists, so a killed run (spot VM) resumes.
Tools: pmtiles, tippecanoe/tile-join, duckdb CLI; python venv with pmtiles, mapbox-vector-tile,
shapely, numpy, Pillow (strip_build.py / hillshade_build.py live next to this file).
"""
import argparse, csv, io, json, os, shutil, subprocess, sys, time
from pathlib import Path

HERE = Path(__file__).resolve().parent
DEFAULT_VECTORS = "https://build.protomaps.com/20260820.pmtiles"
DEFAULT_TERRAIN = "https://download.mapterhorn.com/planet.pmtiles"
OVERTURE_RELEASE = "2026-07-22.0"
TERRAIN_BANDS = 16
NATURAL_EARTH = "https://naciscdn.org/naturalearth/10m/cultural"
DEFAULT_LANDCOVER = ("https://zenodo.org/records/3939050/files/"
                     "PROBAV_LC100_global_v3.0.1_2019-nrt_Discrete-Classification-map_EPSG-4326.tif")
BUNDLED_ZOOM = 6

# Admin-0 units that get admin-1 subdivision packs (storage convenience inside big countries).
# Their own country pack stops at SUBDIVIDED_MAXZOOM: the US at z10 would run to hundreds of MB,
# so the whole-country option is the z9 overview and the states carry z10 where the trip is.
SUBDIVIDE = {"US", "CA"}
SUBDIVIDED_MAXZOOM = 9
# Pack outlines shipped to the app: simplification tolerance and coordinate precision, degrees.
OUTLINE_TOLERANCE = 0.05
OUTLINE_DECIMALS = 3

# Label significance. Peaks rank per 0.25-degree cell by elevation, lakes by area; the style
# shows rank<=2 at z<=8, <=6 at z9, everything at z10+. Minzoom bands put the biggest features
# into the overview tiles (the bundled z6 archive sees only minzoom<=6).
PEAK_RANK_MAX = 15
LAKE_RANK_MAX = 8
LAKE_MIN_AREA = 2e-5  # deg^2
PEAK_ZOOM = [(5000, 4), (4000, 5), (3000, 6), (2000, 7)]        # elevation m -> minzoom, else 8
LAKE_ZOOM = [(0.5, 4), (0.1, 5), (0.02, 6), (0.005, 7)]          # areadeg -> minzoom, else 8
GLACIER_ZOOM = [(0.02, 6), (0.005, 7)]                           # else 8


def log(msg):
    print(f"[{time.strftime('%H:%M:%S')}] {msg}", flush=True)


def run(cmd, **kw):
    log("$ " + " ".join(str(c) for c in cmd))
    subprocess.run([str(c) for c in cmd], check=True, **kw)


def done(path):
    return Path(path).exists() and Path(path).stat().st_size > 0


def run_to(out, cmd_of, attempts=1, **kw):
    """Run a command that writes `out`, via a temp name renamed only on success — a killed run
    must never leave a partial file that a resume then trusts as finished."""
    out = Path(out)
    # Prefix rather than a .tmp suffix: tippecanoe and pmtiles pick formats by extension.
    tmp = out.with_name("tmp-" + out.name)
    for attempt in range(attempts):
        if tmp.exists():
            tmp.unlink()
        try:
            run(cmd_of(tmp), **kw)
            break
        except subprocess.CalledProcessError:
            if attempt == attempts - 1:
                raise
            log(f"attempt {attempt + 1}/{attempts} failed, retrying")
            time.sleep(30)
    tmp.rename(out)


def banded(value, bands, default=8):
    for threshold, zoom in bands:
        if value is not None and value >= threshold:
            return zoom
    return default


# ---------------------------------------------------------------- sources

def ensure_source(src, work, name, maxzoom, bands=1):
    """A local archive is used as-is; a URL is extracted to z0-maxzoom under work/.

    With bands > 1 the extract is split into that many longitude strips, returned as a list.
    The server killed the terrain extract's single ~120 GB HTTP stream mid-transfer, and
    go-pmtiles merges contiguous ranges into one request with no retry — small strips keep each
    request a few minutes long, atomic, and individually retryable/resumable.
    """
    if not src.startswith(("http://", "https://")):
        return [Path(p) for p in str(src).split(",")] if bands > 1 or "," in str(src) else Path(src)
    if bands == 1:
        out = work / f"{name}-src-z{maxzoom}.pmtiles"
        if done(out):
            log(f"have {out.name}")
            return out
        run_to(out, lambda tmp: ["pmtiles", "extract", src, tmp, f"--maxzoom={maxzoom}"], attempts=5)
        return out
    outs = []
    for i in range(bands):
        out = work / f"{name}-src-z{maxzoom}-band{i:02d}.pmtiles"
        outs.append(out)
        if done(out):
            log(f"have {out.name}")
            continue
        west, east = -180 + 360 * i / bands, -180 + 360 * (i + 1) / bands
        run_to(out, lambda tmp: ["pmtiles", "extract", src, tmp, f"--maxzoom={maxzoom}",
                                 f"--bbox={west},-85.05,{east},85.05"], attempts=5)
    return outs


# ---------------------------------------------------------------- overture

def build_overture(db, release):
    """Pull the named peaks / lakes / glaciers (primary + English names) into a duckdb file."""
    if done(db):
        # An existing db is used as-is (the labels step warns if it predates name_en); delete
        # it to force a rescan — the scan reads several GB from Overture's S3 bucket.
        log(f"have {Path(db).name}")
        return db
    sql = (HERE / "overture_labels.sql").read_text().replace("RELEASE", release)
    log(f"scanning Overture {release} (base/land + base/water)")
    Path(db).parent.mkdir(parents=True, exist_ok=True)
    run_to(db, lambda tmp: ["duckdb", str(tmp), "-c", sql])
    return db


# ---------------------------------------------------------------- labels

def build_labels(work, overture, maxzoom):
    out = work / "labels.pmtiles"
    if done(out):
        log(f"have {out.name}")
        return out
    seq = work / "labels.geojsonseq"
    def name_col(table):
        cols = subprocess.run(["duckdb", str(overture), "-readonly", "-csv", "-c", f"describe {table}"],
                              check=True, capture_output=True, text=True).stdout
        if "name_en" not in cols:
            log(f"{table} has no name_en column — local-language names only")
            return "name"
        return "coalesce(name_en, name)"
    peak_name, lake_name, glacier_name = name_col("peaks"), name_col("lake_labels"), name_col("glacier_labels")
    sql = f"""
    with p as (
      select {peak_name} as name, elevation, lon, lat,
             row_number() over (partition by floor(lon*4), floor(lat*4)
                                order by elevation desc nulls last) as rank
      from peaks where name is not null),
    l as (
      select {lake_name} as name, lon, lat, areadeg,
             row_number() over (partition by floor(lon*4), floor(lat*4)
                                order by areadeg desc) as rank
      from lake_labels where name is not null and areadeg >= {LAKE_MIN_AREA})
    select 'peaks' as layer, name, elevation as ele, null as areadeg, rank, lon, lat
      from p where rank <= {PEAK_RANK_MAX}
    union all
    select 'water_labels', name, null, areadeg, rank, lon, lat
      from l where rank <= {LAKE_RANK_MAX}
    union all
    select 'glacier_labels', {glacier_name}, null, areadeg, null, lon, lat
      from glacier_labels where name is not null
    """
    log("querying overture labels")
    res = subprocess.run(["duckdb", str(overture), "-readonly", "-csv", "-c", sql],
                         check=True, capture_output=True, text=True)
    counts = {}
    num = lambda v: None if v in ("", "NULL") else float(v)
    with open(seq, "w") as f:
        for row in csv.DictReader(io.StringIO(res.stdout)):
            layer = row["layer"]
            props = {"name": row["name"]}
            if layer == "peaks":
                ele = num(row["ele"])
                ele = int(ele) if ele is not None else None
                props.update(kind="peak", rank=int(row["rank"]))
                if ele is not None:
                    props["ele"] = ele
                minzoom = banded(ele, PEAK_ZOOM)
            elif layer == "water_labels":
                props["rank"] = int(row["rank"])
                minzoom = banded(num(row["areadeg"]), LAKE_ZOOM)
            else:
                minzoom = banded(num(row["areadeg"]) or 0, GLACIER_ZOOM)
            counts[layer] = counts.get(layer, 0) + 1
            f.write(json.dumps({
                "type": "Feature",
                "tippecanoe": {"layer": layer, "minzoom": min(minzoom, maxzoom)},
                "properties": props,
                "geometry": {"type": "Point",
                             "coordinates": [round(float(row["lon"]), 5), round(float(row["lat"]), 5)]},
            }, ensure_ascii=False) + "\n")
    log(f"labels: {counts}")
    # Points only; never drop or cluster — the style does the thinning by rank.
    run_to(out, lambda tmp: ["tippecanoe", "-o", tmp, "--force", "-Z", "0", "-z", str(maxzoom),
                             "-r1", "-pf", "-pk", "-ps",
                             "-n", "weather-labels", "-A", "© Overture Maps Foundation, OpenStreetMap contributors",
                             seq])
    return out


# ---------------------------------------------------------------- landcover

def build_landcover(work, landcover_src, maxzoom, bbox=None):
    out = work / "landcover.pmtiles"
    if done(out):
        log(f"have {out.name}")
        return out
    src = landcover_src
    if src.startswith(("http://", "https://")):
        # One sequential download: Zenodo rate-limits the parallel windowed reads.
        local = work / "landcover-src.tif"
        if not done(local):
            run_to(local, lambda tmp: ["curl", "-fL", "--retry", "5", "-o", tmp, src])
        src = local
    cmd = [sys.executable, HERE / "landcover_build.py", src, out, str(maxzoom), "--work", work / "landcover-work"]
    if bbox:
        cmd.append(f"--bbox={bbox}")
    run(cmd)
    return out


# ---------------------------------------------------------------- vectors

def build_vectors(work, vectors_src, labels, landcover, maxzoom):
    out = work / "global-base.pmtiles"
    if done(out):
        log(f"have {out.name}")
        return out
    src = ensure_source(vectors_src, work, "vectors", maxzoom)
    stripped_mb = work / "stripped.mbtiles"
    stripped = work / "stripped.pmtiles"
    if not done(stripped):
        # The strip lands atomically, so a present mbtiles always means a finished strip and
        # only the convert needs (re)running.
        if done(stripped_mb):
            log(f"have {stripped_mb.name}, converting")
        else:
            run_to(stripped_mb, lambda tmp: [sys.executable, HERE / "strip_build.py", src, tmp, str(maxzoom)],
                   env={**os.environ, "STRIP_DROP": "landcover" if landcover else ""})
        run_to(stripped, lambda tmp: ["pmtiles", "convert", stripped_mb, tmp])
        stripped_mb.unlink()
    run_to(out, lambda tmp: ["tile-join", "--force", "-pk", "-o", tmp, stripped, labels,
                             *([landcover] if landcover else [])])
    return out


# ---------------------------------------------------------------- hillshade

def build_hillshade(work, terrain_src, maxzoom):
    out = work / "global-hs.pmtiles"
    if done(out):
        log(f"have {out.name}")
        return out
    src = ensure_source(terrain_src, work, "terrain", maxzoom, bands=TERRAIN_BANDS)
    srcs = src if isinstance(src, list) else [src]
    # The bake resumes from an existing mbtiles (it skips tiles already in it).
    mb = work / "hillshade.mbtiles"
    run([sys.executable, HERE / "hillshade_build.py", ",".join(map(str, srcs)), mb, str(maxzoom)])
    run_to(out, lambda tmp: ["pmtiles", "convert", mb, tmp])
    mb.unlink()
    return out


# ---------------------------------------------------------------- regions

def build_regions(work):
    """Natural Earth 10m admin-0 countries and admin-1 states/provinces as GeoJSON."""
    import zipfile
    import shapefile  # pyshp
    out = {}
    for name, stem in (("countries", "ne_10m_admin_0_countries"), ("states", "ne_10m_admin_1_states_provinces")):
        geojson = work / "regions" / f"ne_{name}.geojson"
        out[name] = geojson
        if done(geojson):
            log(f"have {geojson.name}")
            continue
        geojson.parent.mkdir(parents=True, exist_ok=True)
        zpath = work / "regions" / f"{stem}.zip"
        if not done(zpath):
            run(["curl", "-fsSL", "--retry", "5", "-o", zpath, f"{NATURAL_EARTH}/{stem}.zip"])
        with zipfile.ZipFile(zpath) as z:
            members = {Path(m).suffix: m for m in z.namelist() if Path(m).stem == stem}
            with z.open(members[".shp"]) as shp, z.open(members[".dbf"]) as dbf, z.open(members[".shx"]) as shx:
                r = shapefile.Reader(shp=io.BytesIO(shp.read()), dbf=io.BytesIO(dbf.read()),
                                     shx=io.BytesIO(shx.read()), encoding="utf-8", encodingErrors="replace")
                fc = r.__geo_interface__
        json.dump(fc, open(geojson, "w"))
        log(f"{geojson.name}: {len(fc['features'])} features")
    return out


# ---------------------------------------------------------------- packs

def merge_geometries(geoms):
    polys = []
    for g in geoms:
        polys.extend([g["coordinates"]] if g["type"] == "Polygon" else g["coordinates"])
    return {"type": "MultiPolygon", "coordinates": polys}


def catalogue_entries(countries_path, states_path, maxzoom):
    """Catalogue rows from Natural Earth admin-0 and admin-1: (id, name, continent, parent, maxzoom, geometry).

    `continent` is Natural Earth's (the app groups the list by it); a merged pack takes the
    owning unit's, a state its country's.

    Admin-0 units sharing an ISO code (France + Clipperton, Australia + its territories) merge
    into one pack; units without one (bases, leases) fold into their sovereign's pack when it
    has one, otherwise stand alone under their ADM0_A3 (Somaliland, N. Cyprus, Siachen…).
    """
    by_id = {}
    countries = json.load(open(countries_path))["features"]
    def iso(p):
        code = p.get("ISO_A2_EH") or p.get("ISO_A2")
        return None if not code or code == "-99" else code.lower()
    by_sov = {p["SOV_A3"]: iso(p) for p in (f["properties"] for f in countries) if iso(p)}
    for f in countries:
        p = f["properties"]
        key = iso(p) or by_sov.get(p.get("SOV_A3")) or p["ADM0_A3"].lower()
        e = by_id.setdefault(key, {"id": key, "name": None, "continent": None, "parent": None, "geoms": [], "type": None})
        # The unit that owns the code names the pack; a dependency only names it when alone.
        if e["name"] is None or (iso(p) == key and e["type"] != "owner"):
            e["name"], e["type"] = p.get("NAME_EN") or p["NAME"], "owner" if iso(p) == key else None
            e["continent"] = p["CONTINENT"]
        e["geoms"].append(f["geometry"])
    entries = [{"id": e["id"], "name": e["name"], "continent": e["continent"], "parent": None,
                "maxzoom": min(maxzoom, SUBDIVIDED_MAXZOOM) if e["id"].upper() in SUBDIVIDE else maxzoom,
                "geometry": e["geoms"][0] if len(e["geoms"]) == 1 else merge_geometries(e["geoms"])}
               for e in by_id.values()]
    continent_of = {e["id"]: e["continent"] for e in entries}
    if states_path:
        for f in json.load(open(states_path))["features"]:
            p = f["properties"]
            if p["iso_a2"] not in SUBDIVIDE:
                continue
            entries.append({"id": p["iso_3166_2"].lower(), "name": p.get("name_en") or p["name"],
                            "continent": continent_of[p["iso_a2"].lower()], "maxzoom": maxzoom,
                            "parent": p["iso_a2"].lower(), "geometry": f["geometry"]})
    return entries


def bounds_of(geometry):
    xs, ys = [], []
    def walk(c):
        if isinstance(c[0], (int, float)):
            xs.append(c[0]); ys.append(c[1])
        else:
            for d in c:
                walk(d)
    walk(geometry["coordinates"])
    return [round(min(xs), 4), round(min(ys), 4), round(max(xs), 4), round(max(ys), 4)]


def extract(src, out, region=None, maxzoom=None):
    if done(out):
        return
    def cmd(tmp):
        c = ["pmtiles", "extract", src, tmp]
        if region:
            c.append(f"--region={region}")
        if maxzoom is not None:
            c.append(f"--maxzoom={maxzoom}")
        return c
    run_to(out, cmd)


def catalogue_row(e, nbytes):
    return {"id": e["id"], "name": e["name"], "continent": e["continent"], "parent": e["parent"],
            "maxzoom": e["maxzoom"], "bounds": bounds_of(e["geometry"]), "bytes": nbytes,
            "files": {"base": f"packs/{e['id']}-base.pmtiles", "hs": f"packs/{e['id']}-hs.pmtiles"}}


def write_outlines(work, entries):
    """outlines.json: {id: [[ring, ...], ...]} — each pack's polygons (exterior first, then holes)
    simplified to OUTLINE_TOLERANCE, for the app to find the packs a position falls in."""
    from shapely.geometry import shape
    out = {}
    for e in entries:
        geom = shape(e["geometry"]).simplify(OUTLINE_TOLERANCE, preserve_topology=True)
        polys = [geom] if geom.geom_type == "Polygon" else list(geom.geoms)
        rings = lambda poly: [[[round(x, OUTLINE_DECIMALS), round(y, OUTLINE_DECIMALS)] for x, y in r.coords]
                              for r in (poly.exterior, *poly.interiors)]
        out[e["id"]] = [rings(poly) for poly in polys if not poly.is_empty]
    json.dump(out, open(work / "outlines.json", "w"), separators=(",", ":"))
    log(f"outlines: {len(out)} packs, {(work / 'outlines.json').stat().st_size / 1e6:.2f} MB")


def write_catalogue(work, rows, maxzoom):
    """catalogue.json: the archives and every pack, with `bytes` null where the pack isn't built."""
    rows.sort(key=lambda r: (r["parent"] or "", r["id"]))
    bundled = [work / f"global-z{BUNDLED_ZOOM}-{k}.pmtiles" for k in ("base", "hs")]
    cat = {"version": 1, "maxzoom": maxzoom, "bundled_maxzoom": BUNDLED_ZOOM,
           # Stock Protomaps landcover ends at z7; ours goes to maxzoom when landcover.pmtiles was built.
           "landcover_maxzoom": maxzoom if done(work / "landcover.pmtiles") else 7,
           "global": {"base": "global-base.pmtiles", "hs": "global-hs.pmtiles"},
           "bundled": {"base": bundled[0].name, "hs": bundled[1].name, "maxzoom": BUNDLED_ZOOM,
                       "bytes": sum(p.stat().st_size for p in bundled) if all(done(p) for p in bundled) else None},
           "packs": rows}
    json.dump(cat, open(work / "catalogue.json", "w"), indent=1)
    built = [r["bytes"] for r in rows if r["bytes"] is not None]
    log(f"catalogue: {len(rows)} packs, {len(built)} built, {sum(built) / 1e9:.2f} GB")


def build_catalogue(work, countries, states, maxzoom):
    """The catalogue and outlines alone, before any tiles exist: every pack with `bytes` null. The
    app bundles these so its offline-maps list can be built (and tested) ahead of the archives."""
    entries = catalogue_entries(countries, states, maxzoom)
    write_catalogue(work, [catalogue_row(e, None) for e in entries], maxzoom)
    write_outlines(work, entries)


def build_packs(work, base, hs, countries, states, maxzoom, only=None):
    packs = work / "packs"
    regions = work / "pack-regions"
    packs.mkdir(exist_ok=True)
    regions.mkdir(exist_ok=True)

    # Bundled overview.
    extract(base, work / f"global-z{BUNDLED_ZOOM}-base.pmtiles", maxzoom=BUNDLED_ZOOM)
    extract(hs, work / f"global-z{BUNDLED_ZOOM}-hs.pmtiles", maxzoom=BUNDLED_ZOOM)

    rows = []
    entries = catalogue_entries(countries, states, maxzoom)
    write_outlines(work, entries)
    if only:
        entries = [e for e in entries if e["id"] in only]
    for i, e in enumerate(entries):
        region = regions / f"{e['id']}.geojson"
        if not region.exists():
            json.dump({"type": "Feature", "properties": {}, "geometry": e["geometry"]}, open(region, "w"))
        pair = {}
        for kind, src in (("base", base), ("hs", hs)):
            out = packs / f"{e['id']}-{kind}.pmtiles"
            try:
                extract(src, out, region=region, maxzoom=e["maxzoom"])
            except subprocess.CalledProcessError:
                # A region with no tiles in the source (test runs on a regional source) yields
                # no pack; the catalogue simply omits it.
                log(f"no {kind} tiles for {e['id']}, skipping")
                if out.exists():
                    out.unlink()
                break
            pair[kind] = out.stat().st_size
        if len(pair) < 2:
            continue
        rows.append(catalogue_row(e, pair["base"] + pair["hs"]))
        log(f"pack {i + 1}/{len(entries)} {e['id']}: {(pair['base'] + pair['hs']) / 1e6:.1f} MB")
    write_catalogue(work, rows, maxzoom)


# ---------------------------------------------------------------- main

def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("step", choices=["all", "overture", "labels", "landcover", "vectors", "hillshade", "regions", "packs", "catalogue"])
    ap.add_argument("--work", required=True, type=Path)
    ap.add_argument("--maxzoom", type=int, default=10)
    ap.add_argument("--vectors", default=DEFAULT_VECTORS, help="Protomaps archive (file or https)")
    ap.add_argument("--terrain", default=DEFAULT_TERRAIN, help="Mapterhorn archive (file or https)")
    ap.add_argument("--landcover", default=DEFAULT_LANDCOVER, help="CGLS-LC100 discrete GeoTIFF (file or https); 'none' to keep stock z0-7")
    ap.add_argument("--bbox", help="W,S,E,N window for the landcover step (test runs)")
    ap.add_argument("--overture", type=Path, help="label tables db (default: DIR/overture.duckdb, built by the overture step)")
    ap.add_argument("--release", default=OVERTURE_RELEASE, help="Overture release for the overture step")
    ap.add_argument("--countries", type=Path, default=HERE.parent / "regions" / "ne_countries.geojson")
    ap.add_argument("--states", type=Path, default=HERE.parent / "regions" / "ne_states.geojson")
    ap.add_argument("--only", help="comma-separated pack ids (packs step), e.g. us-co,us-wa")
    a = ap.parse_args()
    a.work.mkdir(parents=True, exist_ok=True)
    a.overture = a.overture or a.work / "overture.duckdb"
    if a.step == "catalogue":
        # No tiles, no CLI tools: the tracked Natural Earth copies (or --countries/--states) suffice.
        build_catalogue(a.work, a.countries, a.states, a.maxzoom)
        return
    for tool in ("pmtiles", "tippecanoe", "tile-join", "duckdb"):
        if not shutil.which(tool):
            sys.exit(f"missing tool: {tool}")

    labels = base = hs = landcover = None
    if a.step in ("all", "overture"):
        build_overture(a.overture, a.release)
    if a.step in ("all", "labels", "vectors"):
        labels = build_labels(a.work, a.overture, a.maxzoom)
    if a.step in ("all", "landcover", "vectors") and a.landcover != "none":
        landcover = build_landcover(a.work, a.landcover, a.maxzoom, a.bbox)
    if a.step in ("all", "vectors"):
        base = build_vectors(a.work, a.vectors, labels, landcover, a.maxzoom)
    if a.step in ("all", "hillshade"):
        hs = build_hillshade(a.work, a.terrain, a.maxzoom)
    if a.step in ("all", "regions", "packs"):
        regions = build_regions(a.work)
    if a.step in ("all", "packs"):
        base = base or a.work / "global-base.pmtiles"
        hs = hs or a.work / "global-hs.pmtiles"
        for p in (base, hs):
            if not done(p):
                sys.exit(f"missing {p}; run vectors/hillshade first")
        build_packs(a.work, base, hs, regions["countries"], regions["states"], a.maxzoom,
                    only=set(a.only.split(",")) if a.only else None)
    log("done")


if __name__ == "__main__":
    main()
