$ErrorActionPreference = "Stop"

# Windows can retain both Path and PATH after a forced reboot. PowerShell's
# Start-Process rejects that duplicate environment key before spawning a child.
$processPath = [Environment]::GetEnvironmentVariable("Path", "Process")
[Environment]::SetEnvironmentVariable("PATH", $null, "Process")
[Environment]::SetEnvironmentVariable("Path", $processPath, "Process")

$projectRoot = (Resolve-Path (Join-Path $PSScriptRoot "..\..\..")).Path
$runtimeRoot = Join-Path $projectRoot "runtime\bond\desktop-supervisor"
$queueRuntime = Join-Path $projectRoot "runtime\bond\global-individual-bond-queue"
$incrementalRuntime = Join-Path $projectRoot "runtime\bond\incremental"
$professionalRuntime = Join-Path $projectRoot "runtime\bond\professional-depth"
$healthPath = Join-Path $runtimeRoot "health.json"
$logPath = Join-Path $runtimeRoot "runner.log"
$errorLogPath = Join-Path $runtimeRoot "runner.error.log"
$usTreasuryLatestPath = Join-Path $projectRoot "scripts\data\bond\run-production-us-treasury-latest.ts"
$usTreasuryLatestLogPath = Join-Path $runtimeRoot "us-treasury-latest.log"
$usTreasuryLatestErrorPath = Join-Path $runtimeRoot "us-treasury-latest.error.log"
$supervisorPidPath = Join-Path $runtimeRoot "supervisor.pid"
$restartDelaySeconds = 900
$railwayExcludedScopes = @("TAIWAN_GOVERNMENT", "FINLAND_GOVERNMENT")
$writeSequence = 0

New-Item -ItemType Directory -Force -Path $runtimeRoot | Out-Null
if (Test-Path -LiteralPath $supervisorPidPath) {
  $existingPid = 0
  try { $existingPid = [int](Get-Content -Raw -LiteralPath $supervisorPidPath) } catch {}
  if ($existingPid -and (Get-Process -Id $existingPid -ErrorAction SilentlyContinue)) {
    throw "GLOBAL_BOND_DESKTOP_SUPERVISOR_ALREADY_RUNNING:$existingPid"
  }
}
Set-Content -LiteralPath $supervisorPidPath -Value $PID

function Read-JsonFile($path) {
  if (-not (Test-Path -LiteralPath $path)) { return $null }
  try { return Get-Content -Raw -LiteralPath $path | ConvertFrom-Json } catch { return $null }
}

function Write-Health($childPid, $childAlive, $status, $lastExitCode) {
  $checkpoint = Read-JsonFile (Join-Path $queueRuntime "checkpoint.json")
  $incrementalCheckpoint = Read-JsonFile (Join-Path $incrementalRuntime "checkpoint.json")
  $professionalCheckpoint = Read-JsonFile (Join-Path $professionalRuntime "checkpoint.json")
  $heartbeat = Read-JsonFile (Join-Path $queueRuntime "heartbeat.json")
  $complete = $checkpoint.key -eq "FIRST_PASS_COMPLETE"
  $health = [ordered]@{
    owner = "DESKTOP"
    supervisorPid = $PID
    desktopPid = $childPid
    desktopProcessAlive = $childAlive
    lastHeartbeat = $heartbeat.HEARTBEAT_TIME
    lastCheckpoint = $checkpoint.updatedAt
    currentScope = if ($complete -and $incrementalCheckpoint) { $incrementalCheckpoint.scope } else { $checkpoint.key }
    completedScopes = if ($complete) { 64 } else { $null }
    remainingScopes = if ($complete) { 0 } else { $null }
    railwayExcludedScopes = $railwayExcludedScopes
    railwayScopeDispatchCount = 0
    latestPath = $true
    incremental = $true
    professionalDepthStatus = if ($professionalCheckpoint) { $professionalCheckpoint.status } else { "READY" }
    verifiedBondLinks = if ($professionalCheckpoint) { $professionalCheckpoint.processed } else { 0 }
    unresolvedBondLinks = if ($professionalCheckpoint) { $professionalCheckpoint.remaining } else { $null }
    scheduler = "ACTIVE"
    autoContinuing = $true
    restartDelaySeconds = $restartDelaySeconds
    lastExitCode = $lastExitCode
    status = $status
    updatedAt = [DateTime]::UtcNow.ToString("o")
  }
  $script:writeSequence++
  $temporary = "$healthPath.$PID.$([DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()).$($script:writeSequence).tmp"
  $health | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath $temporary
  $lastWriteError = $null
  for ($attempt = 0; $attempt -lt 6; $attempt++) {
    try {
      Move-Item -Force -LiteralPath $temporary -Destination $healthPath
      $lastWriteError = $null
      break
    } catch {
      $lastWriteError = $_
      if ($_.Exception.Message -notmatch "EPERM|EACCES|EBUSY|being used by another process|Access.*denied") { throw }
      Start-Sleep -Milliseconds (25 * ($attempt + 1))
    }
  }
  try {
    & node --experimental-strip-types "scripts/data/runtime-status/publish-fixed-income-runtime-status.ts" 2>> $errorLogPath
  } catch {
    try { Add-Content -LiteralPath $errorLogPath -Value "runtime-status publish failed: $($_.Exception.Message)" } catch {}
  }
}

