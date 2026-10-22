$ErrorActionPreference = 'Stop'
$repo = (Resolve-Path (Join-Path $PSScriptRoot '..\..\..')).Path
$runtime = Join-Path $repo 'runtime\energy-physical-supply-demand'
New-Item -ItemType Directory -Force -Path $runtime | Out-Null
$pidFile = Join-Path $runtime 'supervisor.pid'
if (Test-Path $pidFile) {
  $existingPid = [int](Get-Content -Raw $pidFile)
  if (Get-Process -Id $existingPid -ErrorAction SilentlyContinue) { Write-Output "ALREADY_RUNNING PID=$existingPid"; exit 0 }
}
$stdout = Join-Path $runtime 'supervisor.stdout.log'
$stderr = Join-Path $runtime 'supervisor.stderr.log'
$process = Start-Process -FilePath 'node' -ArgumentList '--experimental-strip-types','--env-file=.env','scripts/data/energy-physical-supply-demand/run-energy-physical-supply-demand.ts' -WorkingDirectory $repo -RedirectStandardOutput $stdout -RedirectStandardError $stderr -WindowStyle Hidden -PassThru
$process.Id | Set-Content -NoNewline $pidFile
Write-Output "STARTED PID=$($process.Id)"
