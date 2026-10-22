$ErrorActionPreference = 'Stop'
$ProjectRoot = (Resolve-Path (Join-Path $PSScriptRoot '..\..\..')).Path
$RuntimePath = Join-Path $ProjectRoot 'runtime\margin-short'
New-Item -ItemType Directory -Force -Path $RuntimePath | Out-Null
$RunnerPath = Join-Path $PSScriptRoot 'run-global-margin-short.ts'
$Process = Start-Process -FilePath 'node' -ArgumentList @($RunnerPath) -WorkingDirectory $ProjectRoot -WindowStyle Hidden -PassThru
$Process.Id | Set-Content -LiteralPath (Join-Path $RuntimePath 'runner.pid') -Encoding ascii
Write-Output $Process.Id
