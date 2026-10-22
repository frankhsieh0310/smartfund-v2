$ErrorActionPreference = 'Stop'
$projectRoot = (Resolve-Path (Join-Path $PSScriptRoot '..\..\..')).Path
$runtime = Join-Path $projectRoot 'runtime\electricity-markets'
New-Item -ItemType Directory -Force -Path $runtime, (Join-Path $runtime 'archive') | Out-Null
$runner = Join-Path $PSScriptRoot 'run-global-electricity-markets.ts'
$node = (Get-Command node -ErrorAction Stop).Source
$startInfo = [System.Diagnostics.ProcessStartInfo]::new()
$startInfo.FileName = $node
$startInfo.WorkingDirectory = $projectRoot
$startInfo.UseShellExecute = $true
$startInfo.CreateNoWindow = $true
$startInfo.WindowStyle = [System.Diagnostics.ProcessWindowStyle]::Hidden
$startInfo.Arguments = "`"$runner`""
$process = [System.Diagnostics.Process]::new()
$process.StartInfo = $startInfo
$process.Start() | Out-Null
$process.Id | Set-Content -LiteralPath (Join-Path $runtime 'electricity-markets.pid')
$process.Id
