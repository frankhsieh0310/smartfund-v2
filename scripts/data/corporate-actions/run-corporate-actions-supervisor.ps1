$ErrorActionPreference = 'Stop'
$root = (Resolve-Path (Join-Path $PSScriptRoot '..\..\..')).Path
Set-Location $root
& (Get-Command node -ErrorAction Stop).Source --experimental-strip-types --env-file=.env scripts/data/corporate-actions/run-global-corporate-actions.ts
exit $LASTEXITCODE
