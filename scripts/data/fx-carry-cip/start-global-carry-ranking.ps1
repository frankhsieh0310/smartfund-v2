$ErrorActionPreference='Stop'
$workspace=(Resolve-Path (Join-Path $PSScriptRoot '..\..\..')).Path
$runtime=Join-Path $workspace 'runtime\fx-carry-ranking'
New-Item -ItemType Directory -Force -Path $runtime|Out-Null
if(Test-Path (Join-Path $runtime 'writer.lock')){exit 0}
$p=Start-Process -FilePath 'node.exe' -ArgumentList '--experimental-strip-types','--env-file=.env','scripts/data/fx-carry-cip/materialize-global-carry-ranking.ts' -WorkingDirectory $workspace -WindowStyle Hidden -RedirectStandardOutput (Join-Path $runtime 'worker.stdout.log') -RedirectStandardError (Join-Path $runtime 'worker.stderr.log') -PassThru
$p.Id|Set-Content -LiteralPath (Join-Path $runtime 'worker.pid') -Encoding ascii
$p.Id
