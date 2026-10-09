$ErrorActionPreference = 'Stop'
$root = (Resolve-Path (Join-Path $PSScriptRoot '..\..\..')).Path
$runtime = Join-Path $root 'runtime\futures-global-daily-technical'
New-Item -ItemType Directory -Force -Path $runtime | Out-Null
$pidFile = Join-Path $runtime 'owner.pid'
if (Test-Path $pidFile) {
  $oldPid = [int](Get-Content $pidFile -Raw)
  if (Get-Process -Id $oldPid -ErrorAction SilentlyContinue) { Write-Output "ALREADY_RUNNING PID=$oldPid"; exit 0 }
}
$p = Start-Process -FilePath 'node' -ArgumentList '--env-file=.env','--experimental-strip-types','scripts/data/futures/run-commodity-technical-analytics.ts','--global-futures' -WorkingDirectory $root -RedirectStandardOutput (Join-Path $runtime 'worker.stdout.log') -RedirectStandardError (Join-Path $runtime 'worker.stderr.log') -WindowStyle Hidden -PassThru
Set-Content -LiteralPath $pidFile -Value $p.Id -NoNewline
Write-Output "STARTED PID=$($p.Id)"
