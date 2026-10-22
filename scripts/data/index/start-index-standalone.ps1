param([switch]$Canary)
$ErrorActionPreference = 'Stop'
$workspace = (Resolve-Path (Join-Path $PSScriptRoot '..\..\..')).Path
$runtime = Join-Path $workspace 'runtime\index'
$log = Join-Path $runtime 'index-standalone.log'
$pidFile = Join-Path $runtime 'standalone.pid'
New-Item -ItemType Directory -Force -Path (Join-Path $runtime 'archive') | Out-Null
$arguments = @('--experimental-strip-types', '--env-file=.env', 'scripts/data/index/run-global-index.ts', '--resume-wait')
if ($Canary) { $arguments += '--canary' }
$node = (Get-Command node).Source
$info = [System.Diagnostics.ProcessStartInfo]::new()
$info.FileName = $node
$info.Arguments = ($arguments | ForEach-Object { '"{0}"' -f $_ }) -join ' '
$info.WorkingDirectory = $workspace
$info.UseShellExecute = $true
$info.WindowStyle = [System.Diagnostics.ProcessWindowStyle]::Hidden
$process = [System.Diagnostics.Process]::Start($info)
if (-not $process) { throw 'Failed to start GLOBAL_INDEX standalone process' }
Set-Content -LiteralPath $pidFile -Value $process.Id -Encoding ascii
[ordered]@{ asset='GLOBAL_INDEX'; pid=$process.Id; startedAt=[DateTime]::UtcNow.ToString('o'); canary=[bool]$Canary } | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $runtime 'launch.json') -Encoding utf8
$process.Id
