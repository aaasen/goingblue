# Offline basemap

One global z0–10 pair — `global-base.pmtiles` (stripped Protomaps vectors + Overture labels +
Copernicus land cover) and `global-hs.pmtiles` (prebaked hillshade from Mapterhorn) — lives on
R2 and is what the app streams online. Everything else is a `pmtiles extract` of it: the z0–6
pair bundled in the app, one pack per country, and US-state / CA-province packs. No z11+ tier.

    build/      basemap.py driver; strip_build.py (vectors), hillshade_build.py (terrain),
                landcover_build.py (CGLS-LC100), overture_labels.sql (labels with English names)
    preview/    browser preview: work.html composes bundled z6 + a pack + the online archive the
                way the app does; chunked.html / index.html are the earlier prototypes
    Dockerfile  the pipeline with its tools, for the VM run

Inputs and outputs are large and untracked; locally they live in `data/basemap/` (gitignored):
`sources/` (downloads: terrain, Protomaps extracts, overture.duckdb, `cgls-lc100-2019-wa.tif`),
`archives/` (prototype pmtiles the old previews read), `work-*/` (driver outputs).
`preview/work` and `preview/archives` are symlinks into it.

## Pipeline (`build/basemap.py STEP --work DIR ...`)

| step        | output                         | from                                             |
|-------------|--------------------------------|--------------------------------------------------|
| `overture`  | `overture.duckdb`              | Overture release: named peaks/lakes/glaciers, `name_en` |
| `labels`    | `labels.pmtiles`               | ranked per 0.25° cell, minzoom by elevation/area |
| `landcover` | `landcover.pmtiles`            | CGLS-LC100 100 m, 4 zoom bands (stock ends at z7) |
| `vectors`   | `global-base.pmtiles`          | strip Protomaps + tile-join labels + landcover   |
| `hillshade` | `global-hs.pmtiles`            | Mapterhorn terrarium → Horn shade, WebP q40       |
| `regions`   | `regions/ne_*.geojson`         | Natural Earth 10m admin-0 / admin-1 download     |
| `packs`     | `packs/*`, `global-z6-*`, `catalogue.json` | `pmtiles extract --region` per NE country + US/CA admin-1 |

`all` runs them in order. Every step skips outputs that already exist, so a killed run (spot
VM) resumes with the same command. `--vectors/--terrain/--landcover` accept a local file or an
https archive (the defaults are the public archives, extracted to z0–maxzoom first).

## Local test (inputs already on disk, ~5 min)

    python3 -m venv venv && venv/bin/pip install -r build/requirements.txt   # + tippecanoe, pmtiles, duckdb on PATH
    venv/bin/python build/basemap.py all --work data/basemap/work-usa-z9 --maxzoom 9 \
        --overture data/basemap/sources/overture.duckdb \
        --vectors data/basemap/sources/usa-src-z9.pmtiles --terrain data/basemap/sources/usa-terrain-z9.pmtiles \
        --landcover data/basemap/sources/cgls-lc100-2019-wa.tif --only us,us-co,us-wa
    maps/preview/run.sh            # then http://localhost:8471/work.html
    pnpm --filter @weather/maps-preview shots [pack-id]   # screenshots into preview/shots-out/

## Full build on a VM

Nothing is needed from a dev machine: the pipeline downloads its own inputs (public archives,
Overture via S3, the CGLS GeoTIFF, Natural Earth polygons). Four steps: clone, build, run, upload.

**1. Create the VM** (spot, 8 vCPU, 300 GB SSD-class disk — the bake mmaps the terrain archive):

```bash
gcloud compute instances create basemap \
  --zone us-west1-b --machine-type e2-standard-8 \
  --provisioning-model SPOT --instance-termination-action STOP \
  --image-family debian-12 --image-project debian-cloud \
  --boot-disk-size 300GB --boot-disk-type pd-balanced
gcloud compute ssh basemap --zone us-west1-b
```

**2. Clone and build** (on the VM; the image build is ~5 min, mostly compiling tippecanoe):

```bash
sudo apt-get update && sudo apt-get install -y docker.io git rclone tmux
sudo usermod -aG docker $USER && newgrp docker
git clone https://github.com/aaasen/goingblue
docker build -t basemap goingblue/maps
sudo mkdir -p /data && sudo chown $USER /data
```

**3. Run** under tmux so an SSH drop doesn't kill it:

```bash
tmux new -s build
docker run --rm -v /data:/data basemap all --work /data/work-z10 --maxzoom 10 2>&1 | tee -a /data/build.log
```

Detach with `Ctrl-b d`, `tmux attach -t build` to check. Order: Overture scan → labels → CGLS
download (1.7 GB) + landcover → Protomaps z0–10 extract (~8 GB) → strip + join → Mapterhorn
z0–10 extract (~50–60 GB, the longest download) → bake → Natural Earth → packs + catalogue.

If spot preempts the VM it stops: `gcloud compute instances start basemap --zone us-west1-b`,
ssh back in, rerun the same `docker run`. Finished steps are skipped; the step in flight
restarts (`pmtiles extract` and the bake are not resumable mid-step).

**4. Upload to R2.** One-time `rclone config`: type `s3`, provider `Cloudflare`, the R2 access
key and secret, endpoint `https://<account-id>.r2.cloudflarestorage.com`. Then:

    rclone copy /data/work-z10 r2:basemap --include 'global-*.pmtiles' --include 'packs/**' \
        --include catalogue.json --progress

Fetch `catalogue.json` and the `global-z6-*` pair locally for the app. Keep the raw extracts
(`*-src-z10.pmtiles`, ~60 GB) only if a rebake is likely — `rclone copy` them too.

**5. Delete the VM** (the disk goes with it; a lingering 300 GB disk is ~$30/month):

    gcloud compute instances delete basemap --zone us-west1-b

Sizing: ~60–70 GB of source reads (ingress is free), ~3–5 GB of output. The laptop baked ~75
hillshade tiles/s on 10 workers, so the global z10 bake is hours, not days; spot at ~$0.08/hr
makes the whole run a few dollars. `WORKERS=` overrides the process counts.

Sources are evaluation endpoints: build.protomaps.com is pinned to 20260820 in both
`basemap.py` and `packages/mobile/basemapStyle.ts` — bump together; download.mapterhorn.com;
Zenodo 3939050 (CGLS); naciscdn.org (Natural Earth). Attribution owed: OpenStreetMap,
Protomaps, Overture, Mapterhorn / Copernicus DEM, Copernicus Global Land Service, Natural Earth.
