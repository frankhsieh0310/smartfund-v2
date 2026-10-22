$ErrorActionPreference='Stop'
$root=(Resolve-Path (Join-Path $PSScriptRoot '..\..\..')).Path
$runtime=Join-Path $root 'runtime\etf-public-flow'
New-Item -ItemType Directory -Force -Path $runtime | Out-Null
$process=Start-Process -FilePath 'node' -ArgumentList @('--experimental-strip-types','--env-file=.env','scripts/data/etf-identity/run-etf-public-reported-flow.ts','--continuous') -WorkingDirectory $root -WindowStyle Hidden -RedirectStandardOutput (Join-Path $runtime 'worker.stdout.log') -RedirectStandardError (Join-Path $runtime 'worker.stderr.log') -PassThru
Set-Content -LiteralPath (Join-Path $runtime 'process.json') -Value (@{processId=$process.Id;startedAt=(Get-Date).ToUniversalTime().ToString('o');state='AUTO_CONTINUING'}|ConvertTo-Json)
$process.Id