try {
  while ($true) {
    $usTreasuryLatest = Start-Process -FilePath "node" `
      -ArgumentList @("--experimental-strip-types", "--env-file=.env", $usTreasuryLatestPath) `
      -WorkingDirectory $projectRoot `
      -RedirectStandardOutput $usTreasuryLatestLogPath `
      -RedirectStandardError $usTreasuryLatestErrorPath `
      -WindowStyle Hidden `
      -PassThru
    $usTreasuryLatest.WaitForExit()
    if ($usTreasuryLatest.ExitCode -ne 0) {
      Add-Content -LiteralPath $errorLogPath -Value "$([DateTime]::UtcNow.ToString('o')) US_TREASURY_LATEST_EXIT_$($usTreasuryLatest.ExitCode)"
    }
    $checkpoint = Read-JsonFile (Join-Path $queueRuntime "checkpoint.json")
    $firstPassComplete = $checkpoint.key -eq "FIRST_PASS_COMPLETE"
    $professionalCheckpoint = Read-JsonFile (Join-Path $professionalRuntime "checkpoint.json")
    $professionalComplete = $professionalCheckpoint.status -eq "COMPLETE"
    $arguments = if ($firstPassComplete -and -not $professionalComplete) {
      @("--env-file=.env", "scripts/data/bond/run-bond-professional-depth-recovery.cjs", "--resume", "--limit=100")
    } elseif ($firstPassComplete) {
      @("--experimental-strip-types", "--env-file=.env", "scripts/data/bond/run-global-bond-latest.ts", "--incremental", "--limit=2")
    } else {
      @("--experimental-strip-types", "--env-file=.env", "scripts/data/bond/run-global-individual-bond-queue.ts", "--resume")
    }
    $child = Start-Process -FilePath "node" -ArgumentList $arguments -WorkingDirectory $projectRoot -RedirectStandardOutput $logPath -RedirectStandardError $errorLogPath -WindowStyle Hidden -PassThru
    Write-Health $child.Id $true $(if ($firstPassComplete -and -not $professionalComplete) { "PROFESSIONAL_DEPTH_RUNNING" } elseif ($firstPassComplete) { "INCREMENTAL_RUNNING" } else { "CATCHING_UP" }) $null
    $child.WaitForExit()
    $child.Refresh()
    $exitCode = if ($null -eq $child.ExitCode) { 0 } else { $child.ExitCode }
    $status = if ($exitCode -eq 0) { "HEALTHY_WAITING" } else { "RETRY_WAITING" }
    Write-Health $null $false $status $exitCode
    Start-Sleep -Seconds $restartDelaySeconds
  }
} catch {
  try {
    Add-Content -LiteralPath $errorLogPath -Value "$([DateTime]::UtcNow.ToString('o')) SUPERVISOR_FATAL $($_.Exception.GetType().FullName): $($_.Exception.Message)`n$($_.ScriptStackTrace)"
  } catch {}
  throw
} finally {
  Write-Health $null $false "STOPPED" $null
  Remove-Item -LiteralPath $supervisorPidPath -ErrorAction SilentlyContinue
}
