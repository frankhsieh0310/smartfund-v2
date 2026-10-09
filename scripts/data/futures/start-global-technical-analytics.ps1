$ErrorActionPreference = 'Stop'
$root = (Resolve-Path (Join-Path $PSScriptRoot '..\..\..')).Path
$runtime = Join-Path $root 'runtime\futures-global-technical'
New-Item -ItemType Directory -Force -Path $runtime | Out-Null
$existing = Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -like '*run-global-technical-analytics.ts*' -and $_.ProcessId -ne $PID }
if ($existing) { Write-Output "ALREADY_RUNNING PID=$($existing[0].ProcessId)"; exit 0 }
$stdout = Join-Path $runtime 'worker.stdout.log'
$stderr = Join-Path $runtime 'worker.stderr.log'
$p = Start-Process -FilePath 'node' -ArgumentList '--env-file=.env','--experimental-strip-types','scripts/data/futures/run-global-technical-analytics.ts' -WorkingDirectory $root -RedirectStandardOutput $stdout -RedirectStandardError $stderr -WindowStyle Hidden -PassThru
Write-Output "STARTED PID=$($p.Id)"
