$ErrorActionPreference = 'Stop'
$root = (Resolve-Path (Join-Path $PSScriptRoot '..\..\..')).Path
Set-Location $root
& (Get-Command node -ErrorAction Stop).Source --env-file=.env scripts/data/share-buyback/run-global-share-buyback.ts
exit $LASTEXITCODE
