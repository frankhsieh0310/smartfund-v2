param([switch]$Force)
$ErrorActionPreference = 'Stop'
$root = (Resolve-Path (Join-Path $PSScriptRoot '..\..\..')).Path
$runtime = Join-Path $root 'runtime\index-constituents'
$pidFile = Join-Path $runtime 'runner.pid'
$errorFile = Join-Path $runtime 'runner.error.log'
New-Item -ItemType Directory -Path $runtime -Force | Out-Null
if ((Test-Path $pidFile) -and -not $Force) {
  $existingPid = [int](Get-Content -LiteralPath $pidFile -Raw).Trim()
  if (Get-Process -Id $existingPid -ErrorAction SilentlyContinue) {
    Write-Output $existingPid
    exit 0
  }
}
$runner = Join-Path $PSScriptRoot 'run-global-index-constituents.ts'
$node = (Get-Command node -ErrorAction Stop).Source
$startInfo = [System.Diagnostics.ProcessStartInfo]::new()
$startInfo.FileName = $node
$startInfo.Arguments = '--import tsx --env-file=.env "' + $runner + '"'
$startInfo.WorkingDirectory = $root
$startInfo.UseShellExecute = $true
$startInfo.CreateNoWindow = $true
$startInfo.WindowStyle = [System.Diagnostics.ProcessWindowStyle]::Hidden
$process = [System.Diagnostics.Process]::Start($startInfo)
Set-Content -LiteralPath $pidFile -Value $process.Id -Encoding ascii
Start-Sleep -Milliseconds 800
if (-not (Get-Process -Id $process.Id -ErrorAction SilentlyContinue)) { throw "Index constituents runner exited; inspect $errorFile" }
Write-Output $process.Id
