param(
  [int]$HeartbeatSeconds = 30
)

$ErrorActionPreference = "Stop"
$processPath = [Environment]::GetEnvironmentVariable("Path", "Process")
[Environment]::SetEnvironmentVariable("PATH", $null, "Process")
[Environment]::SetEnvironmentVariable("Path", $processPath, "Process")
$projectRoot = (Resolve-Path (Join-Path $PSScriptRoot "..\..\..")).Path
$runtimeRoot = Join-Path $projectRoot "runtime\government-yield"
$supervisorRoot = Join-Path $runtimeRoot "desktop-supervisor"
$healthPath = Join-Path $supervisorRoot "health.json"
$stopPath = Join-Path $supervisorRoot "stop.requested"
$checkpointPath = Join-Path $runtimeRoot "dataset-completion\checkpoint.json"
$runnerPath = Join-Path $projectRoot "scripts\data\government-yield\run-dataset-completion.ts"
$stdoutPath = Join-Path $supervisorRoot "runner.stdout.log"
$stderrPath = Join-Path $supervisorRoot "runner.stderr.log"
$latestStdoutPath = Join-Path $supervisorRoot "latest.stdout.log"
$latestStderrPath = Join-Path $supervisorRoot "latest.stderr.log"
$latestRunnerPath = Join-Path $projectRoot "scripts\data\government-yield\run-government-yield-latest.ts"
$incrementalCheckpointPath = Join-Path $runtimeRoot "incremental\checkpoint.json"

New-Item -ItemType Directory -Path $supervisorRoot -Force | Out-Null
$env:GOVERNMENT_YIELD_RUNTIME_ROOT = $runtimeRoot

function Read-Checkpoint {
  if (-not (Test-Path -LiteralPath $checkpointPath)) { return $null }
  return Get-Content -Raw -LiteralPath $checkpointPath | ConvertFrom-Json
}

function Write-Health([System.Diagnostics.Process]$runner, [System.Diagnostics.Process]$latestRunner, [string]$status) {
  $checkpoint = Read-Checkpoint
  $runnerAlive = $null -ne $runner -and -not $runner.HasExited
  $incrementalCheckpoint = $null
  if (Test-Path -LiteralPath $incrementalCheckpointPath) { $incrementalCheckpoint = Get-Content -Raw -LiteralPath $incrementalCheckpointPath | ConvertFrom-Json }
  $scopeStates = @($incrementalCheckpoint.scopes.PSObject.Properties | ForEach-Object { $_.Value })
  if (@($scopeStates | Where-Object { $_.status -like "FAILED*" }).Count -gt 0) { $status = "CATCHING_UP" }
  elseif ($scopeStates.Count -gt 0 -and @($scopeStates | Where-Object { $_.action -notin @("SKIP_CURRENT", "NO_OP_CURRENT") }).Count -eq 0) { $status = "HEALTHY_WAITING" }
  else { $status = "CURRENT" }
  $health = [ordered]@{
    owner = "DESKTOP"
    desktopPid = if ($runnerAlive) { $runner.Id } else { $null }
    latestPid = if ($null -ne $latestRunner -and -not $latestRunner.HasExited) { $latestRunner.Id } else { $null }
    supervisorPid = $PID
    lastHeartbeat = [DateTime]::UtcNow.ToString("o")
    lastCheckpoint = $checkpoint.updatedAt
    coverage = $checkpoint.coverage
    currentStage = $checkpoint.currentLayer
    currentScope = if ($checkpoint.nextCountry) { "$($checkpoint.currentCountry) -> $($checkpoint.nextCountry)" } else { $checkpoint.currentCountry }
    latestPath = $true
    incremental = $true
    scheduler = "ACTIVE_FREQUENCY_AWARE"
    autoContinuing = $true
    failureIsolation = $true
    idleStateSupported = $true
    processAlive = $runnerAlive
    status = $status
  }
  $tempPath = "$healthPath.$PID.tmp"
  $healthJson = $health | ConvertTo-Json -Depth 5
  [IO.File]::WriteAllText($tempPath, $healthJson, [Text.UTF8Encoding]::new($false))
  Move-Item -LiteralPath $tempPath -Destination $healthPath -Force
}

while (-not (Test-Path -LiteralPath $stopPath)) {
  $runner = Start-Process -FilePath "node" `
    -ArgumentList @("--experimental-strip-types", "--env-file=.env", $runnerPath, "--standalone") `
    -WorkingDirectory $projectRoot `
    -RedirectStandardOutput $stdoutPath `
    -RedirectStandardError $stderrPath `
    -WindowStyle Hidden `
    -PassThru

  $latestRunner = $null
  $nextLatestRun = [DateTime]::UtcNow
  while (-not $runner.HasExited -and -not (Test-Path -LiteralPath $stopPath)) {
    if ([DateTime]::UtcNow -ge $nextLatestRun -and ($null -eq $latestRunner -or $latestRunner.HasExited)) {
      $latestRunner = Start-Process -FilePath "node" `
        -ArgumentList @("--experimental-strip-types", "--env-file=.env", $latestRunnerPath) `
        -WorkingDirectory $projectRoot `
        -RedirectStandardOutput $latestStdoutPath `
        -RedirectStandardError $latestStderrPath `
        -WindowStyle Hidden `
        -PassThru
      $nextLatestRun = [DateTime]::UtcNow.AddMinutes(15)
    }
    Write-Health $runner $latestRunner "CURRENT"
    Start-Sleep -Seconds $HeartbeatSeconds
    $runner.Refresh()
  }

  if (Test-Path -LiteralPath $stopPath) { break }
  Write-Health $runner $latestRunner "RESTARTING_COMPLETION_RUNNER"
  Start-Sleep -Seconds 10
}

Write-Health $runner $latestRunner "STOPPED"
