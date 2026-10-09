$ErrorActionPreference = "Stop"
$repo = Resolve-Path (Join-Path $PSScriptRoot "..\..\..")
$runtime = Join-Path $repo "runtime\mortgage-rates"
New-Item -ItemType Directory -Force -Path $runtime | Out-Null
$stdout = Join-Path $runtime "supervisor.out.log"
$stderr = Join-Path $runtime "supervisor.err.log"
$process = Start-Process -FilePath "node" -ArgumentList "--experimental-strip-types", "--env-file=.env", "scripts/data/mortgage-rates/run-mortgage-rates.ts" -WorkingDirectory $repo -RedirectStandardOutput $stdout -RedirectStandardError $stderr -WindowStyle Hidden -PassThru
$process.Id | Set-Content -Encoding ascii (Join-Path $runtime "supervisor.pid")
$process.Id
