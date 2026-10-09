$ErrorActionPreference = 'Stop'
$projectRoot = Resolve-Path (Join-Path $PSScriptRoot '../../..')
$runtimeDir = Join-Path $projectRoot 'runtime/equity-index-futures'
$logDir = Join-Path $runtimeDir 'logs'
New-Item -ItemType Directory -Force -Path $logDir | Out-Null
$runner = Join-Path $PSScriptRoot 'run-global-equity-index-futures.ts'
$startInfo = [System.Diagnostics.ProcessStartInfo]::new()
$startInfo.FileName = 'node'
$startInfo.WorkingDirectory = $projectRoot
$startInfo.UseShellExecute = $false
$startInfo.CreateNoWindow = $true
$startInfo.RedirectStandardOutput = $true
$startInfo.RedirectStandardError = $true
$startInfo.Arguments = '"' + $runner + '"'
$process = [System.Diagnostics.Process]::Start($startInfo)
$process.Id
