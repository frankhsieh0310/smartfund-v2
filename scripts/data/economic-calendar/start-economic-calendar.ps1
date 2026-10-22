$ErrorActionPreference = 'Stop'
$root = Resolve-Path (Join-Path $PSScriptRoot '../../..')
$runtime = Join-Path $root 'runtime/economic-calendar'
$pidFile = Join-Path $runtime 'economic-calendar.pid'
$stdout = Join-Path $runtime 'standalone.stdout.log'
$stderr = Join-Path $runtime 'standalone.stderr.log'
New-Item -ItemType Directory -Force -Path $runtime | Out-Null
if (Test-Path $pidFile) {
  $existingPid = [int](Get-Content $pidFile -Raw)
  if (Get-Process -Id $existingPid -ErrorAction SilentlyContinue) { Write-Output $existingPid; exit 0 }
}
$runner = Join-Path $PSScriptRoot 'run-economic-calendar.ts'
$node = (Get-Command node -ErrorAction Stop).Source
$startInfo = [System.Diagnostics.ProcessStartInfo]::new()
$startInfo.FileName = $node
$startInfo.Arguments = '--experimental-strip-types --env-file=.env "' + $runner + '"'
$startInfo.WorkingDirectory = $root
$startInfo.UseShellExecute = $false
$startInfo.CreateNoWindow = $true
$process = [System.Diagnostics.Process]::new()
$process.StartInfo = $startInfo
if (-not $process.Start()) { throw 'Unable to start economic calendar runner' }
$process.Id | Set-Content -Path $pidFile -NoNewline
Start-Sleep -Milliseconds 750
if (-not (Get-Process -Id $process.Id -ErrorAction SilentlyContinue)) { throw "Economic calendar runner failed to start; see $stderr" }
Write-Output $process.Id
