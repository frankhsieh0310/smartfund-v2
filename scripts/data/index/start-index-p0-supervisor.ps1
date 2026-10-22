$ErrorActionPreference = 'Stop'
$workspace = (Resolve-Path (Join-Path $PSScriptRoot '..\..\..')).Path
$runtime = Join-Path $workspace 'runtime\index'
$node = (Get-Command node).Source
$info = [System.Diagnostics.ProcessStartInfo]::new()
$info.FileName = $node
$info.Arguments = '--experimental-strip-types --env-file=.env scripts/data/index/run-index-p0-recovery.ts'
$info.WorkingDirectory = $workspace
$info.UseShellExecute = $true
$info.WindowStyle = [System.Diagnostics.ProcessWindowStyle]::Hidden
$process = [System.Diagnostics.Process]::Start($info)
if (-not $process) { throw 'Failed to start GLOBAL_INDEX P0 supervisor' }
Set-Content -LiteralPath (Join-Path $runtime 'p0-supervisor.pid') -Value $process.Id -Encoding ascii
[ordered]@{asset='GLOBAL_INDEX';mode='P0_BACKGROUND';pid=$process.Id;startedAt=[DateTime]::UtcNow.ToString('o')} | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $runtime 'p0-supervisor-launch.json') -Encoding utf8
$process.Id
