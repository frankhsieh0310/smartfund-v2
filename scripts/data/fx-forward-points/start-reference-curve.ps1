$ErrorActionPreference = 'Stop'
$workspace = (Resolve-Path (Join-Path $PSScriptRoot '..\..\..')).Path
$runtime = Join-Path $workspace 'runtime\fx-forward-points\reference-curve'
New-Item -ItemType Directory -Force -Path $runtime | Out-Null
$lock = Join-Path $runtime 'writer.lock'
if (Test-Path -LiteralPath $lock) { exit 0 }
$process = Start-Process -FilePath 'node.exe' -ArgumentList '--experimental-strip-types','--env-file=.env','scripts/data/fx-forward-points/materialize-reference-curve.ts' -WorkingDirectory $workspace -WindowStyle Hidden -RedirectStandardOutput (Join-Path $runtime 'worker.stdout.log') -RedirectStandardError (Join-Path $runtime 'worker.stderr.log') -PassThru
$process.Id | Set-Content -LiteralPath (Join-Path $runtime 'worker.pid') -Encoding ascii
$process.Id
