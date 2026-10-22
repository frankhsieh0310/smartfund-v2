#!/bin/bash
for i in 1 2; do
  sleep 70
  curl -s "https://smartfund-v2.vercel.app/api/yahoo-ingestion/progress" -o /c/Users/User/Desktop/smartfund-v2/.scratch/batch/progress-check-$((i+1)).json
done
echo DONE
