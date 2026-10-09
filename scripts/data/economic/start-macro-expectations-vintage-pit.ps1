$ErrorActionPreference = 'Stop'
$root = (Resolve-Path (Join-Path $PSScriptRoot '..\..\..')).Path
$runtime = Join-Path $root 'runtime\macro-expectations-vintage-pit'
$pidFile = Join-Path $runtime 'worker.pid'
New-Item -ItemType Directory -Force -Path $runtime | Out-Null
if (Test-Path -LiteralPath $pidFile) {
  $workerPid = 0
  [void][int]::TryParse((Get-Content -Raw -LiteralPath $pidFile).Trim(), [ref]$workerPid)
  if ($workerPid -gt 0 -and (Get-Process -Id $workerPid -ErrorAction SilentlyContinue)) { $workerPid; exit 0 }
}
$runner = Join-Path $PSScriptRoot 'run-macro-expectations-vintage-pit.ts'
$stdout = Join-Path $runtime 'worker.stdout.log'
$stderr = Join-Path $runtime 'worker.stderr.log'
$process = Start-Process -FilePath 'node' -ArgumentList '--env-file=.env','--experimental-strip-types',$runner -WorkingDirectory $root -RedirectStandardOutput $stdout -RedirectStandardError $stderr -WindowStyle Hidden -PassThru
$process.Id | Set-Content -LiteralPath $pidFile -NoNewline
$process.Id
