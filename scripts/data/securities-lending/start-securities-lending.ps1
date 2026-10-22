param([switch]$Once)
$ErrorActionPreference = 'Stop'
$ProjectRoot = (Resolve-Path (Join-Path $PSScriptRoot '..\..\..')).Path
$RuntimePath = Join-Path $ProjectRoot 'runtime\securities-lending'
New-Item -ItemType Directory -Force -Path $RuntimePath | Out-Null
$PidPath = Join-Path $RuntimePath 'runner.pid'
if (Test-Path -LiteralPath $PidPath) {
  $ExistingPid = [int](Get-Content -LiteralPath $PidPath -Raw)
  $ExistingOwner = Get-CimInstance Win32_Process -Filter "ProcessId=$ExistingPid" -ErrorAction SilentlyContinue
  if ($ExistingOwner -and $ExistingOwner.CommandLine -like '*run-global-securities-lending.ts*') {
    Write-Output $ExistingPid
    exit 0
  }
}
$RunnerPath = Join-Path $PSScriptRoot 'run-global-securities-lending.ts'
$Arguments = @('--env-file=.env', $RunnerPath)
if ($Once) { $Arguments += '--once' }
$StdoutPath = Join-Path $RuntimePath 'runner.stdout.log'
$StderrPath = Join-Path $RuntimePath 'runner.stderr.log'
$Process = Start-Process -FilePath 'node' -ArgumentList $Arguments -WorkingDirectory $ProjectRoot -WindowStyle Hidden -RedirectStandardOutput $StdoutPath -RedirectStandardError $StderrPath -PassThru
$Process.Id | Set-Content -LiteralPath $PidPath -Encoding ascii
Write-Output $Process.Id
