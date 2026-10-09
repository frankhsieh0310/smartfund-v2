param([switch]$NoWindow)
$ErrorActionPreference = 'Stop'
$projectRoot = (Resolve-Path (Join-Path $PSScriptRoot '../../..')).Path
$runtime = Join-Path $projectRoot 'runtime/dividend-calendar'
New-Item -ItemType Directory -Force -Path $runtime | Out-Null
$runner = Join-Path $PSScriptRoot 'run-global-dividend-calendar.ts'
$pidFile = Join-Path $runtime 'runner.pid'
if (Test-Path -LiteralPath $pidFile) {
  $existingPid = Get-Content -LiteralPath $pidFile -ErrorAction SilentlyContinue
  if ($existingPid -and (Get-Process -Id ([int]$existingPid) -ErrorAction SilentlyContinue)) { Write-Output $existingPid; exit 0 }
}
$launcher = Join-Path $PSScriptRoot 'start-dividend-calendar.mjs'
& node $launcher
