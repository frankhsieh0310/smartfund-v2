$ErrorActionPreference = 'Stop'
$root = Resolve-Path (Join-Path $PSScriptRoot '../../..')
$runtime = Join-Path $root 'runtime/economic-calendar/p0-recovery'
$pidFile = Join-Path $runtime 'p0-recovery.pid'
New-Item -ItemType Directory -Force -Path $runtime | Out-Null
if (Test-Path $pidFile) {
  $pidContent = Get-Content $pidFile -Raw
  $rawPid = if ($null -eq $pidContent) { '' } else { $pidContent.Trim() }
  if ($rawPid) {
    $existingPid = [int]$rawPid
    if (Get-Process -Id $existingPid -ErrorAction SilentlyContinue) { Write-Output $existingPid; exit 0 }
  }
}
$runner = Join-Path $PSScriptRoot 'run-economic-calendar-p0.ts'
$node = (Get-Command node -ErrorAction Stop).Source
$startInfo = [System.Diagnostics.ProcessStartInfo]::new()
$startInfo.FileName = $node
$startInfo.Arguments = '--env-file=.env "' + $runner + '"'
$startInfo.WorkingDirectory = $root
$startInfo.UseShellExecute = $false
$startInfo.CreateNoWindow = $true
$process = [System.Diagnostics.Process]::new()
$process.StartInfo = $startInfo
if (-not $process.Start()) { throw 'Unable to start economic calendar P0 runner' }
$process.Id | Set-Content -Path $pidFile -NoNewline
Start-Sleep -Milliseconds 1000
if (-not (Get-Process -Id $process.Id -ErrorAction SilentlyContinue)) { throw 'Economic calendar P0 runner failed to start' }
Write-Output $process.Id
