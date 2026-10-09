$ErrorActionPreference='Stop'
$ProjectRoot=(Resolve-Path(Join-Path $PSScriptRoot '..\..\..')).Path
$Runtime=Join-Path $ProjectRoot 'runtime\margin-short'
$Runner=Join-Path $PSScriptRoot 'complete-margin-short-v2.ts'
$Process=Start-Process -FilePath 'node' -ArgumentList @('--env-file=.env',$Runner) -WorkingDirectory $ProjectRoot -WindowStyle Hidden -PassThru
$Process.Id|Set-Content -LiteralPath (Join-Path $Runtime 'v2-runner.pid') -Encoding ascii
$Process.Id
