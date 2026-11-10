#!/bin/bash
# Trains and evaluates each run in runs.txt ("<name> <script> <train args>") that has no <name>.done yet.
# Exits nonzero at the first failed run.
set -u
cd "$(dirname "$0")"
PY=${PY:-python3}
while read -r name script args; do
  case "$name" in ""|\#*) continue ;; esac
  [ -f "$name.done" ] && continue
  echo "$(date -u +%FT%TZ) train $name $script $args" >> queue.log
  $PY -u $script train --name "$name" $args >> "$name.log" 2>&1 || { echo "$(date -u +%FT%TZ) $name train failed" >> queue.log; exit 1; }
  $PY -u $script eval --name "$name" > "$name.eval.txt" 2>&1 || { echo "$(date -u +%FT%TZ) $name eval failed" >> queue.log; exit 1; }
  touch "$name.done"
  echo "$(date -u +%FT%TZ) $name done" >> queue.log
done < runs.txt
