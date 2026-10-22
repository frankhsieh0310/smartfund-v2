$ErrorActionPreference='Stop'
$workspace=(Resolve-Path (Join-Path $PSScriptRoot '..\..\..')).Path
$runtime=Join-Path $workspace 'runtime\stock-advanced-analytics'
New-Item -ItemType Directory -Path $runtime -Force|Out-Null
$pidFile=Join-Path $runtime 'supervisor.pid'
if(Test-Path $pidFile){try{$existing=Get-Content $pidFile -Raw|ConvertFrom-Json;$p=Get-Process -Id ([int]$existing.pid) -ErrorAction SilentlyContinue;if($p){$p.Id;exit 0}}catch{}}
$node=(Get-Command node).Source
$p=Start-Process -FilePath $node -ArgumentList @('--experimental-strip-types','--env-file=.env','scripts/data/technical/run-stock-advanced-analytics-supervisor.ts') -WorkingDirectory $workspace -WindowStyle Hidden -RedirectStandardOutput (Join-Path $runtime 'supervisor.stdout.log') -RedirectStandardError (Join-Path $runtime 'supervisor.stderr.log') -PassThru
Start-Sleep -Seconds 2
if(-not(Get-Process -Id $p.Id -ErrorAction SilentlyContinue)){throw 'STOCK_ADVANCED_ANALYTICS supervisor exited during startup'}
$p.Id
