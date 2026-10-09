$ErrorActionPreference = 'Stop'
$projectRoot = (Resolve-Path (Join-Path $PSScriptRoot '..\..\..')).Path
$runtime = Join-Path $projectRoot 'runtime\commodity-futures\yahoo-history'
New-Item -ItemType Directory -Force -Path $runtime | Out-Null
$lock = Join-Path $runtime 'single-writer.lock'
if (Test-Path -LiteralPath $lock) {
  $owner = Get-Content -Raw -LiteralPath $lock | ConvertFrom-Json
  if (Get-Process -Id $owner.pid -ErrorAction SilentlyContinue) { $owner.pid; exit 0 }
  Remove-Item -LiteralPath $lock -Force
}
$stdout = Join-Path $runtime 'worker.stdout.log'
$stderr = Join-Path $runtime 'worker.stderr.log'
$process = Start-Process -FilePath 'node' -ArgumentList @('--env-file=.env','--experimental-strip-types','scripts/data/commodity-futures/run-yahoo-full-history.ts') -WorkingDirectory $projectRoot -WindowStyle Hidden -RedirectStandardOutput $stdout -RedirectStandardError $stderr -PassThru
$process.Id
