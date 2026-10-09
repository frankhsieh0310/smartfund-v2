$ErrorActionPreference='Stop'
$workspace=(Resolve-Path (Join-Path $PSScriptRoot '..\..\..')).Path
$runtime=Join-Path $workspace 'runtime\global-stock-technical-quant'
New-Item -ItemType Directory -Path $runtime -Force | Out-Null
$pidFile=Join-Path $runtime 'supervisor.pid'
if(Test-Path -LiteralPath $pidFile){
  try{$existing=Get-Content -LiteralPath $pidFile -Raw|ConvertFrom-Json;$process=Get-Process -Id ([int]$existing.pid) -ErrorAction SilentlyContinue;if($process){$process.Id;exit 0}}catch{}
}
$node=(Get-Command node).Source
$stdout=Join-Path $runtime 'supervisor.stdout.log'
$stderr=Join-Path $runtime 'supervisor.stderr.log'
$process=Start-Process -FilePath $node -ArgumentList @('--experimental-strip-types','--env-file=.env','scripts/data/technical/run-global-stock-technical-supervisor.ts') -WorkingDirectory $workspace -WindowStyle Hidden -RedirectStandardOutput $stdout -RedirectStandardError $stderr -PassThru
Start-Sleep -Seconds 2
if(-not (Get-Process -Id $process.Id -ErrorAction SilentlyContinue)){throw 'GLOBAL_STOCK_TECHNICAL_QUANT supervisor exited during startup'}
$process.Id
