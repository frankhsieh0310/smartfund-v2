$ErrorActionPreference = 'Stop'
$projectRoot = Resolve-Path (Join-Path $PSScriptRoot '../../..')
$runtime = Join-Path $projectRoot 'runtime/insider'
$runner = Join-Path $PSScriptRoot 'run-global-insider.ts'
$pidFile = Join-Path $runtime 'runner.pid'
New-Item -ItemType Directory -Path $runtime -Force | Out-Null
if (Test-Path -LiteralPath $pidFile) {
  $existingPid = [int](Get-Content -LiteralPath $pidFile -Raw)
  if (Get-Process -Id $existingPid -ErrorAction SilentlyContinue) { Write-Output $existingPid; exit 0 }
}
$startInfo = [System.Diagnostics.ProcessStartInfo]::new()
$startInfo.FileName = 'node'
$startInfo.Arguments = '--env-file=.env --experimental-strip-types "' + $runner + '" --bounded=10 --incremental'
$startInfo.WorkingDirectory = $projectRoot
$startInfo.UseShellExecute = $true
$startInfo.WindowStyle = [System.Diagnostics.ProcessWindowStyle]::Hidden
$process = [System.Diagnostics.Process]::Start($startInfo)
Set-Content -LiteralPath $pidFile -Value $process.Id
Write-Output $process.Id
