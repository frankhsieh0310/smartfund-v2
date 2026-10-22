$ErrorActionPreference = "Stop"
if (-not $env:GLOBAL_FUND_SUPERVISOR_PID) { throw "GLOBAL_FUND_SUPERVISOR_PID_REQUIRED" }
Set-Location "C:\Users\User\Desktop\smartfund-v2"
node --experimental-strip-types --env-file=.env scripts/data/global-fund/run-fund-nav-owned-child.ts
