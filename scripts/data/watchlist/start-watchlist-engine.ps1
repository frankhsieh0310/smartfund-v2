param([switch]$Once)

$ErrorActionPreference = "Stop"
$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot "..\..\..")).Path
$runtime = Join-Path $repoRoot "runtime\watchlist"
$pidFile = Join-Path $runtime "watchlist-engine.pid"
New-Item -ItemType Directory -Force -Path $runtime | Out-Null

if (Test-Path $pidFile) {
  $existingPid = [int](Get-Content $pidFile -Raw)
  if (Get-Process -Id $existingPid -ErrorAction SilentlyContinue) {
    Write-Output "PID=$existingPid"
    exit 0
  }
}

$arguments = @("--experimental-strip-types", "scripts/data/watchlist/run-watchlist-engine.ts")
if ($Once) { $arguments += "--once" }
$nodePath = (Get-Command node -ErrorAction Stop).Source
$startInfo = [System.Diagnostics.ProcessStartInfo]::new()
$startInfo.FileName = $nodePath
$startInfo.WorkingDirectory = $repoRoot
$startInfo.UseShellExecute = $false
$startInfo.CreateNoWindow = $true
$startInfo.Arguments = ($arguments -join " ")
$process = [System.Diagnostics.Process]::Start($startInfo)
Set-Content -Path $pidFile -Value $process.Id
Write-Output "PID=$($process.Id)"
