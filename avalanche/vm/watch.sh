#!/bin/zsh
# Waits for the training VM to stop. Restarts it after a preemption (training resumes from its
# checkpoint); exits when the guest powers itself off. Usage: watch.sh <hours>
set -u
F=(--project goingblue --zone us-central1-a)
VM=avalanche-train-1
deadline=$(( $(date +%s) + $1 * 3600 ))
while [ $(date +%s) -lt $deadline ]; do
  if [ "$(gcloud compute instances describe $VM $F --format='value(status)')" = TERMINATED ]; then
    last=$(gcloud compute operations list --project goingblue --filter="targetLink~$VM AND (operationType=compute.instances.preempted OR operationType=compute.instances.guestTerminate)" --sort-by=~insertTime --limit=1 --format='value(operationType)')
    if [ "$last" = compute.instances.guestTerminate ]; then echo "$(date) queue finished, VM powered off"; exit 0; fi
    echo "$(date) preempted, restarting"
    gcloud compute instances start $VM $F >/dev/null 2>&1 || echo "$(date) start failed (capacity?), will retry"
  fi
  sleep 120
done
echo "$(date) deadline reached"; exit 1
