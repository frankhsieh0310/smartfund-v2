param([switch]$Canary)
$ErrorActionPreference = "Stop"
$projectRoot = (Resolve-Path (Join-Path $PSScriptRoot "..\..\..")).Path
$runtimeDir = Join-Path $projectRoot "runtime\earnings-calendar"
$arguments = @("--experimental-strip-types", "--env-file=.env", "scripts/data/earnings-calendar/run-global-earnings-calendar.ts")
if ($Canary) { $arguments += @("--canary", "--once") }
$startInfo = [System.Diagnostics.ProcessStartInfo]::new()
$startInfo.FileName = "node"
$startInfo.Arguments = ($arguments -join " ")
$startInfo.WorkingDirectory = $projectRoot
$startInfo.UseShellExecute = $true
$startInfo.WindowStyle = [System.Diagnostics.ProcessWindowStyle]::Hidden
$process = [System.Diagnostics.Process]::Start($startInfo)
Set-Content -LiteralPath (Join-Path $runtimeDir "standalone.pid") -Value $process.Id -Encoding ascii
$process.Id
