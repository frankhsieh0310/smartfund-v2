$ErrorActionPreference = 'Stop'
$root = (Resolve-Path (Join-Path $PSScriptRoot '..\..\..')).Path
$runtime = Join-Path $root 'runtime\macro-alfred-true-vintage'
$pidFile = Join-Path $runtime 'worker.pid'
New-Item -ItemType Directory -Force -Path $runtime | Out-Null
if (Test-Path $pidFile) {
  $workerPid = 0
  [void][int]::TryParse((Get-Content -Raw $pidFile).Trim(), [ref]$workerPid)
  if ($workerPid -gt 0 -and (Get-Process -Id $workerPid -ErrorAction SilentlyContinue)) { $workerPid; exit 0 }
}
$runner = Join-Path $PSScriptRoot 'run-macro-alfred-true-vintage.ts'
$process = Start-Process -FilePath 'node' -ArgumentList '--env-file=.env','--experimental-strip-types',$runner -WorkingDirectory $root -RedirectStandardOutput (Join-Path $runtime 'worker.stdout.log') -RedirectStandardError (Join-Path $runtime 'worker.stderr.log') -WindowStyle Hidden -PassThru
$process.Id | Set-Content -LiteralPath $pidFile -NoNewline
$process.Id
