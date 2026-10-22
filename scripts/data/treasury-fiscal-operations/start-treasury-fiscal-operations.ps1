$ErrorActionPreference = 'Stop'
$repo = (Resolve-Path (Join-Path $PSScriptRoot '..\..\..')).Path
$runtime = Join-Path $repo 'runtime\treasury-fiscal-operations'
New-Item -ItemType Directory -Force -Path $runtime | Out-Null
$existingPidFile = Join-Path $runtime 'supervisor.pid'
if (Test-Path $existingPidFile) {
  $existingPid = [int](Get-Content -Raw $existingPidFile)
  if (Get-Process -Id $existingPid -ErrorAction SilentlyContinue) { Write-Output "ALREADY_RUNNING PID=$existingPid"; exit 0 }
}
$stdout = Join-Path $runtime 'supervisor.stdout.log'
$stderr = Join-Path $runtime 'supervisor.stderr.log'
$process = Start-Process -FilePath 'node' -ArgumentList '--experimental-strip-types','--env-file=.env','scripts/data/treasury-fiscal-operations/run-treasury-fiscal-operations.ts' -WorkingDirectory $repo -RedirectStandardOutput $stdout -RedirectStandardError $stderr -WindowStyle Hidden -PassThru
$process.Id | Set-Content -NoNewline $existingPidFile
Write-Output "STARTED PID=$($process.Id)"
