$ErrorActionPreference = "Stop"
$workspace = (Resolve-Path (Join-Path $PSScriptRoot "..\..\..")).Path
$node = (Get-Command node.exe -ErrorAction Stop).Source
Push-Location $workspace
try {
  & $node --experimental-strip-types --env-file=.env scripts/data/fx-options/run-public-fx-options-volatility.ts
  exit $LASTEXITCODE
} finally {
  Pop-Location
}
