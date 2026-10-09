$ErrorActionPreference = "Stop"
$repositoryRoot = Resolve-Path (Join-Path $PSScriptRoot "..\..\..")
Push-Location $repositoryRoot
try {
  npm run monitor:assets
} finally {
  Pop-Location
}
