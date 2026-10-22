$ErrorActionPreference='Stop'
$repo=(Resolve-Path (Join-Path $PSScriptRoot '..\..\..')).Path
$runtime=Join-Path $repo 'runtime\etf-product-expansion'
$pidFile=Join-Path $runtime 'worker.pid'
New-Item -ItemType Directory -Force -Path $runtime | Out-Null
if(Test-Path -LiteralPath $pidFile){$existingPid=[int](Get-Content -LiteralPath $pidFile -Raw);$existing=Get-Process -Id $existingPid -ErrorAction SilentlyContinue;if($existing -and $existing.ProcessName -eq 'node'){Write-Output $existingPid;exit 0}}
$node=(Get-Command node -ErrorAction Stop).Source
$script=Join-Path $repo 'scripts\data\etf-product-expansion\run-full-universe-product-expansion.ts'
$process=Start-Process -FilePath $node -ArgumentList @('--experimental-strip-types','--env-file=.env',$script,'--continuous') -WorkingDirectory $repo -WindowStyle Hidden -PassThru
Set-Content -LiteralPath $pidFile -Value $process.Id -Encoding ascii
Start-Sleep -Seconds 2
if(-not(Get-Process -Id $process.Id -ErrorAction SilentlyContinue)){throw 'ETF product expansion worker exited during startup'}
Write-Output $process.Id
