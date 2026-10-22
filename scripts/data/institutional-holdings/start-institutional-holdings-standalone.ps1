param([switch]$Canary)
$ErrorActionPreference = "Stop"
$projectRoot = (Resolve-Path (Join-Path $PSScriptRoot "..\..\..")).Path
$runtimeDir = Join-Path $projectRoot "runtime\institutional-holdings"
$arguments = @("--experimental-strip-types", "--env-file=.env", "scripts/data/institutional-holdings/run-institutional-supervisor-v2.ts")
if ($Canary) { $arguments += @("--canary", "--once") }
$start = [System.Diagnostics.ProcessStartInfo]::new(); $start.FileName="node"; $start.Arguments=($arguments -join " "); $start.WorkingDirectory=$projectRoot; $start.UseShellExecute=$true; $start.WindowStyle=[System.Diagnostics.ProcessWindowStyle]::Hidden
$process=[System.Diagnostics.Process]::Start($start); Set-Content -LiteralPath (Join-Path $runtimeDir "standalone.pid") -Value $process.Id -Encoding ascii; $process.Id
