$ErrorActionPreference = 'Stop'
$repo = (Resolve-Path (Join-Path $PSScriptRoot '..\..\..')).Path
$runtime = Join-Path $repo 'runtime\nasdaq-latest'
$pidFile = Join-Path $runtime 'runner.pid'
New-Item -ItemType Directory -Force -Path $runtime | Out-Null
if (Test-Path -LiteralPath $pidFile) {
  $oldPid = [int](Get-Content -LiteralPath $pidFile | Select-Object -First 1)
  if (Get-Process -Id $oldPid -ErrorAction SilentlyContinue) { Write-Output $oldPid; exit 0 }
}
$scheduler = Join-Path $repo 'scripts\data\daily\run-nasdaq-latest-scheduler.ps1'
$process = Start-Process -FilePath 'powershell.exe' -ArgumentList @('-NoProfile','-ExecutionPolicy','Bypass','-File',$scheduler) -WorkingDirectory $repo -WindowStyle Hidden -PassThru
$process.Id | Set-Content -LiteralPath $pidFile -Encoding ascii
Write-Output $process.Id
