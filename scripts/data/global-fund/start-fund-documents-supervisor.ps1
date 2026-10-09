$ErrorActionPreference = "Stop"
$env:FUND_DOCUMENTS_SCHEDULER = "1"

while ($true) {
  node --import tsx --env-file=.env scripts/data/global-fund/run-fund-documents-latest.ts
  Start-Sleep -Seconds 604800
}
