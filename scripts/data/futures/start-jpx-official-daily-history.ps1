$ErrorActionPreference = "Stop"
$projectRoot = (Resolve-Path (Join-Path $PSScriptRoot "..\..\..")).Path
$needle = "run-jpx-official-daily-history.ts"
$existing = Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -like "*$needle*" -and $_.ProcessId -ne $PID }
if ($existing) { Write-Output ("ALREADY_RUNNING PID=" + ($existing.ProcessId -join ",")); exit 0 }
$logDir = Join-Path $projectRoot "runtime\futures-market-data-expansion"
New-Item -ItemType Directory -Force -Path $logDir | Out-Null
$node = (Get-Command node).Source
$arguments = @("--env-file=.env", "--experimental-strip-types", "scripts/data/futures/run-jpx-official-daily-history.ts")
$process = Start-Process -FilePath $node -ArgumentList $arguments -WorkingDirectory $projectRoot -WindowStyle Hidden -RedirectStandardOutput (Join-Path $logDir "jpx-daily-history-worker.log") -RedirectStandardError (Join-Path $logDir "jpx-daily-history-worker.error.log") -PassThru
Write-Output ("STARTED PID=" + $process.Id)
