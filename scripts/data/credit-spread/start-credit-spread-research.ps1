$ErrorActionPreference='Stop'
$root=(Resolve-Path (Join-Path $PSScriptRoot '..\..\..')).Path
$runtime=Join-Path $root 'runtime\credit-spread'
New-Item -ItemType Directory -Force -Path $runtime|Out-Null
$info=[System.Diagnostics.ProcessStartInfo]::new()
$info.FileName=(Get-Command node -ErrorAction Stop).Source
$info.WorkingDirectory=$root
$info.UseShellExecute=$false
$info.CreateNoWindow=$true
$info.Arguments='--experimental-strip-types scripts/data/credit-spread/run-credit-spread-research.ts --watch'
$process=[System.Diagnostics.Process]::new();$process.StartInfo=$info
if(-not $process.Start()){throw 'Failed to start credit-spread research worker.'}
$process.Id|Set-Content -LiteralPath (Join-Path $runtime 'research.pid')
$process.Id
