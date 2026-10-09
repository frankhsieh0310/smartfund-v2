$ErrorActionPreference = "Stop"
$workspace = (Resolve-Path (Join-Path $PSScriptRoot "..\..\..")).Path
$runtime = Join-Path $workspace "runtime\fx\derived-cross-rates"
New-Item -ItemType Directory -Force -Path $runtime | Out-Null
$line = Get-Content -LiteralPath (Join-Path $workspace ".env") | Where-Object { $_ -match '^DATABASE_URL=' } | Select-Object -First 1
if (-not $line) { throw "DATABASE_URL_REQUIRED_FOR_FX_CROSS_RATE" }
$builder = [System.UriBuilder]::new($line.Substring("DATABASE_URL=".Length).Trim().Trim('"').Trim("'"))
if ($builder.Port -ne 6543) { throw "FX_CROSS_RATE_REQUIRES_TRANSACTION_POOLING_6543" }
$parts = @($builder.Query.TrimStart('?').Split('&',[System.StringSplitOptions]::RemoveEmptyEntries) | Where-Object { $_ -notmatch '^(connection_limit|pgbouncer)=' })
$builder.Query = (@($parts)+"pgbouncer=true"+"connection_limit=1") -join '&'
$env:DATABASE_URL = $builder.Uri.AbsoluteUri
$node = (Get-Command node.exe -ErrorAction Stop).Source
$process = Start-Process -FilePath $node -ArgumentList @("--experimental-strip-types","--env-file=.env","scripts/data/fx/run-derived-cross-rates.ts","--background") -WorkingDirectory $workspace -RedirectStandardOutput (Join-Path $runtime "worker.stdout.log") -RedirectStandardError (Join-Path $runtime "worker.stderr.log") -WindowStyle Hidden -PassThru
$process.Id | Set-Content -LiteralPath (Join-Path $runtime "worker.pid") -Encoding ascii
[pscustomobject]@{PID=$process.Id;Alive=-not $process.HasExited;Runtime=$runtime}
