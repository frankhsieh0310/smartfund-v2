$ErrorActionPreference = 'Stop'
$rootPath = (Resolve-Path (Join-Path $PSScriptRoot '..\..\..')).Path
$runtimePath = Join-Path $rootPath 'runtime\money-market'
$runnerPath = Join-Path $rootPath 'scripts\data\money-market\run-global-money-market.ts'
New-Item -ItemType Directory -Force -Path $runtimePath | Out-Null
$nodePath = (Get-Command node -ErrorAction Stop).Source
$canary = Start-Process -FilePath $nodePath -ArgumentList @('--experimental-strip-types', $runnerPath, '--canary') -WorkingDirectory $rootPath -Wait -PassThru -NoNewWindow
if ($canary.ExitCode -ne 0) { throw "SOFR canary failed with exit code $($canary.ExitCode)" }
$process = Start-Process -FilePath $nodePath -ArgumentList @('--experimental-strip-types', $runnerPath) -WorkingDirectory $rootPath -PassThru -WindowStyle Hidden
$process.Id | Set-Content -LiteralPath (Join-Path $runtimePath 'runner.pid')
Write-Output $process.Id
