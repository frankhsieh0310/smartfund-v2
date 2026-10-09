$ErrorActionPreference = "Stop"
$env:YAHOO_FUND_SCHEDULER = "1"

while ($true) {
  node --import tsx --env-file=.env scripts/data/global-fund/run-yahoo-fund-latest.ts
  Start-Sleep -Seconds 900
}
