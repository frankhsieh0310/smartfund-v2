#!/bin/bash
cd /c/Users/User/Desktop/smartfund-v2
for i in $(seq 1 80); do
  n=$(node .scratch/batch/count-completed.mjs 2>/dev/null | tr -d '[:space:]')
  if [ "$n" -ge "2" ] 2>/dev/null; then
    echo "TWO_SLICES_DONE n=$n"
    exit 0
  fi
  sleep 20
done
echo "TIMEOUT n=$n"
