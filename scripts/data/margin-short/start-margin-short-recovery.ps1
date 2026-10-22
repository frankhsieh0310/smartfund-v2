$ErrorActionPreference = 'Stop'
$ProjectRoot = (Resolve-Path (Join-Path $PSScriptRoot '..\..\..')).Path
$RuntimePath = Join-Path $ProjectRoot 'runtime\margin-short'
$RunnerPath = Join-Path $PSScriptRoot 'recover-margin-short-depth.ts'
$Process = Start-Process -FilePath 'node' -ArgumentList @('--env-file=.env', $RunnerPath) -WorkingDirectory $ProjectRoot -WindowStyle Hidden -PassThru
$Process.Id | Set-Content -LiteralPath (Join-Path $RuntimePath 'recovery-runner.pid') -Encoding ascii
Write-Output $Process.Id
