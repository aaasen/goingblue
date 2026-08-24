# Maps

Going Blue has a couple uses for maps:
1. Custom location selector.
2. Showing the forecast point.

The simplest solution would be to use the built-in Apple Maps and Google Maps, but these don't have any offline support. They might work if the forecast tile happens to be in the cache, but there are no guarantees.

To solve this, Going Blue uses a custom offline map built with MapLibre Native and PMTiles.

The basemap is custom-built to provide adequate detail in the mountains while maintaining a small size. It is built from the following sources:
 - Protomaps for vectors
 - Mapterhorn DEM for hillshading
 - Overture for labels
 - Copernicus Global Land Service CGLS-LC100 for land cover
 - Natural Earth for region boundaries

The basemap is hosted on Cloudflare R2 (free egress).

A global z6 basemap is bundled into the app. Country, state, and province tiles are downloadable at z9 and z10 resolution. There is also a tile cache of up to 500MB.

## Basemap Generation

The entire custom basemap can be regenerated from public sources using a Docker container running on a VM.

1. Create the VM (8 CPUs, 300GB disk):

```bash
gcloud compute instances create basemap \
  --zone us-west1-b --machine-type e2-standard-8 \
  --provisioning-model SPOT --instance-termination-action STOP \
  --image-family debian-12 --image-project debian-cloud \
  --boot-disk-size 300GB --boot-disk-type pd-balanced
gcloud compute ssh basemap --zone us-west1-b
```

Note that this uses a spot instance for lower cost.

2. Clone the repository and build the Docker image:

```bash
sudo apt-get update && sudo apt-get install -y docker.io git rclone tmux
sudo usermod -aG docker $USER && newgrp docker
git clone https://github.com/aaasen/goingblue
docker build -t basemap goingblue/maps
sudo mkdir -p /data && sudo chown $USER /data
```

3. Run the container.

```bash
tmux new -s build
docker run --rm -v /data:/data basemap all --work /data/work-z10 --maxzoom 10 2>&1 | tee -a /data/build.log
```

This may take several hours so it should be run under tmux. Detach from the tmux session with `Ctrl-b d` and re-attach with `tmux attach -t build`.

If the VM is preempted, start it again and re-run the Docker container. It uses a persistent disk so it will not redo any steps that have already finished.

```bash
gcloud compute instances start basemap --zone us-west1-b
gcloud compute ssh basemap --zone us-west1-b
```

4. Upload to Cloudflare R2.

Configure rclone: `rclone config`
 - Type `s3`
 - Provider `Cloudflare`
 - R2 access key and secret
 - Endpoint `https://<account-id>.r2.cloudflarestorage.com`

Upload to R2:
```bash
rclone copy /data/work-z10 r2:basemap --include 'global-*.pmtiles' --include 'packs/**' --include catalogue.json --progress
```

5. Update the basemap bundled in the app.

Run this from your own machine, not the VM:

```bash
gcloud compute scp --zone us-west1-b \
  basemap:/data/work-z10/{catalogue.json,outlines.json,global-z6-base.pmtiles,global-z6-hs.pmtiles} \
  packages/mobile/assets/
```

6. Delete the VM.

```bash
gcloud compute instances delete basemap --zone us-west1-b
```
