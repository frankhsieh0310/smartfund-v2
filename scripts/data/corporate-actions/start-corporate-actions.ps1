param([switch]$Handoff)
$ErrorActionPreference = 'Stop'
$root = (Resolve-Path (Join-Path $PSScriptRoot '..\..\..')).Path
$runtime = Join-Path $root 'runtime\corporate-actions'
$pidFile = Join-Path $runtime 'runner.pid'
New-Item -ItemType Directory -Force -Path $runtime | Out-Null

if (Test-Path $pidFile) {
  $existingPid = [int](Get-Content $pidFile -Raw)
  if (Get-Process -Id $existingPid -ErrorAction SilentlyContinue) {
    if (-not $Handoff) { Write-Output $existingPid; exit 0 }
    Stop-Process -Id $existingPid -ErrorAction Stop
    Wait-Process -Id $existingPid -Timeout 15 -ErrorAction SilentlyContinue
  }
}

$runner = Join-Path $root 'scripts\data\corporate-actions\run-global-corporate-actions.ts'
$node = (Get-Command node -ErrorAction Stop).Source
$startInfo = [System.Diagnostics.ProcessStartInfo]::new()
$startInfo.FileName = $node
$startInfo.Arguments = '--experimental-strip-types --env-file=.env "{0}"' -f $runner
$startInfo.WorkingDirectory = $root
$startInfo.UseShellExecute = $true
$startInfo.WindowStyle = [System.Diagnostics.ProcessWindowStyle]::Hidden
$process = [System.Diagnostics.Process]::Start($startInfo)
if (-not $process) { throw 'Unable to start runner' }
Set-Content -Path $pidFile -Value $process.Id -NoNewline
Write-Output $process.Id
