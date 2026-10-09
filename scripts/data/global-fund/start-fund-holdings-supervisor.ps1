$ErrorActionPreference = "Stop"
$env:FUND_HOLDINGS_SCHEDULER = "1"

while ($true) {
  node --import tsx --env-file=.env scripts/data/global-fund/run-fund-holdings-latest.ts
  Start-Sleep -Seconds 86400
}
