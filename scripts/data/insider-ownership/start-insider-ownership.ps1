$ErrorActionPreference = 'Stop'
$projectRoot = (Resolve-Path (Join-Path $PSScriptRoot '..\..\..')).Path
$runtimePath = Join-Path $projectRoot 'runtime\insider-ownership'
$runnerPath = Join-Path $PSScriptRoot 'run-global-insider-ownership.ts'
New-Item -ItemType Directory -Force -Path $runtimePath | Out-Null
$startInfo = [System.Diagnostics.ProcessStartInfo]::new()
$startInfo.FileName = 'node'
$startInfo.Arguments = '"' + $runnerPath.Replace('"', '\"') + '"'
$startInfo.WorkingDirectory = $projectRoot
$startInfo.UseShellExecute = $false
$startInfo.CreateNoWindow = $true
$startInfo.RedirectStandardOutput = $true
$startInfo.RedirectStandardError = $true
$process = [System.Diagnostics.Process]::new()
$process.StartInfo = $startInfo
if (-not $process.Start()) { throw 'Unable to start insider ownership runner.' }
@{ asset = 'GLOBAL_INSIDER_OWNERSHIP'; pid = $process.Id; startedAt = (Get-Date).ToUniversalTime().ToString('o') } | ConvertTo-Json | Set-Content -Encoding utf8 (Join-Path $runtimePath 'launcher.json')
Write-Output $process.Id
