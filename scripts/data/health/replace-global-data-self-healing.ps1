$ErrorActionPreference = 'Stop'
$projectRoot = (Resolve-Path (Join-Path $PSScriptRoot '..\..\..')).Path
$statusPath = Join-Path $projectRoot 'runtime-status\global-data-self-healing.json'
$backupPath = Join-Path $projectRoot 'runtime-status\global-data-self-healing.lifecycle-backup.json'
$status = Get-Content -Raw -LiteralPath $statusPath | ConvertFrom-Json
$oldPid = [int]$status.PID
if (-not (Get-Process -Id $oldPid -ErrorAction SilentlyContinue)) { throw "SELF_HEALING_OWNER_NOT_ALIVE:$oldPid" }
if ([int]$status.ACTIONS_ATTEMPTED -ne ([int]$status.ACTIONS_SUCCEEDED + [int]$status.ACTIONS_FAILED)) { throw 'SELF_HEALING_ACTION_IN_FLIGHT' }
Copy-Item -LiteralPath $statusPath -Destination $backupPath -Force
Stop-Process -Id $oldPid
$deadline = [DateTime]::UtcNow.AddSeconds(20)
while ((Get-Process -Id $oldPid -ErrorAction SilentlyContinue) -and [DateTime]::UtcNow -lt $deadline) { Start-Sleep -Milliseconds 250 }
if (Get-Process -Id $oldPid -ErrorAction SilentlyContinue) { throw "SELF_HEALING_GRACEFUL_STOP_TIMEOUT:$oldPid" }
$launch = & (Join-Path $PSScriptRoot 'start-global-data-self-healing.ps1') | ConvertFrom-Json
[ordered]@{ pidBefore=$oldPid; gracefulStop=$true; duplicateOwnerCheck=$true; stateBackup=$backupPath; pidAfter=$launch.pid; launchedAt=$launch.launchedAt } | ConvertTo-Json
