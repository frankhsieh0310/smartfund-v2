$ErrorActionPreference = 'Stop'
$projectRoot = (Resolve-Path (Join-Path $PSScriptRoot '..\..\..')).Path
$runtime = Join-Path $projectRoot 'runtime\reit'
New-Item -ItemType Directory -Force -Path $runtime | Out-Null
$runner = Join-Path $projectRoot 'scripts\data\reit\run-global-reit.ts'
$node = (Get-Command node -ErrorAction Stop).Source
$info = [System.Diagnostics.ProcessStartInfo]::new()
$info.FileName = $node
$info.Arguments = "--experimental-strip-types --env-file=.env `"$runner`""
$info.WorkingDirectory = $projectRoot
$info.UseShellExecute = $false
$info.CreateNoWindow = $true
$process = [System.Diagnostics.Process]::new()
$process.StartInfo = $info
if (-not $process.Start()) { throw 'GLOBAL_REIT_START_FAILED' }
$process.Id | Set-Content -LiteralPath (Join-Path $runtime 'global-reit.pid')
Write-Output $process.Id
