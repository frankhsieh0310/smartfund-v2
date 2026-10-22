$ErrorActionPreference = 'Continue'
$repo = (Resolve-Path (Join-Path $PSScriptRoot '..\..\..')).Path
$runtime = Join-Path $repo 'runtime\global-etf'
$node = (Get-Command node -ErrorAction Stop).Source
$runner = Join-Path $repo 'scripts\data\global-etf\run-global-etf-latest.ts'
$pidFile = Join-Path $runtime 'supervisor.pid'
$heartbeat = Join-Path $runtime 'heartbeat.json'
New-Item -ItemType Directory -Force -Path $runtime | Out-Null
$PID | Set-Content -LiteralPath $pidFile -Encoding ascii

while ($true) {
  & $node --experimental-strip-types --env-file=.env $runner 1>> (Join-Path $runtime 'stdout.log') 2>> (Join-Path $runtime 'stderr.log')
  $now = (Get-Date).ToUniversalTime()
  @{ asset='GLOBAL_ETF'; pid=$PID; processAlive=$true; stage='WAITING_FOR_NEXT_UPDATE'; latestPath=$true; incremental=$true; scheduler='ACTIVE'; autoContinuing=$true; nextRunAt=$now.AddHours(6).ToString('o'); at=$now.ToString('o') } | ConvertTo-Json | Set-Content -LiteralPath $heartbeat -Encoding utf8
  Start-Sleep -Seconds 21600
}
