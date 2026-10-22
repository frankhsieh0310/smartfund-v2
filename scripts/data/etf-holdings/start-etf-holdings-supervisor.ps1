$ErrorActionPreference = 'Stop'
$repo = (Resolve-Path (Join-Path $PSScriptRoot '..\..\..')).Path
$runtime = Join-Path $repo 'runtime\etf-holdings'
$pidFile = Join-Path $runtime 'supervisor.pid'
New-Item -ItemType Directory -Force -Path $runtime | Out-Null
if (Test-Path -LiteralPath $pidFile) {
  $existingPid = [int](Get-Content -LiteralPath $pidFile -Raw)
  $existing = Get-Process -Id $existingPid -ErrorAction SilentlyContinue
  if ($existing -and $existing.ProcessName -eq 'node') { Write-Output $existingPid; exit 0 }
}
Remove-Item -LiteralPath (Join-Path $runtime 'supervisor.lock') -Force -ErrorAction SilentlyContinue
$node = (Get-Command node -ErrorAction Stop).Source
$script = Join-Path $repo 'scripts\data\etf-holdings\run-etf-holdings-supervisor.ts'
$nodePath = $env:Path
[Environment]::SetEnvironmentVariable('PATH', $null, 'Process')
[Environment]::SetEnvironmentVariable('Path', $nodePath, 'Process')
$process = Start-Process -FilePath $node -ArgumentList @('--experimental-strip-types',$script) -WorkingDirectory $repo -WindowStyle Hidden -PassThru
Set-Content -LiteralPath $pidFile -Value $process.Id -Encoding ascii
Start-Sleep -Seconds 2
if (-not (Get-Process -Id $process.Id -ErrorAction SilentlyContinue)) { throw 'ETF Holdings supervisor exited during startup' }
Write-Output $process.Id
