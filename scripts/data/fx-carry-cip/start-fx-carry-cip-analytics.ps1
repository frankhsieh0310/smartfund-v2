$ErrorActionPreference = 'Stop'
$root = (Resolve-Path (Join-Path $PSScriptRoot '..\..\..')).Path
$runtime = Join-Path $root 'runtime\fx-carry-cip'
New-Item -ItemType Directory -Force -Path $runtime | Out-Null
$process = Start-Process -FilePath 'node' -ArgumentList '--experimental-strip-types','--env-file=.env','scripts/data/fx-carry-cip/run-fx-carry-cip-analytics.ts','--supervisor' -WorkingDirectory $root -WindowStyle Hidden -RedirectStandardOutput (Join-Path $runtime 'supervisor.log') -RedirectStandardError (Join-Path $runtime 'supervisor.error.log') -PassThru
Set-Content -LiteralPath (Join-Path $runtime 'supervisor.pid') -Value $process.Id
$process.Id
