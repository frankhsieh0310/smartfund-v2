$ErrorActionPreference = 'Stop'
$projectRoot = (Resolve-Path (Join-Path $PSScriptRoot '..\..\..')).Path
$runtime = Join-Path $projectRoot 'runtime\commodity-futures'
New-Item -ItemType Directory -Force -Path $runtime, (Join-Path $runtime 'archive') | Out-Null
$stdout = Join-Path $runtime 'standalone.stdout.log'
$stderr = Join-Path $runtime 'standalone.stderr.log'
$runner = Join-Path $PSScriptRoot 'run-global-commodity-futures.ts'
$node = (Get-Command node -ErrorAction Stop).Source
$startInfo = [System.Diagnostics.ProcessStartInfo]::new()
$startInfo.FileName = $node
$startInfo.WorkingDirectory = $projectRoot
$startInfo.UseShellExecute = $true
$startInfo.CreateNoWindow = $true
$startInfo.Arguments = "--env-file=.env --experimental-strip-types `"$runner`""
$process = [System.Diagnostics.Process]::new()
$process.StartInfo = $startInfo
$process.Start() | Out-Null
$process.Id | Set-Content -Path (Join-Path $runtime 'commodity-futures.pid')
$process.Id
