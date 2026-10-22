$ErrorActionPreference = "Continue"
$env:FUND_RISK_PERFORMANCE_SCHEDULER = "1"
while ($true) {
  try { node --import tsx --env-file=.env scripts/data/global-fund/run-fund-risk-performance-latest.ts } catch { Write-Error $_ }
  Start-Sleep -Seconds 86400
}
