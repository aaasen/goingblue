#!/bin/bash
# Training VM boot: mount the data disk, run the queue, power off. A HOLD file on the disk, or the
# instance metadata attribute train-hold, skips the queue and leaves the VM up.
set -u
MNT=/mnt/train
mkdir -p $MNT
mountpoint -q $MNT || mount -o discard,defaults /dev/disk/by-id/google-avalanche-train $MNT
cd $MNT/neural || exit 1
HOLD_ATTR=$(curl -sf -H "Metadata-Flavor: Google" http://metadata.google.internal/computeMetadata/v1/instance/attributes/train-hold)
[ -f HOLD ] || [ -n "$HOLD_ATTR" ] && { echo "$(date -u +%FT%TZ) hold, not running" >> queue.log; exit 0; }
for i in $(seq 1 60); do nvidia-smi > /dev/null 2>&1 && break; sleep 10; done
nvidia-smi >> boot.log 2>&1
PY=/opt/conda/bin/python
[ -x $PY ] || PY=python3
$PY -m pip install -q sentencepiece "transformers>=4.51,<5" >> boot.log 2>&1
export HF_HOME=$MNT/hf
# Code and data share one flat directory on the disk.
export NEURAL_DATA=$MNT/neural
PY=$PY ./run.sh
rc=$?
echo "$(date -u +%FT%TZ) queue exited $rc, powering off" >> queue.log
sync
poweroff
