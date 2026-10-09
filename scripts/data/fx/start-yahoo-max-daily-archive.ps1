$ErrorActionPreference = "Stop"
$workspace = (Resolve-Path (Join-Path $PSScriptRoot "..\..\..")).Path
$runtime = Join-Path $workspace "runtime\fx\yahoo-max-daily"
New-Item -ItemType Directory -Force -Path $runtime | Out-Null
$process = Start-Process -FilePath (Get-Command node.exe -ErrorAction Stop).Source -ArgumentList @("--experimental-strip-types","--env-file=.env","scripts/data/fx/run-yahoo-max-daily-archive.ts") -WorkingDirectory $workspace -RedirectStandardOutput (Join-Path $runtime "stdout.log") -RedirectStandardError (Join-Path $runtime "stderr.log") -WindowStyle Hidden -PassThru
$process.Id | Set-Content -LiteralPath (Join-Path $runtime "launcher.pid") -Encoding ascii
[pscustomobject]@{PID=$process.Id;Alive=(-not $process.HasExited);Checkpoint=(Join-Path $runtime "checkpoint.json")}
