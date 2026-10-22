$ErrorActionPreference = 'Stop'
$repo = (Resolve-Path (Join-Path $PSScriptRoot '..\..\..')).Path
$runtime = Join-Path $repo 'runtime\global-etf'
$pidFile = Join-Path $runtime 'supervisor.pid'
New-Item -ItemType Directory -Force -Path $runtime | Out-Null
if (Test-Path -LiteralPath $pidFile) {
  $oldPid = [int](Get-Content -LiteralPath $pidFile | Select-Object -First 1)
  if (Get-Process -Id $oldPid -ErrorAction SilentlyContinue) { Write-Output $oldPid; exit 0 }
}
$supervisor = Join-Path $repo 'scripts\data\global-etf\run-global-etf-supervisor.ps1'
$process = Start-Process -FilePath 'powershell.exe' -ArgumentList @('-NoProfile','-ExecutionPolicy','Bypass','-File',$supervisor) -WorkingDirectory $repo -WindowStyle Hidden -PassThru
$process.Id | Set-Content -LiteralPath $pidFile -Encoding ascii
Write-Output $process.Id
