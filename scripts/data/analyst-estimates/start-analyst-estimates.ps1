$ErrorActionPreference = 'Stop'
$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot '..\..\..')).Path
$runtimeDir = Join-Path $repoRoot 'runtime\analyst-estimates'
$scriptPath = Join-Path $repoRoot 'scripts\data\analyst-estimates\run-global-analyst-estimates.ts'
$pidPath = Join-Path $runtimeDir 'runner.pid'
New-Item -ItemType Directory -Force -Path $runtimeDir | Out-Null
$existingPid = if (Test-Path $pidPath) { Get-Content $pidPath -ErrorAction SilentlyContinue } else { $null }
if ($existingPid -and (Get-Process -Id $existingPid -ErrorAction SilentlyContinue)) {
  Write-Output $existingPid
  exit 0
}
$nodePath = (Get-Command node -ErrorAction Stop).Source
$startInfo = [System.Diagnostics.ProcessStartInfo]::new()
$startInfo.FileName = $nodePath
$startInfo.Arguments = '"' + $scriptPath + '"'
$startInfo.WorkingDirectory = $repoRoot
$startInfo.UseShellExecute = $true
$startInfo.WindowStyle = [System.Diagnostics.ProcessWindowStyle]::Hidden
$process = [System.Diagnostics.Process]::Start($startInfo)
Set-Content -Path $pidPath -Value $process.Id
Write-Output $process.Id
