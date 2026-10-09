$ErrorActionPreference='Stop'
$repo=(Resolve-Path (Join-Path $PSScriptRoot '..\..\..')).Path
$runtime=Join-Path $repo 'runtime\etf-identity-routing'; New-Item -ItemType Directory -Force -Path $runtime | Out-Null
$pidFile=Join-Path $runtime 'worker.pid'
if(Test-Path $pidFile){$old=[int](Get-Content $pidFile -Raw);if(Get-Process -Id $old -ErrorAction SilentlyContinue){Write-Output $old;exit 0}}
$p=Start-Process -FilePath (Get-Command node).Source -ArgumentList @('--experimental-strip-types','--env-file=.env',(Join-Path $repo 'scripts\data\etf-identity-routing\run-etf-regulatory-identity-routing.ts'),'--continuous') -WorkingDirectory $repo -WindowStyle Hidden -PassThru
Set-Content -LiteralPath $pidFile -Value $p.Id -Encoding ascii; Start-Sleep -Seconds 2
if(-not(Get-Process -Id $p.Id -ErrorAction SilentlyContinue)){throw 'ETF identity router exited during startup'}
Write-Output $p.Id
