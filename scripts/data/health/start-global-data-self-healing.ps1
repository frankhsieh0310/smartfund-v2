$ErrorActionPreference = 'Stop'
$projectRoot = (Resolve-Path (Join-Path $PSScriptRoot '..\..\..')).Path
$runtimeRoot = Join-Path $projectRoot 'runtime-status'
$statusPath = Join-Path $runtimeRoot 'global-data-self-healing.json'
$stdoutPath = Join-Path $runtimeRoot 'global-data-self-healing.log'
$stderrPath = Join-Path $runtimeRoot 'global-data-self-healing.error.log'

New-Item -ItemType Directory -Force -Path $runtimeRoot | Out-Null
if (Test-Path -LiteralPath $statusPath) {
  $prior = Get-Content -Raw -LiteralPath $statusPath | ConvertFrom-Json
  if ($prior.STATE -in @('RUNNING', 'SCHEDULED_WAIT') -and $prior.PID) {
    $existing = Get-Process -Id ([int]$prior.PID) -ErrorAction SilentlyContinue
    if ($existing) {
      [ordered]@{ reused = $true; pid = $existing.Id; state = $prior.STATE; invocationId = $prior.INVOCATION_ID } | ConvertTo-Json
      exit 0
    }
  }
}

$node = (Get-Command node -ErrorAction Stop).Source
$arguments = @('--experimental-strip-types', '--env-file=.env', 'scripts/data/health/run-global-data-self-healing.ts', '--live', '--daemon')
$process = Start-Process -FilePath $node -ArgumentList $arguments -WorkingDirectory $projectRoot -RedirectStandardOutput $stdoutPath -RedirectStandardError $stderrPath -WindowStyle Hidden -PassThru
if (-not $process) { throw 'Failed to start global data self-healing engine' }
[ordered]@{ reused = $false; pid = $process.Id; launchedAt = [DateTime]::UtcNow.ToString('o'); cadenceMinutes = 30; mode = 'LIVE_FAIL_CLOSED'; stdout = $stdoutPath; stderr = $stderrPath } | ConvertTo-Json
