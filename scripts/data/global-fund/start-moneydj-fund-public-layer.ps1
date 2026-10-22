$ErrorActionPreference = "Stop"
Set-Location (Resolve-Path (Join-Path $PSScriptRoot "..\..\.."))
node --experimental-strip-types --env-file=.env scripts/data/global-fund/run-moneydj-fund-public-layer.ts
