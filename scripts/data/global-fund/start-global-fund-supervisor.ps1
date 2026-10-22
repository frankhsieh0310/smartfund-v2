$ErrorActionPreference = "Stop"
$env:SMARTFUND_SCHEDULER = "1"
$env:SMARTFUND_SUPERVISOR_PID = "$PID"

while ($true) {
  node --import tsx --env-file=.env scripts/data/global-fund/run-global-fund-latest.ts
  node --import tsx --env-file=.env scripts/data/global-fund/run-provider-expansion-queue.ts
  Start-Sleep -Seconds 21600
}
