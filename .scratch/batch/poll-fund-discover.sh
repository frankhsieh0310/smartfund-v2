#!/bin/bash
cd /c/Users/User/Desktop/smartfund-v2
for i in $(seq 1 100); do
  n=$(node --input-type=module -e '
import pg from "pg"; import { readFileSync } from "node:fs";
const url = readFileSync(new URL("./.env", import.meta.url), "utf8").match(/DATABASE_URL="([^"]+)"/)[1];
const c = new pg.Client({ connectionString: url, ssl: { rejectUnauthorized: false } }); await c.connect();
const r = await c.query("SELECT count(*)::int n FROM production_scheduler_runs WHERE job_id=$1 AND status=$2", ["YAHOO_FUND_UNIVERSE_DISCOVERY","COMPLETED"]);
console.log(r.rows[0].n);
await c.end();
' 2>/dev/null | tr -d '[:space:]')
  if [ "$n" -ge "1" ] 2>/dev/null; then
    echo "DISCOVERY_DONE"
    exit 0
  fi
  sleep 20
done
echo "TIMEOUT"
