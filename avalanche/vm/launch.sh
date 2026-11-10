#!/bin/zsh
# Starts the training VM (retrying while the zone has no Spot capacity), uploads the given files to
# the data disk, clears the hold flag and starts the queue. Usage: launch.sh <minutes> <files...>
set -u
F=(--project goingblue --zone us-central1-a)
VM=avalanche-train-1
deadline=$(( $(date +%s) + $1 * 60 )); shift
cd "$(dirname "$0")"
gcloud compute instances add-metadata $VM $F --metadata train-hold=1 >/dev/null 2>&1
until gcloud compute instances start $VM $F >/dev/null 2>&1 && [ "$(gcloud compute instances describe $VM $F --format='value(status)')" = RUNNING ]; do
  [ $(date +%s) -gt $deadline ] && { echo "$(date) no capacity before deadline"; exit 1; }
  echo "$(date) start failed, retrying in 3 min"; sleep 180
done
echo "$(date) running"
for i in $(seq 1 30); do gcloud compute ssh $VM $F --quiet --ssh-flag="-o ConnectTimeout=15" --command "test -d /mnt/train/neural" >/dev/null 2>&1 && break; sleep 10; done
gcloud compute scp $F --quiet "$@" $VM:/tmp/ || { echo "upload failed"; exit 1; }
names=(${@:t})
gcloud compute instances remove-metadata $VM $F --keys train-hold >/dev/null
gcloud compute ssh $VM $F --quiet --command "cd /tmp && sudo cp ${names[*]} /mnt/train/neural/ && cd /mnt/train/neural && sha256sum ${names[*]} && sudo systemd-run --unit=train-queue-\$(date +%s) /bin/bash /mnt/train/neural/startup.sh" 2>&1 | grep -v -iE "setlocale|permanently added"
shasum -a 256 "$@"
echo "$(date) queue started"
