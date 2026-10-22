param(
  [int]$HealthyDelaySeconds = 30,
  [int]$MaxBackoffSeconds = 900
)

$ErrorActionPreference = 'Continue'
$workspace = (Resolve-Path (Join-Path $PSScriptRoot '..\..\..')).Path
$runtime = Join-Path $workspace 'runtime\crypto'
$archive = Join-Path $runtime 'archive'
$log = Join-Path $runtime 'crypto-standalone.log'
$heartbeat = Join-Path $runtime 'heartbeat.json'
$manifest = Join-Path $runtime 'completion-manifest.json'
$pidFile = Join-Path $runtime 'standalone.pid'

New-Item -ItemType Directory -Force -Path $archive | Out-Null
Set-Content -LiteralPath $pidFile -Value $PID -Encoding ascii
$failures = 0

while ($true) {
  $started = [DateTime]::UtcNow
  $stamp = $started.ToString('yyyyMMdd-HHmmss')
  $cycleArchive = Join-Path $archive ("cycle-{0}.jsonl" -f $stamp)
  $state = [ordered]@{
    pid = $PID
    status = 'RUNNING'
    stage = 'BOOTSTRAP_ENQUEUE_BACKFILL_VALIDATE'
    startedAt = $started.ToString('o')
    heartbeatAt = $started.ToString('o')
    failures = $failures
    archive = $cycleArchive
  }
  $state | ConvertTo-Json | Set-Content -LiteralPath $heartbeat -Encoding utf8
  & node --experimental-strip-types scripts/data/crypto/publish-runtime-status.ts --state=RUNNING 2>&1 | Add-Content -LiteralPath $log

  Push-Location $workspace
  try {
    $exitCode = 0
    foreach ($step in @('--enqueue', '--work', '--complete-p0', '--validate')) {
      & node --experimental-strip-types --env-file=.env scripts/data/crypto/run-global-crypto.ts $step 2>&1 |
        Tee-Object -FilePath $cycleArchive -Append |
        Add-Content -LiteralPath $log
      $stepExitCode = $LASTEXITCODE
      if ($stepExitCode -ne 0) {
        $exitCode = $stepExitCode
        break
      }
    }
  } catch {
    $_ | Out-String | Add-Content -LiteralPath $log
    $exitCode = 1
  } finally {
    Pop-Location
  }

  $finished = [DateTime]::UtcNow
  if ($exitCode -eq 0) {
    $failures = 0
    $delay = $HealthyDelaySeconds
    $status = 'AUTO_CONTINUING'
  } else {
    $failures++
    $delay = [Math]::Min($MaxBackoffSeconds, [Math]::Max(30, [Math]::Pow(2, [Math]::Min($failures, 9)) * 15))
    $status = 'RETRY_PENDING'
  }
  [ordered]@{
    asset = 'GLOBAL_CRYPTO'
    pid = $PID
    status = $status
    stage = 'HISTORICAL_INCREMENTAL'
    lastCycleStartedAt = $started.ToString('o')
    lastCycleFinishedAt = $finished.ToString('o')
    lastExitCode = $exitCode
    consecutiveFailures = $failures
    nextRunAt = $finished.AddSeconds($delay).ToString('o')
    archive = $cycleArchive
    log = $log
  } | ConvertTo-Json | Set-Content -LiteralPath $manifest -Encoding utf8
  [ordered]@{ pid=$PID; status=$status; stage='BACKOFF'; heartbeatAt=$finished.ToString('o'); nextRunAt=$finished.AddSeconds($delay).ToString('o') } |
    ConvertTo-Json | Set-Content -LiteralPath $heartbeat -Encoding utf8
  & node --experimental-strip-types scripts/data/crypto/publish-runtime-status.ts --state=SCHEDULED_WAIT 2>&1 | Add-Content -LiteralPath $log
  Start-Sleep -Seconds $delay
}
