$ErrorActionPreference = "Continue"
$env:FUND_CLASSIFICATION_SCHEDULER = "1"

while ($true) {
  try {
    node --import tsx --env-file=.env scripts/data/global-fund/run-fund-classification-latest.ts
  } catch {
    Write-Error $_
  }
  Start-Sleep -Seconds 2592000
}
