#!/bin/bash
cd /c/Users/User/Desktop/smartfund-v2
for i in $(seq 1 60); do
  node .scratch/batch/check-cloud-runs.mjs > .scratch/batch/cloud-poll-out.txt 2>&1
  if grep -q '"status": "COMPLETED"' .scratch/batch/cloud-poll-out.txt; then
    echo "SLICE1_DONE"
    exit 0
  fi
  sleep 15
done
echo "TIMEOUT"
