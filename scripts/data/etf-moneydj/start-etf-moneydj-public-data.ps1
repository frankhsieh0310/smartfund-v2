$ErrorActionPreference='Stop'
$root=(Resolve-Path (Join-Path $PSScriptRoot '..\..\..')).Path
$runtime=Join-Path $root 'runtime\etf-moneydj-public-data'
New-Item -ItemType Directory -Force -Path $runtime | Out-Null
$pidFile=Join-Path $runtime 'worker.pid'
if(Test-Path $pidFile){$existing=[int](Get-Content $pidFile -Raw).Trim();if(Get-Process -Id $existing -ErrorAction SilentlyContinue){Write-Output $existing;exit 0}}
$stdout=Join-Path $runtime 'stdout.log';$stderr=Join-Path $runtime 'stderr.log'
$process=Start-Process -FilePath 'node' -ArgumentList '--experimental-strip-types','--env-file=.env','scripts/data/etf-moneydj/run-etf-moneydj-public-data.ts','--continuous' -WorkingDirectory $root -RedirectStandardOutput $stdout -RedirectStandardError $stderr -WindowStyle Hidden -PassThru
Set-Content -LiteralPath $pidFile -Value $process.Id -NoNewline
Write-Output $process.Id
