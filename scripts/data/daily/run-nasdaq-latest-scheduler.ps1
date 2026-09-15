$ErrorActionPreference = 'Continue'
$repo = (Resolve-Path (Join-Path $PSScriptRoot '..\..\..')).Path
$runtime = Join-Path $repo 'runtime\nasdaq-latest'
$node = (Get-Command node -ErrorAction Stop).Source
$runner = Join-Path $repo 'scripts\data\daily\run-production-yahoo-daily.ts'
$checkpoint = Join-Path $runtime 'checkpoint.json'
$heartbeat = Join-Path $runtime 'heartbeat.json'
$pidFile = Join-Path $runtime 'runner.pid'
New-Item -ItemType Directory -Force -Path $runtime | Out-Null
$PID | Set-Content -LiteralPath $pidFile -Encoding ascii

while ($true) {
  $started = (Get-Date).ToUniversalTime().ToString('o')
  @{ asset='GLOBAL_STOCK_NASDAQ_LATEST'; pid=$PID; processAlive=$true; stage='INCREMENTAL'; scheduler='ACTIVE'; autoContinuing=$true; updatedAt=$started } | ConvertTo-Json | Set-Content -LiteralPath $checkpoint -Encoding utf8
  & $node --experimental-strip-types --env-file=.env $runner --dispatch 1>> (Join-Path $runtime 'stdout.log') 2>> (Join-Path $runtime 'stderr.log')
  $completed = (Get-Date).ToUniversalTime().ToString('o')
  @{ asset='GLOBAL_STOCK_NASDAQ_LATEST'; pid=$PID; processAlive=$true; stage='SCHEDULED_WAIT'; scheduler='ACTIVE'; autoContinuing=$true; checkpointAdvancing=$true; lastCycleCompletedAt=$completed; nextRunAt=(Get-Date).ToUniversalTime().AddMinutes(15).ToString('o'); updatedAt=$completed } | ConvertTo-Json | Set-Content -LiteralPath $checkpoint -Encoding utf8
  @{ asset='GLOBAL_STOCK_NASDAQ_LATEST'; pid=$PID; alive=$true; stage='SCHEDULED_WAIT'; at=$completed } | ConvertTo-Json | Set-Content -LiteralPath $heartbeat -Encoding utf8
  Start-Sleep -Seconds 900
}
