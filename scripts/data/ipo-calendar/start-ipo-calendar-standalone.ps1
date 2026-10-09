param([switch]$Canary)
$ErrorActionPreference = "Stop"
$projectRoot = (Resolve-Path (Join-Path $PSScriptRoot "..\..\..")).Path
$runtimeDir = Join-Path $projectRoot "runtime\ipo-calendar"
New-Item -ItemType Directory -Force -Path $runtimeDir | Out-Null
$pidFile = Join-Path $runtimeDir "standalone.pid"
if (Test-Path -LiteralPath $pidFile) {
  $existingPid = Get-Content -LiteralPath $pidFile -ErrorAction SilentlyContinue
  if ($existingPid -and (Get-Process -Id ([int]$existingPid) -ErrorAction SilentlyContinue)) { Write-Output $existingPid; exit 0 }
}
$arguments = @("--experimental-strip-types", "--env-file=.env", "scripts/data/ipo-calendar/run-ipo-p0-expansion.ts")
if ($Canary) { $arguments += @("--canary", "--once") }
$startInfo = [System.Diagnostics.ProcessStartInfo]::new()
$startInfo.FileName = "node"
$startInfo.Arguments = ($arguments -join " ")
$startInfo.WorkingDirectory = $projectRoot
$startInfo.UseShellExecute = $true
$startInfo.WindowStyle = [System.Diagnostics.ProcessWindowStyle]::Hidden
$process = [System.Diagnostics.Process]::Start($startInfo)
Set-Content -LiteralPath $pidFile -Value $process.Id -Encoding ascii
$process.Id
