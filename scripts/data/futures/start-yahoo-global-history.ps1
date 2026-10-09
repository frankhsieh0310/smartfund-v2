$ErrorActionPreference = "Stop"
$projectRoot = (Resolve-Path (Join-Path $PSScriptRoot "..\..\..")).Path
$needle = "run-yahoo-full-universe.ts"
$existing = Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -like "*$needle*" -and $_.ProcessId -ne $PID }
if ($existing) { Write-Output ("ALREADY_RUNNING PID=" + ($existing.ProcessId -join ",")); exit 0 }
$logDir = Join-Path $projectRoot "runtime\futures-yahoo-global-history"; New-Item -ItemType Directory -Force -Path $logDir | Out-Null
$process = Start-Process -FilePath (Get-Command node).Source -ArgumentList @("--env-file=.env","--experimental-strip-types","scripts/data/futures/run-yahoo-full-universe.ts") -WorkingDirectory $projectRoot -WindowStyle Hidden -RedirectStandardOutput (Join-Path $logDir "worker.log") -RedirectStandardError (Join-Path $logDir "worker.error.log") -PassThru
Write-Output ("STARTED PID=" + $process.Id)
