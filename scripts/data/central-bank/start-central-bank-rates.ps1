$ErrorActionPreference = 'Stop'
$rootPath = (Resolve-Path (Join-Path $PSScriptRoot '..\..\..')).Path
$runtimePath = Join-Path $rootPath 'runtime\central-bank'
New-Item -ItemType Directory -Force -Path $runtimePath | Out-Null
$runnerPath = Join-Path $rootPath 'scripts\data\central-bank\run-central-bank-rates.ts'
$pidPath = Join-Path $runtimePath 'runner.pid'
$existingPid = 0
if (Test-Path -LiteralPath $pidPath) { [void][int]::TryParse((Get-Content -LiteralPath $pidPath -Raw).Trim(), [ref]$existingPid) }
if ($existingPid -gt 0 -and (Get-Process -Id $existingPid -ErrorAction SilentlyContinue)) { Write-Output $existingPid; exit 0 }
$nodePath = (Get-Command node -ErrorAction Stop).Source
$startInfo = [System.Diagnostics.ProcessStartInfo]::new()
$startInfo.FileName = $nodePath
$startInfo.WorkingDirectory = $rootPath
$startInfo.UseShellExecute = $true
$startInfo.CreateNoWindow = $true
$startInfo.Arguments = '--experimental-strip-types --env-file=.env "' + $runnerPath + '"'
$process = [System.Diagnostics.Process]::new()
$process.StartInfo = $startInfo
$null = $process.Start()
$process.Id | Set-Content -LiteralPath $pidPath
Write-Output $process.Id
