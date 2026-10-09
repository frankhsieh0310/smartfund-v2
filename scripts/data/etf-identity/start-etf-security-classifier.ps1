$ErrorActionPreference = 'Stop'
$root = (Resolve-Path (Join-Path $PSScriptRoot '..\..\..')).Path
$runtime = Join-Path $root 'runtime\etf-security-classifier'
New-Item -ItemType Directory -Force -Path $runtime | Out-Null
$stdout = Join-Path $runtime 'worker.stdout.log'
$stderr = Join-Path $runtime 'worker.stderr.log'
$process = Start-Process -FilePath 'node' -ArgumentList @('--experimental-strip-types','--env-file=.env','scripts/data/etf-identity/classify-etf-security-candidates.ts','--continuous') -WorkingDirectory $root -WindowStyle Hidden -RedirectStandardOutput $stdout -RedirectStandardError $stderr -PassThru
Set-Content -LiteralPath (Join-Path $runtime 'process.json') -Value (@{ processId=$process.Id; startedAt=(Get-Date).ToUniversalTime().ToString('o'); state='AUTO_CONTINUING' } | ConvertTo-Json)
$process.Id
