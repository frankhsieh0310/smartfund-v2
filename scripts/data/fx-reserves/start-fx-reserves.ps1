$ErrorActionPreference = 'Stop'
$rootPath = (Resolve-Path (Join-Path $PSScriptRoot '..\..\..')).Path
$runtimePath = Join-Path $rootPath 'runtime\fx-reserves'
$runnerPath = Join-Path $rootPath 'scripts\data\fx-reserves\run-global-fx-reserves.ts'
New-Item -ItemType Directory -Force -Path $runtimePath | Out-Null
$nodePath = (Get-Command node -ErrorAction Stop).Source
$pidPath = Join-Path $runtimePath 'runner.pid'
if (Test-Path -LiteralPath $pidPath) {
  $existingPid = [int](Get-Content -LiteralPath $pidPath -Raw)
  if (Get-Process -Id $existingPid -ErrorAction SilentlyContinue) {
    Write-Output $existingPid
    return
  }
}
& $nodePath --experimental-strip-types --env-file=.env $runnerPath --canary
if ($LASTEXITCODE -ne 0) { throw "FX reserves canary failed with exit code $LASTEXITCODE" }
$process = Start-Process -FilePath $nodePath `
  -ArgumentList @('--experimental-strip-types', '--env-file=.env', $runnerPath) `
  -WorkingDirectory $rootPath `
  -WindowStyle Hidden `
  -PassThru
$process.Id | Set-Content -LiteralPath $pidPath
Write-Output $process.Id
