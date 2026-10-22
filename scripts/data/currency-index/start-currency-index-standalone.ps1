$ErrorActionPreference = "Stop"
$workspace = (Resolve-Path (Join-Path $PSScriptRoot "..\..\..")).Path
$runtime = Join-Path $workspace "runtime\currency-index"
New-Item -ItemType Directory -Force -Path $runtime | Out-Null
$node = (Get-Command node.exe -ErrorAction Stop).Source
$start = [System.Diagnostics.ProcessStartInfo]::new()
$start.FileName = $node
$start.Arguments = '--experimental-strip-types --env-file=.env scripts/data/currency-index/run-currency-index-p0-recovery.ts'
$start.WorkingDirectory = $workspace
$start.UseShellExecute = $true
$start.WindowStyle = [System.Diagnostics.ProcessWindowStyle]::Hidden
$process = [System.Diagnostics.Process]::Start($start)
$process.Id | Set-Content -LiteralPath (Join-Path $runtime "launcher.pid") -Encoding ascii
[pscustomobject]@{ PID = $process.Id; Alive = -not $process.HasExited; Checkpoint = (Join-Path $runtime "checkpoint.json"); Log = (Join-Path $runtime "standalone.log") }
