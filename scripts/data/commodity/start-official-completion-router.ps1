$ErrorActionPreference = "Stop"
$root = (Resolve-Path (Join-Path $PSScriptRoot "..\..\..")).Path
$runtime = Join-Path $root "runtime\commodity\official-completion"
New-Item -ItemType Directory -Force -Path $runtime | Out-Null
$lock = Join-Path $runtime "single-writer.lock"
if (Test-Path $lock) { $existing = Get-Content $lock -Raw | ConvertFrom-Json; if (Get-Process -Id $existing.pid -ErrorAction SilentlyContinue) { Write-Output $existing.pid; exit 0 } else { Remove-Item -LiteralPath $lock -Force } }
$process = Start-Process -FilePath "node" -ArgumentList @("--experimental-strip-types","--env-file=.env","scripts/data/commodity/run-official-completion-router.ts") -WorkingDirectory $root -WindowStyle Hidden -RedirectStandardOutput (Join-Path $runtime "worker.stdout.log") -RedirectStandardError (Join-Path $runtime "worker.stderr.log") -PassThru
Write-Output $process.Id
