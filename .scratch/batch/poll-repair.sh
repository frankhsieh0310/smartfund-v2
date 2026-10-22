#!/bin/bash
cd /c/Users/User/Desktop/smartfund-v2
TARGET=$1
for i in $(seq 1 100); do
  n=$(node .scratch/batch/count-repair-done.mjs 2>/dev/null | tr -d '[:space:]')
  if [ "$n" -ge "$TARGET" ] 2>/dev/null; then
    echo "TARGET_REACHED n=$n"
    exit 0
  fi
  sleep 20
done
echo "TIMEOUT n=$n"
