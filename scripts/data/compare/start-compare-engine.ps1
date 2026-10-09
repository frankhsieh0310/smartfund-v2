param([switch]$Once)
$ErrorActionPreference = "Stop"
$workspace = (Resolve-Path (Join-Path $PSScriptRoot "..\..\..")).Path
$runtime = Join-Path $workspace "runtime\compare"
$arguments = @("--experimental-strip-types", "--env-file=.env", "scripts/data/compare/run-global-compare-engine.ts")
if ($Once) { $arguments += "--once" } else { $arguments += @("--daemon", "--resume") }
$node = (Get-Command node -ErrorAction Stop).Source
$startInfo = [System.Diagnostics.ProcessStartInfo]::new()
$startInfo.FileName = $node
$startInfo.Arguments = $arguments -join " "
$startInfo.WorkingDirectory = $workspace
$startInfo.UseShellExecute = $true
$startInfo.WindowStyle = [System.Diagnostics.ProcessWindowStyle]::Hidden
$process = [System.Diagnostics.Process]::Start($startInfo)
@{ pid = $process.Id; startedAt = (Get-Date).ToUniversalTime().ToString("o"); command = "node $($arguments -join ' ')" } | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $runtime "process.json") -Encoding utf8
$process.Id
