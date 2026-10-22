$ErrorActionPreference = 'Stop'
$repo = (Resolve-Path (Join-Path $PSScriptRoot '..\..\..')).Path
$runtime = Join-Path $repo 'runtime\global-etf-depth-orchestrator'
$lock = Join-Path $runtime 'single-writer.lock'
New-Item -ItemType Directory -Force -Path $runtime | Out-Null
if (Test-Path -LiteralPath $lock) {
  $owner = Get-Content -Raw -LiteralPath $lock | ConvertFrom-Json
  if ($owner.pid -and (Get-Process -Id ([int]$owner.pid) -ErrorAction SilentlyContinue)) { Write-Output $owner.pid; exit 0 }
}
$supervisor = Join-Path $repo 'scripts\data\orchestrator\run-global-etf-depth-supervisor.ps1'
$processInfo = [System.Diagnostics.ProcessStartInfo]::new()
$processInfo.FileName = 'powershell.exe'
$processInfo.WorkingDirectory = $repo
$processInfo.UseShellExecute = $true
$processInfo.CreateNoWindow = $true
$processInfo.Arguments = "-NoProfile -ExecutionPolicy Bypass -File `"$supervisor`""
$process = [System.Diagnostics.Process]::Start($processInfo)
Write-Output $process.Id
