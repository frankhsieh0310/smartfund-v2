$ErrorActionPreference = 'Stop'
$workspace = (Resolve-Path (Join-Path $PSScriptRoot '..\..\..')).Path
$heartbeatPath = Join-Path $workspace 'runtime\index\heartbeat.json'
$heartbeat = Get-Content -LiteralPath $heartbeatPath -Raw | ConvertFrom-Json
if ($heartbeat.asset -ne 'GLOBAL_INDEX' -or $heartbeat.script -ne 'scripts/data/index/run-global-index.ts') {
  throw 'REFUSE_RESTART_UNVERIFIED_OWNER'
}
$oldPid = [int]$heartbeat.pid
$process = Get-Process -Id $oldPid -ErrorAction SilentlyContinue
if ($null -ne $process) {
  Stop-Process -Id $oldPid
  $process.WaitForExit(10000)
}
$node = (Get-Command node).Source
$arguments = @('--experimental-strip-types', '--env-file=.env', 'scripts/data/index/run-global-index.ts')
$replacement = Start-Process -FilePath $node -ArgumentList $arguments -WorkingDirectory $workspace -WindowStyle Hidden -PassThru
[pscustomobject]@{ oldPid = $oldPid; newPid = $replacement.Id; checkpointPreserved = $true } | ConvertTo-Json -Compress
