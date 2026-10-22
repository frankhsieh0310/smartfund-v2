$ErrorActionPreference = "Continue"
$env:FUND_MONEYDJ_P0_SCHEDULER = "1"
while ($true) {
  try { node --import tsx --env-file=.env scripts/data/global-fund/run-fund-moneydj-p0-latest.ts } catch { Write-Error $_ }
  Start-Sleep -Seconds 86400
}
