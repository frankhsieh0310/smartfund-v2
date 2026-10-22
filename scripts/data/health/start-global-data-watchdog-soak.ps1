$ErrorActionPreference = 'Stop'
$projectRoot = (Resolve-Path (Join-Path $PSScriptRoot '..\..\..')).Path
$runtimeRoot = Join-Path $projectRoot 'runtime-status'
$statusPath = Join-Path $runtimeRoot 'global-data-watchdog.json'
$stdoutPath = Join-Path $runtimeRoot 'global-data-watchdog-soak.log'
$stderrPath = Join-Path $runtimeRoot 'global-data-watchdog-soak.error.log'

New-Item -ItemType Directory -Force -Path $runtimeRoot | Out-Null
if (Test-Path -LiteralPath $statusPath) {
  $prior = Get-Content -Raw -LiteralPath $statusPath | ConvertFrom-Json
  if ($prior.STATE -in @('RUNNING', 'SCHEDULED_WAIT') -and $prior.WATCHDOG_PID) {
    $live = Get-Process -Id ([int]$prior.WATCHDOG_PID) -ErrorAction SilentlyContinue
    if ($live) {
      [ordered]@{ reused = $true; pid = $live.Id; state = $prior.STATE; invocationId = $prior.INVOCATION_ID } | ConvertTo-Json
      exit 0
    }
  }
}

$node = (Get-Command node -ErrorAction Stop).Source
$arguments = @(
  '--experimental-strip-types',
  '--env-file=.env',
  'scripts/data/health/run-global-data-watchdog.ts',
  '--daemon',
  '--interval-ms=1800000',
  '--duration-hours=24'
)
$process = Start-Process -FilePath $node -ArgumentList $arguments -WorkingDirectory $projectRoot -RedirectStandardOutput $stdoutPath -RedirectStandardError $stderrPath -WindowStyle Hidden -PassThru
if (-not $process) { throw 'Failed to start global data watchdog soak' }
[ordered]@{ reused = $false; pid = $process.Id; launchedAt = [DateTime]::UtcNow.ToString('o'); cadenceMinutes = 30; targetHours = 24; stdout = $stdoutPath; stderr = $stderrPath } | ConvertTo-Json
